import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  browserSessionPersistence, getAuth, onAuthStateChanged, setPersistence, signInWithEmailAndPassword, signOut,
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
let auth;
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
  const dni = login.replaceAll('.', '');
  const email = /^[0-9]{7,8}$/.test(dni) ? `${dni}@personal.asistencia-faroni.web.app` : login;
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
