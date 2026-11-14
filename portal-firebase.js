import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  browserLocalPersistence, browserSessionPersistence, confirmPasswordReset, createUserWithEmailAndPassword, EmailAuthProvider, getAuth,
  initializeAuth, inMemoryPersistence, reauthenticateWithCredential, sendPasswordResetEmail, setPersistence,
  signInWithEmailAndPassword, signOut, updatePassword, verifyPasswordResetCode,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  collection, collectionGroup, doc, getDocFromServer, getFirestore, onSnapshot, query,
  runTransaction, serverTimestamp, updateDoc, where, writeBatch,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-web-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const ready = setPersistence(auth, window.Capacitor?.isNativePlatform()
  ? browserLocalPersistence : browserSessionPersistence);
let setupAuth;

const workerEmail = (dni) => `${dni}@personal.asistencia-faroni.web.app`;
const dayKey = (date) => String(Date.parse(`${date}T00:00:00Z`) / 86400000);
const attendance = (uid, date) => doc(db, 'attendance', dayKey(date), 'records', uid);

async function accountFor(user) {
  if (!user) return null;
  const profile = (await getDocFromServer(doc(db, 'profiles', user.uid))).data();
  if (!profile || !['worker', 'employer'].includes(profile.role) || typeof profile.name !== 'string') {
    await signOut(auth);
    return null;
  }
  if (profile.role === 'worker' && (profile.archivedAt || profile.disabled)) {
    await signOut(auth);
    throw Object.assign(new Error('Acceso suspendido.'), { code: 'portal/worker-inactive' });
  }
  if (profile.role === 'worker' && profile.accessResetAfter) {
    const { authTime } = await user.getIdTokenResult();
    if (Date.parse(authTime) < profile.accessResetAfter * 1000) {
      await signOut(auth);
      return null;
    }
  }
  const dni = profile.dni ?? (/^([0-9]{7,8})@personal\.asistencia-faroni\.web\.app$/.exec(user.email ?? '')?.[1]);
  return { username: user.uid, name: profile.name, role: profile.role, dni,
    mustChangePassword: profile.role === 'worker' && profile.mustChangePassword === true };
}

export async function finishFirstAccess(uid, password, initialPassword) {
  const user = auth.currentUser;
  if (user?.uid !== uid || !user.email) {
    throw Object.assign(new Error('La sesión cambió.'), { code: 'auth/requires-recent-login' });
  }
  const ref = doc(db, 'profiles', uid);
  const profile = (await getDocFromServer(ref)).data();
  if (!profile || profile.archivedAt || profile.disabled || profile.role !== 'worker') return accountFor(user);
  if (!profile.mustChangePassword) return accountFor(user);
  if (password === initialPassword) throw Object.assign(new Error('Clave inicial repetida.'), { code: 'portal/same-password' });
  if (!initialPassword) throw Object.assign(new Error('Volvé a ingresar.'), { code: 'auth/requires-recent-login' });
  try {
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, initialPassword));
    await updatePassword(user, password);
  } catch (error) {
    // A previous attempt may have changed the password before the profile write failed.
    if (!['auth/invalid-credential', 'auth/wrong-password', 'auth/invalid-login-credentials'].includes(error.code)) throw error;
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
  }
  await updateDoc(ref, { mustChangePassword: false });
  return accountFor(auth.currentUser);
}

export async function changePassword(uid, current, next) {
  const user = auth.currentUser;
  if (user?.uid !== uid || !user?.email) {
    throw Object.assign(new Error('La sesión cambió.'), { code: 'auth/requires-recent-login' });
  }
  const profile = (await getDocFromServer(doc(db, 'profiles', uid))).data();
  if (profile?.role !== 'worker' || profile.disabled || profile.archivedAt || profile.mustChangePassword) {
    throw Object.assign(new Error('Acceso no habilitado.'), { code: 'portal/worker-inactive' });
  }
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, current));
  if (auth.currentUser !== user) {
    throw Object.assign(new Error('La sesión cambió.'), { code: 'auth/requires-recent-login' });
  }
  await updatePassword(user, next);
}

export async function resume() {
  await ready;
  await auth.authStateReady();
  return accountFor(auth.currentUser);
}

export async function login(identifier, password) {
  await ready;
  const dni = identifier.replaceAll('.', '');
  const email = /^[0-9]{7,8}$/.test(dni) ? workerEmail(dni) : identifier;
  const { user } = await signInWithEmailAndPassword(auth, email, password);
  return accountFor(user);
}

export function logout() {
  return signOut(auth);
}

export function recoverEmployer(email) {
  auth.languageCode = 'es';
  return sendPasswordResetEmail(auth, email);
}

export async function activateAccess(dni, code, next) {
  const email = await verifyPasswordResetCode(auth, code);
  if (email.toLowerCase() !== workerEmail(dni)) return false;
  await confirmPasswordReset(auth, code, next);
  // A private recovery link also satisfies the initial password change.
  try {
    const { user } = await signInWithEmailAndPassword(auth, email, next);
    const profile = (await getDocFromServer(doc(db, 'profiles', user.uid))).data();
    if (profile?.role === 'worker' && profile.mustChangePassword && !profile.disabled && !profile.archivedAt) {
      await updateDoc(doc(db, 'profiles', user.uid), { mustChangePassword: false });
    }
  } catch {
    // Password reset has already succeeded. First access will retry if necessary.
  } finally {
    await signOut(auth).catch(() => {});
  }
  return true;
}

const resetRef = (uid) => doc(db, 'accessResets', uid);

export async function requestAccessReset(uid, requestId, publicKey) {
  const employerUid = auth.currentUser?.uid;
  if (!employerUid) throw new Error('La sesión venció.');
  return runTransaction(db, async (transaction) => {
    const ref = resetRef(uid);
    const existing = (await transaction.get(ref)).data();
    if (existing?.status === 'processing' ||
      (existing?.status === 'pending' && Date.now() - existing.requestedAt.toMillis() < 300000)) return false;
    transaction.set(ref, { status: 'pending', employerUid, requestId, publicKey, requestedAt: serverTimestamp() });
    return true;
  });
}

export function watchAccessReset(uid, onUpdate, onError) {
  return onSnapshot(resetRef(uid), { includeMetadataChanges: true }, (snapshot) => {
    if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) onUpdate(snapshot.data());
  }, onError);
}

export async function createWorker(draft) {
  setupAuth ??= initializeAuth(initializeApp(firebaseConfig, 'employee-setup'), { persistence: inMemoryPersistence });
  try {
    if (!draft.uid) {
      const email = workerEmail(draft.dni);
      let credentials;
      try {
        credentials = await createUserWithEmailAndPassword(setupAuth, email, draft.password);
      } catch (error) {
        if (error.code === 'auth/email-already-in-use' && draft.uncertain) {
          try {
            credentials = await signInWithEmailAndPassword(setupAuth, email, draft.password);
          } catch (signInError) {
            if (['auth/invalid-credential', 'auth/wrong-password'].includes(signInError.code)) {
              draft.uncertain = false;
              throw error;
            }
            throw signInError;
          }
        } else {
          draft.uncertain = ['auth/network-request-failed', 'auth/internal-error'].includes(error.code);
          throw error;
        }
      }
      draft.uid = credentials.user.uid;
    }
    if (auth.currentUser?.uid !== draft.employer) throw new Error('La sesión cambió.');
    const ref = doc(db, 'profiles', draft.uid);
    const profile = { role: 'worker', dni: draft.dni, name: draft.name, createdOn: draft.createdOn, mustChangePassword: true };
    await runTransaction(db, async (transaction) => {
      const saved = (await transaction.get(ref)).data();
      if (!saved) transaction.set(ref, profile);
      else if (saved.role !== profile.role || saved.dni !== profile.dni || saved.name !== profile.name) {
        throw new Error('El perfil ya existe.');
      }
    });
    return { id: draft.uid, ...profile };
  } finally {
    if (setupAuth.currentUser) await signOut(setupAuth).catch(() => {});
  }
}

const entries = (snapshot) => snapshot.docs.map((item) => ({ ...item.data(), id: item.id }));

function marksFrom(data) {
  return [data, ...Object.values(data?.segments ?? {})].flatMap((item) => [['in', item?.entry], ['out', item?.exit]])
    .filter(([, time]) => time)
    .map(([type, time]) => ({ type, at: time.toDate().toISOString() }));
}

export function watchPortal(account, today, receive, onError) {
  const employer = account.role === 'employer';
  const uid = account.username;
  const stops = [];
  const watch = (target, kind, convert) => {
    stops.push(onSnapshot(target, { includeMetadataChanges: true }, (snapshot) => {
      if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) receive(kind, convert(snapshot));
    }, () => onError(kind)));
  };
  for (const name of ['network', 'location', 'schedule']) {
    watch(doc(db, 'portalSettings', name), name, (snapshot) => snapshot.data()?.value);
  }
  watch(employer ? collection(db, 'staffSchedules') : doc(db, 'staffSchedules', uid), 'staffSchedules',
    employer ? entries : (snapshot) => snapshot.exists() ? [{ ...snapshot.data(), id: uid }] : []);
  const corrections = collection(db, 'attendanceCorrections');
  watch(employer ? corrections : query(corrections, where('workerId', '==', uid)), 'corrections', entries);
  for (const [name, kind] of [[employer ? 'staffAbsences' : 'staffNoveltyAlerts', 'absences'], ['employeeAbsenceNotices', 'absenceNotices']]) {
    const notices = collection(db, name);
    watch(employer ? notices : query(notices, where('workerId', '==', uid)), kind, entries);
  }
  if (employer) {
    watch(collection(db, 'profiles'), 'staff', entries);
    watch(collection(db, 'staffRecoveryContacts'), 'staffRecoveryContacts', entries);
    watch(collection(db, 'plantClosures'), 'calendar', entries);
    watch(collectionGroup(db, 'records'), 'attendance', (snapshot) => snapshot.docs
      .filter((item) => item.ref.path.startsWith('attendance/'))
      .map((item) => ({ uid: item.id, marks: marksFrom(item.data()) })));
  } else {
    watch(doc(db, 'profiles', uid), 'workerProfile', (snapshot) => snapshot.data());
    watch(attendance(uid, today), 'today', (snapshot) => ({ day: today, marks: marksFrom(snapshot.data()) }));
  }
  return () => stops.forEach((stop) => stop());
}

export function archiveWorker(uid) {
  const ref = doc(db, 'profiles', uid);
  return runTransaction(db, async (transaction) => {
    const profile = (await transaction.get(ref)).data();
    if (profile?.role !== 'worker') throw new Error('No se encontró el perfil de empleado.');
    if (!profile.archivedAt) transaction.update(ref, { archivedAt: serverTimestamp() });
  });
}

export function setWorkerDisabled(uid, disabled) {
  const ref = doc(db, 'profiles', uid);
  return runTransaction(db, async (transaction) => {
    const profile = (await transaction.get(ref)).data();
    if (profile?.role !== 'worker' || profile.archivedAt) throw new Error('El perfil fue dado de baja.');
    transaction.update(ref, { disabled });
  });
}

export async function readDay(uid, day) {
  return marksFrom((await getDocFromServer(attendance(uid, day))).data());
}

export async function punch(uid, date, type) {
  return runTransaction(db, async (transaction) => {
    const ref = attendance(uid, date);
    const data = (await transaction.get(ref)).data();
    if (type === 'in' && !data) {
      transaction.set(ref, { entry: serverTimestamp() });
    } else if (data) {
      const count = data.extraCount ?? 0;
      const slot = 's' + count;
      const last = count ? data.segments[slot] : data;
      if (type === 'out' && last.entry && !last.exit) {
        transaction.update(ref, count ? { ['segments.' + slot + '.exit']: serverTimestamp() } : { exit: serverTimestamp() });
      } else if (type === 'in' && last.exit && count < 99) {
        transaction.update(ref, {
          extraCount: count + 1,
          ['segments.s' + (count + 1)]: { entry: serverTimestamp() },
        });
      } else return false;
    } else return false;
    return true;
  });
}

export function saveNovelties(workerId, dates, data) {
  const batch = writeBatch(db);
  for (const date of dates) {
    const id = workerId + '_' + date;
    batch.set(doc(db, 'staffAbsences', id), {
      ...data, workerId, date, updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'staffNoveltyAlerts', id), {
      workerId, date, reason: data.reason, updatedAt: serverTimestamp(),
      ...(data.fromTime ? { fromTime: data.fromTime, toTime: data.toTime } : {}),
    });
  }
  return batch.commit();
}

export async function sendAbsenceNotice(workerId, date, reason, note) {
  const ref = doc(db, 'employeeAbsenceNotices', workerId + '_' + date);
  return runTransaction(db, async (transaction) => {
    if ((await transaction.get(ref)).exists()) return false;
    transaction.set(ref, { workerId, date, reason, note, status: 'pending', createdAt: serverTimestamp() });
    return true;
  });
}

export function reviewAbsenceNotice(notice, status) {
  const id = notice.workerId + '_' + notice.date;
  const ref = doc(db, 'employeeAbsenceNotices', id);
  const novelty = doc(db, 'staffAbsences', id);
  return runTransaction(db, async (transaction) => {
    const current = (await transaction.get(ref)).data();
    if (current?.status !== 'pending') return 'reviewed';
    if (status === 'accepted' && !(await transaction.get(novelty)).exists()) {
      const { workerId, date, reason, note } = current;
      transaction.set(novelty, { workerId, date, reason, note, certificate: false, updatedAt: serverTimestamp() });
    }
    transaction.update(ref, { status, reviewedAt: serverTimestamp() });
    return 'saved';
  });
}

export function saveSetting(name, value) {
  return saveRecord('portalSettings', name, { value });
}

export function saveRecord(collectionName, id, value) {
  const ref = doc(db, collectionName, id);
  return runTransaction(db, async (transaction) => {
    if (value === null) transaction.delete(ref);
    else transaction.set(ref, value);
  });
}

export function saveWorkerSettings(uid, profile, email) {
  return runTransaction(db, async (transaction) => {
    transaction.set(doc(db, 'staffSchedules', uid), profile);
    transaction.set(doc(db, 'staffRecoveryContacts', uid), { email });
  });
}

export function addCorrection({ id, ...data }) {
  // A worker may only read documents that already belong to them.
  return saveRecord('attendanceCorrections', id, data);
}

export function reviewCorrection(id, review) {
  const ref = doc(db, 'attendanceCorrections', id);
  return runTransaction(db, async (transaction) => {
    const current = (await transaction.get(ref)).data();
    if (current?.status !== 'pending') return false;
    transaction.update(ref, review);
    return true;
  });
}

export function applyCorrection({ id, ...data }) {
  return runTransaction(db, async (transaction) => {
    const audit = doc(db, 'attendanceCorrections', id);
    const ref = attendance(data.workerId, data.date);
    const saved = (await transaction.get(audit)).data();
    const marks = (await transaction.get(ref)).data() ?? {};
    if (data.manual ? Boolean(saved) : saved?.status !== 'pending') return false;
    const field = data.type === 'in' ? 'entry' : 'exit';
    const segments = [[null, marks], ...Object.entries(marks.segments ?? {}).sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))];
    const index = data.previousAt
      ? segments.findIndex(([, item]) => item[field]?.toDate().toISOString() === data.previousAt)
      : field === 'entry' ? 0 : segments.length - 1;
    if (index < 0) return false;
    const [slot, segment] = segments[index];
    if (!data.previousAt && segment[field]) return false;
    const corrected = new Date(data.at);
    const before = (field === 'entry' ? segments[index - 1]?.[1].exit : segment.entry)?.toDate();
    const after = (field === 'entry' ? segment.exit : segments[index + 1]?.[1].entry)?.toDate();
    if ((before && corrected <= before) || (after && corrected >= after)) return false;
    if (slot) transaction.update(ref, { ['segments.' + slot + '.' + field]: corrected, editedSegment: slot });
    else transaction.set(ref, { ...marks, [field]: corrected });
    transaction.set(audit, data);
    return true;
  });
}
