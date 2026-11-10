const timeZone = 'America/Argentina/Buenos_Aires';
const storageKey = 'faroni.demo.attendance.v1';
const workersKey = 'faroni.demo.workers.v1';
const absencesKey = 'faroni.demo.absences.v1';
const demoDni = '99999990';
const timeFormat = new Intl.DateTimeFormat('es-AR', {
  timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const longDateFormat = new Intl.DateTimeFormat('es-AR', { timeZone, dateStyle: 'full' });
const shortDateFormat = new Intl.DateTimeFormat('es-AR', {
  timeZone, weekday: 'long', day: 'numeric', month: 'short', year: 'numeric',
});
const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
});

const get = (id) => document.getElementById(id);
const punch = get('punch');
const wifiToggle = get('wifi-toggle');
const viewButtons = document.querySelectorAll('[data-view]');
const demoPassword = 'faroni-demo';
const accounts = [
  { username: demoDni, role: 'worker', name: 'Operario demo', initials: 'OD', detail: 'Legajo 001' },
  { username: 'empleador', role: 'employer', name: 'Empleador demo', initials: 'ED', detail: 'Administración' },
];
const shiftLabels = { open: 'En jornada', closed: 'Jornada cerrada', waiting: 'Sin fichar', absent: 'Ausencia avisada' };
const absenceReasons = new Map(Array.from(get('absence-reason').options, ({ value, text }) => [value, text]));
absenceReasons.delete('');
let account = null;
let credentialFlow = null;
let marks = [];
const sessionMarks = new Map();
let wifiConnected = false;
let displayedDay;
let toastTimer;

function plantDay(date) {
  const parts = Object.fromEntries(dayFormat.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function previousDay(day, daysAgo) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function demoHistory() {
  const today = plantDay(new Date());
  return [1, 2, 3].flatMap((daysAgo) => {
    const date = previousDay(today, daysAgo);
    return [
      { type: 'out', at: new Date(`${date}T16:02:00-03:00`).toISOString() },
      { type: 'in', at: new Date(`${date}T07:58:00-03:00`).toISOString() },
    ];
  });
}

function attendanceKey(username) {
  return username === demoDni ? storageKey : `${storageKey}.${username}`;
}

function loadMarks(username) {
  if (sessionMarks.has(username)) return sessionMarks.get(username);
  try {
    const data = JSON.parse(localStorage.getItem(attendanceKey(username)));
    if (Array.isArray(data) && data.every((mark) => (
      mark && ['in', 'out'].includes(mark.type) && typeof mark.at === 'string' && Number.isFinite(Date.parse(mark.at))
    ))) return data;
  } catch {
    // The demo is still usable when browser storage is unavailable.
  }
  return username === demoDni ? demoHistory() : [];
}

function readWorkers() {
  try {
    const data = JSON.parse(localStorage.getItem(workersKey));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function readAbsences() {
  try {
    const data = JSON.parse(localStorage.getItem(absencesKey));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function staffDirectory() {
  return [
    { id: demoDni, name: accounts[0].name, label: 'Legajo 001', active: true },
    { id: 'sample-002', name: 'Camila Torres', label: 'Legajo 002', active: true, entry: '07:52', exit: '15:56', openToday: true },
    { id: 'sample-003', name: 'Martín Ruiz', label: 'Legajo 003', active: true, entry: '08:04', exit: '16:06' },
    ...readWorkers().map((worker) => ({ id: worker.dni, name: worker.name, label: `DNI ${worker.dni}`, active: Boolean(worker.password), createdOn: worker.createdOn })),
  ];
}

function matchesWorker(worker, query) {
  const normalize = (text) => text.toLocaleLowerCase('es-AR').normalize('NFD').replace(/\p{M}/gu, '').replaceAll('.', '');
  return normalize(`${worker.name} ${worker.label}`).includes(normalize(query));
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function secretDigest(secret, salt) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: 600000,
  }, key, 256);
  return hex(new Uint8Array(bits));
}

async function protectSecret(secret) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, digest: await secretDigest(secret, salt) };
}

function setFormError(id, message = '') {
  const error = get(id);
  error.textContent = message;
  error.hidden = !message;
}

function handleForm(id, errorId, action) {
  const form = get(id);
  const submit = form.querySelector('button[type="submit"]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    setFormError(errorId);
    try {
      await action();
    } catch {
      setFormError(errorId, 'La demo no pudo completar la operación. Verificá que el navegador permita guardar datos locales.');
    } finally {
      submit.disabled = false;
    }
  });
}

function recordList(list, entries) {
  const rows = entries.map(({ type, at }) => {
    const row = document.createElement('li');
    row.className = 'record';
    row.dataset.type = type;
    row.innerHTML = `<span class="tile"><svg class="icon" aria-hidden="true"><use href="#i-${type}"/></svg></span>
      <div><strong></strong><span class="record-date"></span></div><time></time>`;
    const date = new Date(at);
    const time = row.querySelector('time');
    row.querySelector('strong').textContent = type === 'in' ? 'Entrada' : 'Salida';
    row.querySelector('.record-date').textContent = shortDateFormat.format(date);
    time.dateTime = at;
    time.textContent = timeFormat.format(date);
    return row;
  });
  if (!rows.length) {
    const empty = document.createElement('li');
    empty.className = 'field-hint';
    empty.textContent = 'Todavía no hay fichadas.';
    rows.push(empty);
  }
  list.replaceChildren(...rows);
}

function shiftSummary(records, day, today) {
  const daily = records.filter(({ at }) => plantDay(new Date(at)) === day);
  const latest = day === today ? records[0] : daily[0];
  const state = latest?.type === 'in' ? 'open' : daily.length ? 'closed' : 'waiting';
  return {
    state,
    entry: daily.find(({ type }) => type === 'in'),
    exit: daily.find(({ type }) => type === 'out'),
  };
}

function markTime(mark) {
  return mark ? timeFormat.format(new Date(mark.at)) : '—';
}

function renderShift(day) {
  const badge = get('shift-status');
  const { state, entry, exit } = shiftSummary(marks, day, day);
  const open = state === 'open';
  badge.dataset.state = state;
  badge.querySelector('span').textContent = shiftLabels[state];
  punch.querySelector('span').textContent = open ? 'Marcar salida' : 'Marcar entrada';
  punch.querySelector('use').setAttribute('href', open ? '#i-out' : '#i-in');
  get('today-in').textContent = markTime(entry);
  get('today-out').textContent = markTime(exit);
}

function renderTeam(now = new Date()) {
  const today = plantDay(now);
  const day = get('team-date').value || today;
  const query = get('team-search').value.trim();
  const absences = new Map(readAbsences().filter((absence) => absence.date === day).map((absence) => [absence.workerId, absence]));
  const staff = staffDirectory().filter((worker) => worker.active || absences.has(worker.id));
  const totals = { open: 0, closed: 0, waiting: 0, absent: 0 };
  const rows = [];
  for (const worker of staff) {
    const absence = absences.get(worker.id);
    let records = [];
    if (!worker.entry) records = loadMarks(worker.id);
    else if (!absence) records = sampleShift(day, today, now, worker.entry, worker.openToday && day === today ? null : worker.exit);
    const summary = shiftSummary(records, day, today);
    const state = absence && summary.state === 'waiting' ? 'absent' : summary.state;
    totals[state] += 1;
    if (!matchesWorker(worker, query)) continue;

    const row = document.createElement('tr');
    row.innerHTML = '<th scope="row"><strong></strong><small></small></th><td></td><td></td><td><span class="team-status"></span><small class="attendance-note" hidden></small></td>';
    row.querySelector('strong').textContent = worker.name;
    row.querySelector('small').textContent = worker.label;
    row.cells[1].textContent = markTime(summary.entry);
    row.cells[2].textContent = markTime(summary.exit);
    const badge = row.querySelector('.team-status');
    badge.dataset.state = state;
    badge.textContent = shiftLabels[state];
    if (absence) {
      const note = row.querySelector('.attendance-note');
      note.textContent = state === 'absent' ? absenceReasons.get(absence.reason) : 'También tiene una ausencia avisada';
      note.hidden = false;
    }
    rows.push(row);
  }
  for (const [state, total] of Object.entries(totals)) get(`total-${state}`).textContent = total;
  get('team-count').textContent = rows.length ? `${rows.length} de ${staff.length} operarios` : 'Sin coincidencias para la búsqueda.';
  get('team-list').replaceChildren(...rows);
}

function sampleShift(day, today, now, entry, exit) {
  if (day < previousDay(today, 3) || day > today) return [];
  return [{ type: 'out', time: exit }, { type: 'in', time: entry }]
    .filter(({ time }) => time)
    .map(({ type, time }) => ({ type, at: new Date(`${day}T${time}:00-03:00`) }))
    .filter(({ at }) => at <= now)
    .map(({ type, at }) => ({ type, at: at.toISOString() }));
}

function updateClock() {
  const now = new Date();
  const day = plantDay(now);
  get('clock').textContent = timeFormat.format(now);
  get('clock').dateTime = now.toISOString();
  if (day !== displayedDay) {
    const dateFilter = get('team-date');
    const monthFilter = get('absence-month');
    if (!dateFilter.value || dateFilter.value === displayedDay) dateFilter.value = day;
    if (!get('absence-date').value) get('absence-date').value = day;
    if (!monthFilter.value || monthFilter.value === displayedDay?.slice(0, 7)) monthFilter.value = day.slice(0, 7);
    displayedDay = day;
    get('date').textContent = longDateFormat.format(now);
    renderShift(day);
    if (account?.role === 'worker') renderWorkerAssignment(now);
    if (account?.role === 'employer') renderTeam(now);
    if (account?.role === 'employer' && !get('workers').hidden) renderAbsenceReport();
  }
}

function showMessage(message, warning = false) {
  const toast = get('toast');
  get('announcement').textContent = message;
  toast.textContent = message;
  toast.dataset.type = warning ? 'warning' : 'success';
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4200);
}

function setWifi(connected) {
  wifiConnected = connected;
  wifiToggle.setAttribute('aria-checked', String(wifiConnected));
  get('wifi-status').textContent = wifiConnected ? 'Conectado a Starlink' : 'Desconectado';
  get('wifi-status').classList.toggle('connected', wifiConnected);
  get('punch-note').textContent = wifiConnected ? 'Red de planta simulada. Ya podés fichar.' : 'Activá el Wi‑Fi simulado para fichar.';
}

wifiToggle.addEventListener('click', () => setWifi(!wifiConnected));

const punchDialog = get('punch-dialog');
let pendingPunch;

function canPunch() {
  if (account?.role !== 'worker') return false;
  if (!wifiConnected) {
    showMessage('Conectate al Wi‑Fi de planta para fichar. Activá el interruptor para simularlo.', true);
    return false;
  }
  return true;
}

punch.addEventListener('click', () => {
  if (punchDialog.open || !canPunch()) return;
  const currentMarks = loadMarks(account.username);
  const type = currentMarks[0]?.type === 'in' ? 'out' : 'in';
  pendingPunch = { username: account.username, type, latest: currentMarks[0]?.at };
  const action = type === 'in' ? 'entrada' : 'salida';
  get('punch-dialog-title').textContent = `¿Confirmás tu ${action}?`;
  get('punch-dialog-message').textContent = `Tu ${action} se registrará con la hora de planta al confirmar.`;
  get('confirm-punch').textContent = `Confirmar ${action}`;
  punchDialog.showModal();
});

get('cancel-punch').addEventListener('click', () => punchDialog.close());

get('punch-confirmation').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!punchDialog.open) return;
  punchDialog.close();
  if (!canPunch() || pendingPunch?.username !== account.username) return;

  marks = loadMarks(account.username);
  if (marks[0]?.at !== pendingPunch.latest || (marks[0]?.type === 'in' ? 'out' : 'in') !== pendingPunch.type) {
    renderShift(plantDay(new Date()));
    recordList(get('recent-list'), marks.slice(0, 3));
    recordList(get('history-list'), marks);
    showMessage('Tus fichadas cambiaron. Revisá el estado y volvé a intentar.', true);
    return;
  }
  const now = new Date();
  const { type } = pendingPunch;
  marks.unshift({ type, at: now.toISOString() });
  let stored = false;
  try {
    localStorage.setItem(attendanceKey(account.username), JSON.stringify(marks));
    sessionMarks.delete(account.username);
    stored = true;
  } catch {
    // Keep the mark visible for this session.
    sessionMarks.set(account.username, marks);
  }

  renderShift(plantDay(now));
  recordList(get('recent-list'), marks.slice(0, 3));
  recordList(get('history-list'), marks);
  const label = type === 'in' ? 'Entrada registrada' : 'Salida registrada';
  const storageNote = stored ? '' : ' Disponible hasta que cierres o recargues la página.';
  showMessage(`${label} a las ${timeFormat.format(now)}.${storageNote}`, !stored);
});

function employerView(view) {
  return view === 'team' || view === 'workers' || view === 'reports';
}

function showView(view) {
  if (!account || employerView(view) !== (account.role === 'employer')) return;
  for (const panel of ['home', 'history', 'team', 'workers', 'reports']) get(panel).hidden = panel !== view;
  document.querySelectorAll('.nav-item').forEach((item) => {
    if (item.dataset.view === view) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  if (view === 'team') renderTeam();
  if (view === 'home') renderWorkerAssignment();
  if (view === 'reports') openAttendanceReport();
  if (view === 'workers') {
    renderWorkers();
    renderAbsenceWorkers();
    renderAbsenceReport();
  }
  get(`${view}-title`).focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

viewButtons.forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));

document.querySelectorAll('[data-demo-user]').forEach((button) => {
  button.addEventListener('click', () => {
    get('username').value = button.dataset.demoUser;
    get('password').value = demoPassword;
    get('access-error').hidden = true;
    get('access-form').querySelector('button[type="submit"]').focus();
  });
});

function showCredentialForm(kind = null) {
  credentialFlow = kind ? { kind } : null;
  const visible = Boolean(kind);
  const recovery = kind === 'recovery';
  const title = visible ? 'activation-title' : 'access-title';
  get('activation-title').textContent = recovery ? 'Restablecer mi contraseña' : 'Activar mi cuenta';
  get('credential-help').textContent = recovery
    ? 'Ingresá tu DNI y el código de recuperación que te entregó el empleador. Después elegí una contraseña nueva.'
    : 'Ingresá el DNI ficticio y el código que te entregó el empleador.';
  get('credential-code-label').textContent = recovery ? 'Código de recuperación' : 'Código de activación';
  get('credential-submit-label').textContent = recovery ? 'Cambiar contraseña' : 'Activar cuenta';
  get('sign-in-content').hidden = visible;
  get('activation-content').hidden = !visible;
  get('access').setAttribute('aria-labelledby', title);
  get('activation-form').reset();
  get('password').value = '';
  setFormError('activation-error');
  setFormError('access-error');
  get(title).focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

get('activate-link').addEventListener('click', () => showCredentialForm('activation'));
get('forgot-password').addEventListener('click', () => showCredentialForm('recovery'));
get('return-to-login').addEventListener('click', () => showCredentialForm());

handleForm('access-form', 'access-error', async () => {
  const username = get('username').value.trim().toLowerCase();
  const password = get('password').value;
  const identifier = username === 'operario' ? demoDni : username.replaceAll('.', '');
  let match = accounts.find((item) => item.username === identifier && password === demoPassword);
  const worker = readWorkers().find(({ dni }) => dni === identifier);
  if (worker?.password && worker.password.digest === await secretDigest(password, worker.password.salt)) {
    const current = readWorkers().find(({ dni }) => dni === identifier);
    if (current?.password?.digest === worker.password.digest) {
      match = { username: worker.dni, role: 'worker', name: worker.name, initials: worker.initials, detail: `DNI ${worker.dni}` };
    }
  }
  if (get('sign-in-content').hidden || account) return;
  if (!match) {
    setFormError('access-error', 'Los datos de ingreso no coinciden. Si olvidaste tu clave, elegí Olvidé mi contraseña.');
    return;
  }

  account = match;
  const employer = account.role === 'employer';
  get('access-form').reset();
  get('portal-label').textContent = employer ? 'Portal del empleador' : 'Portal del operario';
  get('identity-avatar').textContent = account.initials;
  get('identity-name').textContent = account.name;
  get('identity-detail').textContent = account.detail;
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.hidden = employerView(item.dataset.view) !== employer;
  });
  if (!employer) {
    marks = loadMarks(account.username);
    renderShift(plantDay(new Date()));
    recordList(get('recent-list'), marks.slice(0, 3));
    recordList(get('history-list'), marks);
  }
  get('access').hidden = true;
  get('workspace').hidden = false;
  get('rail').hidden = false;
  showView(employer ? 'team' : 'home');
});

async function createWorkerCode() {
  const code = hex(crypto.getRandomValues(new Uint8Array(4))).toUpperCase();
  const secret = await protectSecret(code);
  return { code, credential: { ...secret, expires: Date.now() + 24 * 60 * 60 * 1000 } };
}

async function issueCode(dni, newWorker) {
  const { code, credential } = await createWorkerCode();
  if (account?.role !== 'employer' || get('workers').hidden) return;

  const workers = readWorkers();
  const worker = workers.find((item) => item.dni === dni);
  if (newWorker && (dni === demoDni || worker)) {
    setFormError('worker-error', 'Ya existe una cuenta con ese DNI.');
    return;
  }
  if (!newWorker && (!worker || worker.password)) {
    renderWorkers();
    setFormError('worker-code-error', 'Esta cuenta ya no está pendiente de activación.');
    return;
  }

  const target = newWorker || worker;
  target.activation = credential;
  if (newWorker) workers.push(newWorker);
  localStorage.setItem(workersKey, JSON.stringify(workers));
  get('issued-name').textContent = `Código para ${target.name}`;
  get('issued-value').value = code;
  get('issued-code').hidden = false;
  if (newWorker) get('worker-form').reset();
  renderWorkers();
  if (newWorker) {
    renderAbsenceWorkers();
  }
  get('issued-code').focus();
}

function renderWorkers() {
  const accountsByDni = new Map(readWorkers().map((worker) => [worker.dni, worker]));
  const profiles = readReportSetting(workerProfilesKey, {});
  const rows = staffDirectory().map((worker) => {
    const registered = accountsByDni.get(worker.id);
    const row = document.createElement('li');
    row.className = 'worker-row';
    row.innerHTML = '<div><button type="button" class="worker-profile-link"><strong></strong><small></small></button></div><span class="team-status"></span><button type="button" class="history-link worker-code" hidden>Nuevo código</button>';
    const profile = row.querySelector('.worker-profile-link');
    profile.querySelector('strong').textContent = worker.name;
    const position = profiles[worker.id]?.position;
    profile.querySelector('small').textContent = position ? `${worker.label} · ${position}` : worker.label;
    profile.setAttribute('aria-label', `Editar el perfil de ${worker.name}`);
    profile.setAttribute('aria-haspopup', 'dialog');
    const status = row.querySelector('.team-status');
    status.dataset.state = worker.active ? 'open' : 'waiting';
    status.textContent = registered ? (worker.active ? 'Activa' : registered.activation?.expires > Date.now() ? 'Pendiente de activación' : 'Código vencido') : 'Demo';
    profile.addEventListener('click', () => openScheduleEditor(worker, status.textContent));
    if (registered && !worker.active) {
      const button = row.querySelector('.worker-code');
      button.hidden = false;
      button.setAttribute('aria-label', `Generar nuevo código para ${worker.name}`);
      button.addEventListener('click', async () => {
        if (button.disabled) return;
        button.disabled = true;
        setFormError('worker-code-error');
        try {
          await issueCode(worker.id);
        } catch {
          setFormError('worker-code-error', 'La demo no pudo generar un código nuevo.');
        } finally {
          button.disabled = false;
        }
      });
    }
    return row;
  });
  get('workers-list').replaceChildren(...rows);
}

handleForm('worker-form', 'worker-error', async () => {
  if (account?.role !== 'employer') return;
  const first = get('worker-first').value.trim();
  const last = get('worker-last').value.trim();
  const dni = get('worker-dni').value;
  if (!first || !last || !/^[0-9]{7,8}$/.test(dni)) {
    setFormError('worker-error', 'Completá el nombre, el apellido y un DNI ficticio de 7 u 8 números.');
    return;
  }
  await issueCode(dni, { dni, name: `${first} ${last}`, initials: `${first[0]}${last[0]}`.toUpperCase(), createdOn: plantDay(new Date()) });
});

function renderAbsenceWorkers(selectMatch = false) {
  const select = get('absence-worker');
  const selected = select.value;
  const query = get('absence-search').value.trim();
  const staff = staffDirectory().filter((worker) => matchesWorker(worker, query));
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = staff.length ? 'Elegí un operario' : 'Sin coincidencias';
  const options = staff.map((worker) => {
    const option = document.createElement('option');
    option.value = worker.id;
    option.textContent = `${worker.name} · ${worker.label}`;
    return option;
  });
  select.replaceChildren(placeholder, ...options);
  select.value = staff.some((worker) => worker.id === selected) ? selected : '';
  if (!select.value && selectMatch && staff.length === 1) select.value = staff[0].id;
  if (select.value !== selected || !selectMatch) renderAbsenceForm();
}

function renderAbsenceForm() {
  const workerId = get('absence-worker').value;
  const date = get('absence-date').value;
  const absences = readAbsences().filter((absence) => absence.workerId === workerId);
  const existing = absences.find((absence) => absence.date === date);
  get('absence-reason').value = existing?.reason || '';
  get('absence-note').value = existing?.note || '';
  get('absence-certificate').checked = Boolean(existing?.certificate);
  get('absence-save').textContent = existing ? 'Guardar cambios' : 'Guardar ausencia';
  setFormError('absence-error');
  const empty = get('absence-empty');
  empty.textContent = workerId ? 'Este operario todavía no tiene ausencias registradas.' : 'Elegí un operario para consultar sus ausencias.';
  empty.hidden = absences.length > 0;
  const rows = absences.sort((a, b) => b.date.localeCompare(a.date)).map((absence) => {
    const row = document.createElement('li');
    row.className = 'worker-row absence-row';
    row.innerHTML = '<div><time></time><strong></strong><small></small><p class="field-hint" hidden></p></div><button type="button" class="history-link">Editar</button>';
    const dateLabel = shortDateFormat.format(new Date(`${absence.date}T12:00:00-03:00`));
    const time = row.querySelector('time');
    time.dateTime = absence.date;
    time.textContent = dateLabel;
    row.querySelector('strong').textContent = absenceReasons.get(absence.reason);
    row.querySelector('small').textContent = absence.certificate ? 'Certificado presentado' : 'Sin certificado registrado';
    const note = row.querySelector('p');
    note.textContent = absence.note;
    note.hidden = !absence.note;
    const edit = row.querySelector('button');
    edit.setAttribute('aria-label', `Editar ausencia del ${dateLabel}`);
    edit.addEventListener('click', () => {
      get('absence-date').value = absence.date;
      renderAbsenceForm();
      get('absence-reason').focus();
    });
    return row;
  });
  get('absence-list').replaceChildren(...rows);
}

function renderAbsenceReport() {
  const month = get('absence-month').value;
  const totals = new Map([...absenceReasons.keys()].map((reason) => [reason, 0]));
  const groups = new Map();
  let count = 0;
  let certified = 0;
  for (const absence of readAbsences()) {
    if (!absence.date.startsWith(`${month}-`) || !totals.has(absence.reason)) continue;
    if (!groups.has(absence.workerId)) groups.set(absence.workerId, { count: 0, certified: 0, latest: '', reasons: new Map() });
    const group = groups.get(absence.workerId);
    group.count += 1;
    group.certified += Number(Boolean(absence.certificate));
    if (absence.date > group.latest) group.latest = absence.date;
    group.reasons.set(absence.reason, (group.reasons.get(absence.reason) || 0) + 1);
    totals.set(absence.reason, totals.get(absence.reason) + 1);
    count += 1;
    certified += Number(Boolean(absence.certificate));
  }

  get('month-total').textContent = count;
  get('month-certified').textContent = certified;
  get('month-uncertified').textContent = count - certified;
  const empty = get('month-empty');
  empty.textContent = 'No hay avisos registrados en este mes.';
  empty.hidden = count > 0;
  get('month-reasons').replaceChildren(...Array.from(totals, ([reason, total]) => {
    const item = document.createElement('li');
    item.textContent = `${absenceReasons.get(reason)}: ${total}`;
    return item;
  }));

  const staff = new Map(staffDirectory().map((worker) => [worker.id, worker]));
  const rows = Array.from(groups, ([workerId, group]) => {
    const worker = staff.get(workerId);
    const name = worker?.name || `Operario ${workerId}`;
    const row = document.createElement('li');
    row.className = 'worker-row report-row';
    row.innerHTML = '<div><strong></strong><small></small><p class="field-hint"></p></div><button type="button" class="history-link">Ver historial</button>';
    row.querySelector('strong').textContent = name;
    row.querySelector('small').textContent = `${group.count} ${group.count === 1 ? 'aviso' : 'avisos'} · ${group.certified} con certificado`;
    row.querySelector('p').textContent = Array.from(group.reasons, ([reason, total]) => `${absenceReasons.get(reason)}: ${total}`).join(' · ');
    const button = row.querySelector('button');
    button.hidden = !worker;
    button.setAttribute('aria-label', `Ver historial de ausencias de ${name}`);
    button.addEventListener('click', () => {
      get('absence-search').value = '';
      renderAbsenceWorkers();
      get('absence-worker').value = workerId;
      get('absence-date').value = group.latest;
      renderAbsenceForm();
      get('absence-list-title').focus();
    });
    return row;
  });
  get('month-workers').replaceChildren(...rows);
}

document.querySelectorAll('[data-absence-report]').forEach((button) => {
  button.addEventListener('click', () => {
    if (account?.role !== 'employer') return;
    if (get('workers').hidden) showView('workers');
    get('absence-report-title').focus();
  });
});

get('absence-month-help').hidden = get('absence-month').type === 'month';
get('absence-month').addEventListener('change', () => {
  const filter = get('absence-month');
  if (!filter.validity.valid) filter.value = displayedDay.slice(0, 7);
  renderAbsenceReport();
});

get('absence-shortcut').addEventListener('click', () => {
  if (!get('absence-worker').value) get('absence-date').value = plantDay(new Date());
  get('absence-search').focus();
});
get('absence-search').addEventListener('input', () => renderAbsenceWorkers(true));
get('absence-worker').addEventListener('change', renderAbsenceForm);
get('absence-date').addEventListener('change', renderAbsenceForm);

handleForm('absence-form', 'absence-error', () => {
  if (account?.role !== 'employer' || get('workers').hidden) return;
  const workerId = get('absence-worker').value;
  const date = get('absence-date').value;
  const reason = get('absence-reason').value;
  if (!staffDirectory().some((worker) => worker.id === workerId) || !date || !get('absence-date').validity.valid || !absenceReasons.has(reason)) {
    setFormError('absence-error', 'Elegí un operario, una fecha y un motivo.');
    return;
  }

  const absences = readAbsences();
  const index = absences.findIndex((absence) => absence.workerId === workerId && absence.date === date);
  const absence = { workerId, date, reason, note: get('absence-note').value.trim(), certificate: get('absence-certificate').checked };
  if (index < 0) absences.push(absence);
  else absences[index] = absence;
  localStorage.setItem(absencesKey, JSON.stringify(absences));
  renderAbsenceForm();
  renderAbsenceReport();
  showMessage(index < 0 ? 'Ausencia registrada.' : 'Cambios guardados.');
});

handleForm('activation-form', 'activation-error', async () => {
  const flow = credentialFlow;
  if (!flow || account) return;
  const recovery = flow.kind === 'recovery';
  const dni = get('activation-dni').value;
  const code = get('activation-code').value.trim().toUpperCase();
  const password = get('activation-password').value;
  if (password.length < 15 || password.length > 128 || password !== get('activation-confirm').value) {
    setFormError('activation-error', 'Usá una contraseña de 15 a 128 caracteres y repetila igual.');
    return;
  }

  const invalidCode = 'El DNI o el código son incorrectos, o el código ya no está vigente.';
  const target = readWorkers().find((item) => item.dni === dni);
  const credential = target?.[flow.kind];
  const validCode = credential && Boolean(target.password) === recovery && credential.expires > Date.now()
    && credential.digest === await secretDigest(code, credential.salt);
  if (credentialFlow !== flow || account) return;
  if (!validCode) {
    setFormError('activation-error', invalidCode);
    return;
  }

  const protectedPassword = await protectSecret(password);
  if (credentialFlow !== flow || account) return;
  const workers = readWorkers();
  const worker = workers.find((item) => item.dni === dni);
  const current = worker?.[flow.kind];
  if (!current || current.digest !== credential.digest || current.expires <= Date.now() || Boolean(worker.password) !== recovery) {
    setFormError('activation-error', invalidCode);
    return;
  }
  worker.password = protectedPassword;
  delete worker[flow.kind];
  localStorage.setItem(workersKey, JSON.stringify(workers));
  showCredentialForm();
  get('username').value = dni;
  get('password').focus();
  showMessage(recovery ? 'Contraseña actualizada. Ya podés ingresar con tu DNI y la nueva clave.' : 'Cuenta activada. Ya podés entrar con tu DNI y contraseña.');
});

get('sign-out').addEventListener('click', () => {
  account = null;
  marks = [];
  setWifi(false);
  clearTimeout(toastTimer);
  get('toast').hidden = true;
  get('announcement').textContent = '';
  get('workspace').hidden = true;
  get('rail').hidden = true;
  get('team-date').value = displayedDay;
  get('team-search').value = '';
  get('worker-form').reset();
  get('absence-form').reset();
  get('absence-date').value = plantDay(new Date());
  get('absence-list').replaceChildren();
  get('absence-month').value = displayedDay.slice(0, 7);
  get('month-workers').replaceChildren();
  setFormError('worker-error');
  setFormError('worker-code-error');
  get('issued-value').value = '';
  get('issued-code').hidden = true;
  get('access').hidden = false;
  get('access-title').focus({ preventScroll: true });
  window.scrollTo(0, 0);
});

get('team-date').addEventListener('change', () => {
  const filter = get('team-date');
  if (!filter.validity.valid) filter.value = displayedDay;
  renderTeam();
});
get('team-search').addEventListener('input', () => renderTeam());

updateClock();
setInterval(updateClock, 1000);
