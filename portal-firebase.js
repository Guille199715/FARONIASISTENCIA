import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  browserSessionPersistence, createUserWithEmailAndPassword, EmailAuthProvider, getAuth,
  initializeAuth, inMemoryPersistence, reauthenticateWithCredential, sendPasswordResetEmail,
  setPersistence, signInWithEmailAndPassword, signOut, updatePassword,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  collection, collectionGroup, doc, getDocFromServer, getFirestore, onSnapshot, query,
  runTransaction, serverTimestamp, where,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-web-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const ready = setPersistence(auth, browserSessionPersistence);
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
  const dni = profile.dni ?? (/^([0-9]{7,8})@personal\.asistencia-faroni\.web\.app$/.exec(user.email ?? '')?.[1]);
  return { username: user.uid, name: profile.name, role: profile.role, dni };
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

export async function changePassword(current, next) {
  const user = auth.currentUser;
  if (!user?.email) throw new Error('La sesión venció.');
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, current));
  if (auth.currentUser?.uid !== user.uid) throw new Error('La sesión cambió.');
  await updatePassword(user, next);
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
    const profile = { role: 'worker', dni: draft.dni, name: draft.name, createdOn: draft.createdOn };
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
  return [['in', data?.entry], ['out', data?.exit]]
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
  for (const name of ['network', 'schedule']) {
    watch(doc(db, 'portalSettings', name), name, (snapshot) => snapshot.data()?.value);
  }
  watch(employer ? collection(db, 'staffSchedules') : doc(db, 'staffSchedules', uid), 'staffSchedules',
    employer ? entries : (snapshot) => snapshot.exists() ? [{ ...snapshot.data(), id: uid }] : []);
  const corrections = collection(db, 'attendanceCorrections');
  watch(employer ? corrections : query(corrections, where('workerId', '==', uid)), 'corrections', entries);
  if (employer) {
    watch(collection(db, 'profiles'), 'staff', entries);
    watch(collection(db, 'staffAbsences'), 'absences', entries);
    watch(collection(db, 'plantClosures'), 'calendar', entries);
    watch(collectionGroup(db, 'records'), 'attendance', (snapshot) => snapshot.docs
      .filter((item) => item.ref.path.startsWith('attendance/'))
      .map((item) => ({ uid: item.id, marks: marksFrom(item.data()) })));
  } else {
    watch(attendance(uid, today), 'today', (snapshot) => ({ day: today, marks: marksFrom(snapshot.data()) }));
  }
  return () => stops.forEach((stop) => stop());
}

export async function readDay(uid, day) {
  return marksFrom((await getDocFromServer(attendance(uid, day))).data());
}

export async function punch(uid, date, type) {
  return runTransaction(db, async (transaction) => {
    const ref = attendance(uid, date);
    const data = (await transaction.get(ref)).data();
    if (type === 'in' && !data) transaction.set(ref, { entry: serverTimestamp() });
    else if (type === 'out' && data?.entry && !data.exit) transaction.update(ref, { exit: serverTimestamp() });
    else return false;
    return true;
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
    const previous = marks[field]?.toDate().toISOString() ?? '';
    if (previous !== data.previousAt) return false;
    const other = marks[field === 'entry' ? 'exit' : 'entry']?.toDate();
    const corrected = new Date(data.at);
    if (other && (field === 'entry' ? corrected >= other : corrected <= other)) return false;
    transaction.set(ref, { ...marks, [field]: corrected });
    transaction.set(audit, data);
    return true;
  });
}
