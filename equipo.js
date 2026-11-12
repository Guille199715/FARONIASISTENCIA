import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  browserSessionPersistence, createUserWithEmailAndPassword, getAuth, initializeAuth, inMemoryPersistence,
  onAuthStateChanged, setPersistence, signInWithEmailAndPassword, signOut,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  collection, doc, getDocFromServer, getFirestore, onSnapshot, runTransaction, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-web-config.js';

const get = (id) => document.getElementById(id);
const timeZone = 'America/Argentina/Buenos_Aires';
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
const displayDate = new Intl.DateTimeFormat('es-AR', { timeZone, dateStyle: 'full' });
const timeFormat = new Intl.DateTimeFormat('es-AR', { timeZone, timeStyle: 'short' });
const accessMessage = get('team-access-message');
const punchButton = get('record-punch');
const dialog = get('team-punch-dialog');
const employeeDialog = get('employee-setup-dialog');
const employeeForm = get('employee-setup-form');
const employeeName = get('employee-setup-name');
const employeeDni = get('employee-setup-dni');
const employeeSubmit = get('submit-employee-setup');
const employeePassword = get('employee-setup-password');
let auth;
let employeeAuth;
let db;
let account;
let currentDay;
let record;
let pending;
let writing = false;
let unsubscribeDay;
let unsubscribeStaff;
let staff = [];
let records = new Map();
let session = 0;
let employeeDraft;
let creatingEmployee = false;

function employeeEmail(dni) {
  return `${dni}@personal.asistencia-faroni.web.app`;
}

function normalizeDni(value) {
  return value.trim().replaceAll('.', '');
}

function plantDate(now = new Date()) {
  const parts = Object.fromEntries(dateFormat.formatToParts(now).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dayKey(date) {
  return String(Date.parse(`${date}T00:00:00Z`) / 86400000);
}

function attendanceRef(date, uid) {
  return doc(db, 'attendance', dayKey(date), 'records', uid);
}

function setMessage(message = '') {
  get('team-message').textContent = message;
  get('team-message').hidden = !message;
}

function formatMark(mark) {
  return mark ? timeFormat.format(mark.toDate()) : '—';
}

function renderEmployee() {
  get('attendance-in').textContent = formatMark(record?.entry);
  get('attendance-out').textContent = formatMark(record?.exit);
  punchButton.textContent = record?.exit ? 'Jornada registrada' : record?.entry ? 'Marcar salida' : 'Marcar entrada';
  punchButton.disabled = record === undefined || Boolean(record?.exit) || writing;
}

function renderTeam() {
  const names = staff.map(({ id, name }) => {
    const marks = records.get(id);
    const row = document.createElement('li');
    row.className = 'record';
    const label = document.createElement('strong');
    label.textContent = name;
    const times = document.createElement('span');
    times.textContent = `Entrada ${formatMark(marks?.entry)} · Salida ${formatMark(marks?.exit)}`;
    row.append(label, times);
    return row;
  });
  if (!names.length) {
    const empty = document.createElement('li');
    empty.textContent = 'Todavía no hay empleados habilitados.';
    names.push(empty);
  }
  get('attendance-team').replaceChildren(...names);
}

function watchDay() {
  if (!account) return;
  unsubscribeDay?.();
  const activeSession = session;
  if (account.role === 'worker') {
    const now = new Date();
    const date = plantDate(now);
    currentDay = date;
    get('attendance-today').textContent = displayDate.format(now);
    record = undefined;
    renderEmployee();
    unsubscribeDay = onSnapshot(attendanceRef(date, account.uid), { includeMetadataChanges: true }, (snapshot) => {
      if (activeSession !== session || date !== currentDay || snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
      record = snapshot.data() ?? null;
      renderEmployee();
    }, () => {
      if (activeSession !== session) return;
      setMessage('No pudimos consultar tus fichadas. Volvé a iniciar sesión para reintentar.');
    });
    return;
  }
  const date = get('attendance-date').value;
  records = new Map();
  renderTeam();
  if (!date) return;
  unsubscribeDay = onSnapshot(collection(db, 'attendance', dayKey(date), 'records'), (snapshot) => {
    if (activeSession !== session || date !== get('attendance-date').value) return;
    records = new Map(snapshot.docs.map((item) => [item.id, item.data()]));
    renderTeam();
  }, () => {
    if (activeSession === session) setMessage('No pudimos consultar la asistencia de esa fecha.');
  });
}

function resetView() {
  unsubscribeDay?.();
  unsubscribeStaff?.();
  if (dialog.open) dialog.close();
  if (employeeDialog.open) employeeDialog.close();
  employeeDraft = undefined;
  clearEmployeeForm();
  account = undefined;
  pending = undefined;
  currentDay = undefined;
  staff = [];
  records = new Map();
  get('team-access').hidden = false;
  get('team-workspace').hidden = true;
  get('attendance-team').replaceChildren();
  setMessage();
}

async function loadAccount(user) {
  const activeSession = ++session;
  resetView();
  if (!user) {
    get('team-enter').disabled = false;
    return;
  }
  get('team-enter').disabled = true;
  accessMessage.textContent = 'Verificando el acceso…';
  try {
    const profile = (await getDocFromServer(doc(db, 'profiles', user.uid))).data();
    if (activeSession !== session) return;
    if (!profile || !['employer', 'worker'].includes(profile.role) || !profile.name) {
      await signOut(auth);
      accessMessage.textContent = 'La cuenta todavía no tiene acceso al portal. Consultá con Administración.';
      return;
    }
    account = { uid: user.uid, role: profile.role, name: profile.name };
    const employer = account.role === 'employer';
    get('team-identity').textContent = account.name;
    get('team-heading').textContent = employer ? 'Asistencia del equipo' : 'Mi jornada';
    get('employee-jornada').hidden = employer;
    get('employer-attendance').hidden = !employer;
    get('team-access-form').reset();
    accessMessage.textContent = '';
    get('team-access').hidden = true;
    get('team-workspace').hidden = false;
    if (employer) {
      get('attendance-date').value = plantDate();
      unsubscribeStaff = onSnapshot(collection(db, 'profiles'), (snapshot) => {
        if (activeSession !== session) return;
        staff = snapshot.docs.map((item) => ({ ...item.data(), id: item.id }))
          .filter((item) => item.role === 'worker' && typeof item.name === 'string')
          .sort((a, b) => a.name.localeCompare(b.name, 'es-AR'));
        renderTeam();
      }, () => {
        if (activeSession === session) setMessage('No pudimos cargar la lista del personal.');
      });
    }
    watchDay();
    get('team-heading').focus();
  } catch {
    if (activeSession !== session) return;
    await signOut(auth);
    accessMessage.textContent = 'No pudimos verificar el acceso. Revisá tu conexión y volvé a intentar.';
  }
}

get('team-access-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = get('team-enter');
  if (button.disabled) return;
  const login = get('team-user').value.trim();
  const dni = normalizeDni(login);
  const email = /^[0-9]{7,8}$/.test(dni) ? employeeEmail(dni) : login;
  button.disabled = true;
  accessMessage.textContent = '';
  try {
    await signInWithEmailAndPassword(auth, email, get('team-password').value);
  } catch (error) {
    accessMessage.textContent = error.code === 'auth/network-request-failed'
      ? 'No pudimos conectar. Revisá tu conexión y volvé a intentar.'
      : 'El usuario o la contraseña no coinciden.';
    button.disabled = false;
  }
});

get('team-sign-out').addEventListener('click', async () => {
  try {
    await signOut(auth);
  } catch {
    setMessage('No pudimos cerrar la sesión. Volvé a intentar.');
  }
});
get('attendance-date').addEventListener('change', watchDay);

function setEmployeeMessage(message = '', error = false) {
  const notice = get('employee-setup-message');
  notice.textContent = message;
  notice.hidden = !message;
  notice.className = error ? 'form-error' : 'field-hint';
}

function clearEmployeeForm() {
  employeeForm.reset();
  employeeForm.hidden = false;
  employeePassword.value = '';
  get('employee-setup-success').textContent = '';
  get('employee-setup-result').hidden = true;
  get('employee-copy-message').textContent = '';
  setEmployeeMessage();
}

function updateEmployeeControls() {
  employeeName.readOnly = employeeDni.readOnly = Boolean(employeeDraft);
  employeeSubmit.disabled = creatingEmployee;
  get('cancel-employee-setup').disabled = creatingEmployee;
  employeeSubmit.textContent = creatingEmployee ? 'Creando cuenta…' : employeeDraft ? 'Reintentar alta' : 'Crear cuenta';
}

function createInitialPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return 'Aa7' + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function provisionEmployee(draft) {
  if (!draft.uid) {
    const email = employeeEmail(draft.dni);
    let credentials;
    try {
      credentials = await createUserWithEmailAndPassword(employeeAuth, email, draft.password);
    } catch (error) {
      if (error.code !== 'auth/email-already-in-use' || !draft.signupUncertain) {
        draft.signupUncertain = error.code === 'auth/network-request-failed' || error.code === 'auth/internal-error';
        throw error;
      }
      try {
        credentials = await signInWithEmailAndPassword(employeeAuth, email, draft.password);
      } catch (signInError) {
        if (!['auth/invalid-credential', 'auth/wrong-password'].includes(signInError.code)) throw signInError;
        draft.signupUncertain = false;
        throw error;
      }
    }
    draft.uid = credentials.user.uid;
  }
  if (draft.session !== session) throw new Error('Employer session changed');

  const ref = doc(db, 'profiles', draft.uid);
  const profile = { name: draft.name, role: 'worker', dni: draft.dni };
  await runTransaction(db, async (transaction) => {
    const existing = (await transaction.get(ref)).data();
    if (!existing) transaction.set(ref, profile);
    else if (existing.role !== profile.role || existing.name !== profile.name || existing.dni !== profile.dni) {
      throw new Error('Employee profile already exists');
    }
  });
}

get('open-employee-setup').addEventListener('click', () => {
  if (account?.role !== 'employer' || employeeDialog.open) return;
  clearEmployeeForm();
  if (employeeDraft) {
    employeeName.value = employeeDraft.name;
    employeeDni.value = employeeDraft.dni;
    setEmployeeMessage('Hay un alta pendiente. Reintentá para terminarla.', true);
  }
  updateEmployeeControls();
  employeeDialog.showModal();
  (employeeDraft ? employeeSubmit : employeeName).focus();
});

get('cancel-employee-setup').addEventListener('click', () => employeeDialog.close());
get('close-employee-setup').addEventListener('click', () => employeeDialog.close());
employeeDialog.addEventListener('cancel', (event) => {
  if (creatingEmployee) event.preventDefault();
});
employeeDialog.addEventListener('close', clearEmployeeForm);

employeeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (account?.role !== 'employer' || creatingEmployee || !employeeDialog.open) return;
  const name = employeeName.value.trim();
  const dni = normalizeDni(employeeDni.value);
  if (!name || !/^[0-9]{7,8}$/.test(dni)) {
    setEmployeeMessage('Ingresá el nombre y un DNI de 7 u 8 dígitos.', true);
    return;
  }
  const draft = employeeDraft ??= { name, dni, password: createInitialPassword(), session };
  creatingEmployee = true;
  updateEmployeeControls();
  setEmployeeMessage();
  try {
    employeeAuth ??= initializeAuth(initializeApp(firebaseConfig, 'employee-setup'), { persistence: inMemoryPersistence });
    await provisionEmployee(draft);
    if (draft.session !== session) return;
    employeeDraft = undefined;
    employeeForm.hidden = true;
    get('employee-setup-success').textContent = `Cuenta creada para ${draft.name}. DNI ${draft.dni}.`;
    employeePassword.value = draft.password;
    get('employee-setup-result').hidden = false;
    get('copy-employee-password').focus();
  } catch (error) {
    if (draft.session !== session) return;
    if (draft.uid || draft.signupUncertain) {
      setEmployeeMessage('No se pudo confirmar el alta. Reintentá desde esta pestaña para terminarla.', true);
    } else {
      employeeDraft = undefined;
      setEmployeeMessage(error.code === 'auth/email-already-in-use'
        ? 'Ya existe una cuenta con ese DNI.'
        : 'No se pudo crear la cuenta. Revisá la conexión y volvé a intentar.', true);
    }
  } finally {
    if (employeeAuth?.currentUser) await signOut(employeeAuth).catch(() => {});
    creatingEmployee = false;
    updateEmployeeControls();
  }
});

get('copy-employee-password').addEventListener('click', async () => {
  if (!employeePassword.value) return;
  try {
    await navigator.clipboard.writeText(employeePassword.value);
    if (employeePassword.value) get('employee-copy-message').textContent = 'Clave copiada.';
  } catch {
    employeePassword.focus();
    employeePassword.select();
  }
});

punchButton.addEventListener('click', () => {
  if (punchButton.disabled) return;
  const type = record?.entry ? 'exit' : 'entry';
  pending = { date: currentDay, type, uid: account.uid };
  get('team-punch-title').textContent = type === 'entry' ? '¿Confirmás tu entrada?' : '¿Confirmás tu salida?';
  dialog.returnValue = '';
  dialog.showModal();
});

dialog.addEventListener('close', async () => {
  const request = pending;
  pending = undefined;
  if (dialog.returnValue !== 'confirm' || !request || account?.uid !== request.uid || writing) return;
  if (request.date !== plantDate()) {
    watchDay();
    setMessage('Cambió la fecha. Revisá tu jornada y volvé a intentar.');
    return;
  }
  const activeSession = session;
  const ref = attendanceRef(request.date, request.uid);
  writing = true;
  renderEmployee();
  setMessage('Guardando fichada…');
  try {
    const saved = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (request.type === 'entry' && !snapshot.exists()) {
        transaction.set(ref, { entry: serverTimestamp() });
      } else if (request.type === 'exit' && snapshot.exists() && !snapshot.data().exit) {
        transaction.update(ref, { exit: serverTimestamp() });
      } else {
        return false;
      }
      return true;
    });
    if (activeSession === session) setMessage(saved ? 'Fichada registrada.' : 'La jornada cambió. Revisá el registro antes de volver a intentar.');
  } catch {
    if (activeSession === session) setMessage('No se pudo guardar la fichada. Revisá tu conexión y volvé a intentar.');
  } finally {
    writing = false;
    if (account?.role === 'worker') renderEmployee();
  }
});

async function boot() {
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
  await setPersistence(auth, browserSessionPersistence);
  accessMessage.textContent = '';
  onAuthStateChanged(auth, loadAccount);
  setInterval(() => {
    if (account?.role === 'worker' && currentDay !== plantDate()) watchDay();
  }, 15000);
}

boot().catch(() => {
  accessMessage.textContent = 'No pudimos abrir el portal. Revisá la conexión y recargá la página.';
});
