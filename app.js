const timeZone = 'America/Argentina/Buenos_Aires';
const absencesKey = 'absences';
const plantNetworkKey = 'network';
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
const plantLocationToggle = get('plant-location-toggle');
const viewButtons = document.querySelectorAll('[data-view]');
const teamStatusButtons = document.querySelectorAll('[data-team-status]');
const workerViews = ['home', 'profile'];
const employerViews = ['menu', 'home', 'team', 'workers', 'worker-add', 'absences', 'absence-summary', 'reports', 'factory-hours', 'calendar', 'corrections'];
const shiftLabels = { open: 'En jornada', closed: 'Registró salida', waiting: 'Sin fichar', absent: 'Novedad registrada' };
const absenceReasons = new Map(Array.from(get('absence-reason').options, ({ value, text }) => [value, text]));
absenceReasons.delete('');
let account = null;
let teamStatus = '';
let marks = [];
let cloud;
let stopPortal;
let workerDraft;
let historyLoad;
let attendanceReady = false;
let loadedToday;
const portalState = new Map();
const portalMarks = new Map();
const seenNotifications = new Set();
let sessionVersion = 0;
let connectionCheck = 0;
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

function loadOriginalMarks(uid) {
  return portalMarks.get(uid) ?? [];
}

function readAbsences() {
  return [...(portalState.get(absencesKey) ?? [])];
}

function staffDirectory() {
  return (portalState.get('staff') ?? []).filter((item) => item.role === 'worker' && typeof item.name === 'string')
    .map((item) => ({
      id: item.id, name: item.name, label: item.dni ? 'DNI ' + item.dni : 'Personal',
      active: !item.archivedAt, disabled: item.disabled === true, createdOn: item.createdOn,
      archivedOn: item.archivedAt ? plantDay(item.archivedAt.toDate()) : undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es-AR'));
}

function matchesWorker(worker, query) {
  const normalize = (text) => text.toLocaleLowerCase('es-AR').normalize('NFD').replace(/\p{M}/gu, '').replaceAll('.', '');
  return normalize(`${worker.name} ${worker.label}`).includes(normalize(query));
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function setFormError(id, message = '') {
  const error = get(id);
  error.textContent = message;
  error.hidden = !message;
}

const actionConfirmation = get('action-confirmation');
let confirmationPending = false;

function confirmAction(title, message, label, destructive = false) {
  if (confirmationPending) return Promise.resolve(false);
  const session = sessionVersion;
  get('action-confirmation-title').textContent = title;
  const description = get('action-confirmation-message');
  description.textContent = message;
  description.hidden = !message;
  const submit = get('action-confirmation-submit');
  submit.textContent = label;
  submit.classList.toggle('confirmation-danger', destructive);
  actionConfirmation.returnValue = '';
  actionConfirmation.showModal();
  confirmationPending = true;
  return new Promise((resolve) => {
    actionConfirmation.addEventListener('close', () => {
      confirmationPending = false;
      resolve(actionConfirmation.returnValue === 'confirm' && session === sessionVersion);
    }, { once: true });
  });
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
      setFormError(errorId, 'No se pudo completar la operación. Revisá tu conexión y volvé a intentar.');
    } finally {
      submit.disabled = false;
    }
  });
}

function recordList(list, entries) {
  const rows = entries.map(({ type, at, correctionId, manual }) => {
    const row = document.createElement('li');
    row.className = 'record';
    row.dataset.type = type;
    row.innerHTML = `<span class="tile"><svg class="icon" aria-hidden="true"><use href="#i-${type}"/></svg></span>
      <div><strong></strong><span class="record-date"></span></div><time></time>`;
    const date = new Date(at);
    const time = row.querySelector('time');
    const label = type === 'in' ? 'Entrada' : 'Salida';
    const correctionLabel = manual ? 'Ajuste manual' : 'Corrección aprobada';
    row.querySelector('strong').textContent = correctionId ? `${label} · ${correctionLabel}` : label;
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

function shiftSummary(records, day) {
  const daily = records.filter(({ at }) => plantDay(new Date(at)) === day);
  const latest = daily[0];
  const state = latest?.type === 'in' ? 'open' : daily.length ? 'closed' : 'waiting';
  return {
    state,
    entry: daily.find(({ type }) => type === 'in'),
    exit: daily.find(({ type }) => type === 'out'),
    daily,
  };
}

function markTime(mark) {
  return mark ? timeFormat.format(new Date(mark.at)) : '—';
}

function renderShift(day) {
  const badge = get('shift-status');
  const { state, entry, exit, daily } = shiftSummary(marks, day);
  const open = state === 'open';
  badge.dataset.state = state;
  badge.querySelector('span').textContent = shiftLabels[state];
  punch.disabled = !attendanceReady || !portalState.has('network') || !portalState.has('location') ||
    checkingPunchLocation || savingPunch;
  punch.querySelector('span').textContent = open ? 'Marcar salida' : exit ? 'Marcar regreso' : 'Marcar entrada';
  punch.querySelector('use').setAttribute('href', open ? '#i-out' : '#i-in');
  get('today-in').textContent = markTime(entry);
  get('today-out').textContent = markTime(exit);
  recordList(get('today-mark-list'), daily);
}

function renderTeam(now = new Date()) {
  const today = plantDay(now);
  const day = get('team-date').value || today;
  const query = get('team-search').value.trim();
  const absences = new Map(readAbsences().filter((absence) => absence.date === day).map((absence) => [absence.workerId, absence]));
  const staff = staffDirectory().filter((worker) => worker.active || day < worker.archivedOn ||
    absences.has(worker.id) || loadOriginalMarks(worker.id).some(({ at }) => plantDay(new Date(at)) === day));
  const totals = { open: 0, closed: 0, waiting: 0, absent: 0 };
  const rows = [];
  for (const worker of staff) {
    const absence = absences.get(worker.id);
    const records = loadMarks(worker.id, now);
    const summary = shiftSummary(records, day);
    const state = absence && summary.state === 'waiting' ? 'absent' : summary.state;
    totals[state] += 1;
    if ((teamStatus && state !== teamStatus) || !matchesWorker(worker, query)) continue;

    const row = document.createElement('tr');
    row.innerHTML = '<th scope="row"><strong></strong><small></small></th><td></td><td></td><td><span class="team-status"></span><small class="attendance-note" hidden></small></td>';
    row.querySelector('strong').textContent = worker.name;
    row.querySelector('small').textContent = worker.label;
    const adjust = document.createElement('button');
    adjust.type = 'button';
    adjust.className = 'history-link team-adjust';
    adjust.textContent = 'Ajustar fichada';
    adjust.setAttribute('aria-label', `Ajustar fichada de ${worker.name}`);
    adjust.setAttribute('aria-haspopup', 'dialog');
    adjust.addEventListener('click', () => openManualAdjustment(worker, day));
    if (day <= today) row.querySelector('th').append(adjust);
    row.cells[1].textContent = markTime(summary.entry);
    row.cells[2].textContent = markTime(summary.exit);
    const badge = row.querySelector('.team-status');
    badge.dataset.state = state;
    badge.textContent = shiftLabels[state];
    if (summary.daily.length > 2) {
      const details = document.createElement('details');
      const title = document.createElement('summary');
      title.textContent = `Ver ${summary.daily.length} fichadas`;
      const list = document.createElement('ul');
      list.className = 'record-list';
      recordList(list, summary.daily);
      details.append(title, list);
      row.querySelector('th').append(details);
    }
    if (absence) {
      const note = row.querySelector('.attendance-note');
      note.textContent = absenceReasons.get(absence.reason);
      note.hidden = false;
    }
    rows.push(row);
  }
  for (const [state, total] of Object.entries(totals)) get(`total-${state}`).textContent = total;
  teamStatusButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.teamStatus === teamStatus));
  });
  get('clear-team-status').hidden = !teamStatus;
  const statusLabel = teamStatus ? ` · ${shiftLabels[teamStatus]}` : '';
  get('team-count').textContent = `${rows.length} de ${staff.length} personas${statusLabel}`;
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
    if (account?.role === 'employer' && !get('team').hidden) renderTeam(now);
    if (account?.role === 'employer' && !get('absence-summary').hidden) renderAbsenceReport();
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

function isIPv4(ip) {
  return typeof ip === 'string' && /^(?:(?:0|[1-9]\d{0,2})\.){3}(?:0|[1-9]\d{0,2})$/.test(ip)
    && ip.split('.').every((part) => Number(part) <= 255);
}

function readPlantNetwork() {
  return readReportSetting(plantNetworkKey, { enabled: false, ip: '' });
}

function renderPlantNetwork() {
  const { enabled } = readPlantNetwork();
  wifiToggle.setAttribute('aria-checked', String(enabled === true));
  get('wifi-status').textContent = enabled ? 'Red de planta obligatoria' : 'Fichaje sin restricción de red';
  renderPlantLocation();
  refreshPlantConnection();
}

function readPlantLocation() {
  return readReportSetting('location', { enabled: false, latitude: null, longitude: null, radius: 200 });
}

function renderPlantLocation() {
  const geo = readPlantLocation().enabled;
  const network = readPlantNetwork().enabled;
  plantLocationToggle.hidden = !onPlantSettings() || !portalState.has('location');
  plantLocationToggle.setAttribute('aria-checked', String(geo === true));
  get('plant-location-status').textContent = !portalState.has('location') ? 'Cargando configuración…'
    : geo ? 'Ubicación obligatoria al fichar' : 'Fichaje sin restricción de ubicación';
  get('punch-note').textContent = geo && network ? 'Para fichar, conectate a la red de planta y permití usar tu ubicación.'
    : geo ? 'Para fichar, permití usar tu ubicación.'
    : network ? 'Conectate a la red de planta para fichar.' : 'Podés fichar desde cualquier conexión.';
}

function fillPlantLocation() {
  const { latitude, longitude, radius } = readPlantLocation();
  get('plant-latitude').value = latitude ?? '';
  get('plant-longitude').value = longitude ?? '';
  get('plant-radius').value = radius;
  setFormError('plant-location-error');
}

async function currentPosition() {
  const options = { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 };
  if (window.Capacitor?.isNativePlatform()) {
    try {
      const { coords } = await window.Capacitor.Plugins.Geolocation.getCurrentPosition(options);
      return coords;
    } catch (error) {
      throw new Error(error.code === 'OS-PLUG-GLOC-0003'
        ? 'Permití el acceso a tu ubicación en los ajustes de Faroni.'
        : 'No pudimos obtener tu ubicación. Activá la ubicación del dispositivo y volvé a intentar.');
    }
  }
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Este navegador no ofrece acceso a la ubicación.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(({ coords }) => resolve(coords), (error) => {
      reject(new Error(error.code === 1 ? 'Permití el acceso a tu ubicación en el navegador.'
        : 'No pudimos obtener tu ubicación. Activá la ubicación del dispositivo y volvé a intentar.'));
    }, options);
  });
}

function distanceToPlant(position, plant) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const deltaLat = radians(position.latitude - plant.latitude);
  const deltaLon = radians(position.longitude - plant.longitude);
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(radians(plant.latitude)) *
    Math.cos(radians(position.latitude)) * Math.sin(deltaLon / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

async function lookupPublicIPv4() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch('https://api.ipify.org?format=json', {
      cache: 'no-store', credentials: 'omit', signal: controller.signal,
    });
    if (!response.ok) throw new Error('IP lookup failed');
    const { ip } = await response.json();
    if (!isIPv4(ip)) throw new Error('Invalid IPv4');
    return ip;
  } finally {
    clearTimeout(timeout);
  }
}

function showPlantConnection(state, message) {
  const indicator = get('plant-connection');
  indicator.dataset.state = state;
  indicator.textContent = message;
}

async function refreshPlantConnection() {
  if (!account || get('home').hidden) return;
  const check = ++connectionCheck;
  const session = sessionVersion;
  const { ip: expectedIP } = readPlantNetwork();
  const button = get('check-plant-connection');
  button.hidden = !isIPv4(expectedIP);
  button.disabled = false;
  if (button.hidden) {
    showPlantConnection('unconfigured', 'Red de planta sin configurar');
    return;
  }
  if (navigator.onLine === false) {
    showPlantConnection('offline', 'Sin conexión a internet');
    return;
  }

  button.disabled = true;
  showPlantConnection('checking', 'Verificando red…');
  let ip;
  try {
    ip = await lookupPublicIPv4();
  } catch {
    // A failed lookup leaves the current network unverified.
  }
  if (check !== connectionCheck || session !== sessionVersion || get('home').hidden) return;
  button.disabled = false;
  if (expectedIP === readPlantNetwork().ip) renderConnectionResult(ip, expectedIP);
}

function renderConnectionResult(ip, expectedIP) {
  if (!ip) {
    showPlantConnection('unknown', 'No se pudo verificar la red');
  } else if (ip === expectedIP) {
    showPlantConnection('connected', 'Conectado a la red de planta');
  } else {
    showPlantConnection('outside', 'Fuera de la red de planta');
  }
}

get('check-plant-connection').addEventListener('click', refreshPlantConnection);
window.addEventListener('online', refreshPlantConnection);
window.addEventListener('offline', refreshPlantConnection);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshPlantConnection();
});

function onPlantSettings() {
  return account?.role === 'employer' && !get('home').hidden;
}

async function savePlantNetwork(enabled, ip) {
  setFormError('plant-network-error');
  if ((enabled || ip) && !isIPv4(ip)) {
    setFormError('plant-network-error', 'Ingresá una IPv4 válida o elegí Usar IP actual desde la red de planta.');
    get('plant-ip').focus();
    return false;
  }
  const session = sessionVersion;
  try {
    await cloud.saveSetting(plantNetworkKey, { enabled, ip });
    if (session !== sessionVersion) return false;
    portalState.set(plantNetworkKey, { enabled, ip });
  } catch {
    setFormError('plant-network-error', 'No se pudo guardar la configuración de red.');
    return false;
  }
  get('plant-ip').value = ip;
  renderPlantNetwork();
  return true;
}

wifiToggle.addEventListener('click', async () => {
  if (!onPlantSettings()) return;
  const config = readPlantNetwork();
  const enabled = !config.enabled;
  const ip = enabled ? get('plant-ip').value.trim() : (isIPv4(config.ip) ? config.ip : '');
  wifiToggle.disabled = true;
  const saved = await savePlantNetwork(enabled, ip);
  wifiToggle.disabled = false;
  if (saved) {
    showMessage(enabled ? 'Control de red activado.' : 'Control de red desactivado.');
  }
});

handleForm('plant-network-form', 'plant-network-error', async () => {
  if (!onPlantSettings()) return;
  const ip = get('plant-ip').value.trim();
  if (!ip) {
    setFormError('plant-network-error', 'Ingresá la IP pública de planta.');
    return;
  }
  if (await savePlantNetwork(readPlantNetwork().enabled, ip)) showMessage('IP de planta guardada.');
});

get('use-plant-ip').addEventListener('click', async (event) => {
  if (!onPlantSettings()) return;
  const button = event.currentTarget;
  const session = sessionVersion;
  const field = get('plant-ip');
  const initialValue = field.value;
  button.disabled = true;
  setFormError('plant-network-error');
  try {
    const ip = await lookupPublicIPv4();
    if (!onPlantSettings() || session !== sessionVersion || field.value !== initialValue) return;
    field.value = ip;
    showMessage('IP actual detectada. Guardala o activá el control para aplicarla.');
  } catch {
    if (onPlantSettings() && session === sessionVersion) setFormError('plant-network-error', 'No pudimos detectar la IP actual. Revisá tu conexión o ingresala manualmente.');
  } finally {
    button.disabled = false;
  }
});

const punchDialog = get('punch-dialog');
let pendingPunch;
let savingPunch = false;
let checkingPunchLocation = false;

get('use-plant-location').addEventListener('click', async (event) => {
  if (!onPlantSettings()) return;
  const button = event.currentTarget;
  const session = sessionVersion;
  button.disabled = true;
  setFormError('plant-location-error');
  try {
    const { latitude, longitude, accuracy } = await currentPosition();
    if (session !== sessionVersion || !onPlantSettings()) return;
    if (!Number.isFinite(accuracy) || accuracy > 50) {
      setFormError('plant-location-error', 'La ubicación del dispositivo es imprecisa. Probá al aire libre o ingresá las coordenadas.');
      return;
    }
    get('plant-latitude').value = latitude.toFixed(6);
    get('plant-longitude').value = longitude.toFixed(6);
  } catch (error) {
    if (session === sessionVersion) setFormError('plant-location-error', error.message);
  } finally {
    button.disabled = false;
  }
});

function plantLocationFields() {
  const latitude = get('plant-latitude').value === '' ? null : get('plant-latitude').valueAsNumber;
  const longitude = get('plant-longitude').value === '' ? null : get('plant-longitude').valueAsNumber;
  const radius = get('plant-radius').valueAsNumber;
  return { latitude, longitude, radius };
}

async function savePlantLocation(enabled, { latitude, longitude, radius }) {
  setFormError('plant-location-error');
  const validCenter = Number.isFinite(latitude) && Math.abs(latitude) <= 90 &&
    Number.isFinite(longitude) && Math.abs(longitude) <= 180;
  if ((!validCenter && (enabled || latitude !== null || longitude !== null)) ||
    !Number.isInteger(radius) || radius < 50 || radius > 5000) {
    setFormError('plant-location-error', 'Ingresá coordenadas válidas y un radio de 50 a 5000 metros.');
    return false;
  }
  const session = sessionVersion;
  const settings = { enabled, latitude, longitude, radius };
  try {
    await cloud.saveSetting('location', settings);
  } catch {
    if (session === sessionVersion && onPlantSettings()) setFormError('plant-location-error', 'No se pudo guardar la configuración de ubicación. Volvé a intentar.');
    return false;
  }
  if (session !== sessionVersion) return false;
  portalState.set('location', settings);
  if (!onPlantSettings()) return false;
  renderPlantLocation();
  return true;
}

plantLocationToggle.addEventListener('click', async () => {
  const submit = get('save-plant-location');
  if (!onPlantSettings() || !portalState.has('location') || submit.disabled) return;
  const settings = readPlantLocation();
  const enabled = !settings.enabled;
  plantLocationToggle.disabled = submit.disabled = true;
  try {
    if (await savePlantLocation(enabled, enabled ? plantLocationFields() : settings)) {
      showMessage(enabled ? 'Control de ubicación activado.' : 'Control de ubicación desactivado.');
    }
  } finally {
    plantLocationToggle.disabled = submit.disabled = false;
  }
});

handleForm('plant-location-form', 'plant-location-error', async () => {
  if (!onPlantSettings() || !portalState.has('location') || plantLocationToggle.disabled) return;
  plantLocationToggle.disabled = true;
  try {
    if (await savePlantLocation(readPlantLocation().enabled, plantLocationFields())) {
      showMessage('Configuración de ubicación guardada.');
    }
  } finally {
    plantLocationToggle.disabled = false;
  }
});

async function verifyPunchLocation() {
  if (!readPlantLocation().enabled) return true;
  const session = sessionVersion;
  checkingPunchLocation = true;
  punch.disabled = true;
  try {
    const position = await currentPosition();
    if (session !== sessionVersion || get('home').hidden) return false;
    const plant = readPlantLocation();
    if (!plant.enabled) return true;
    const distance = distanceToPlant(position, plant);
    if (Number.isFinite(distance) && distance > plant.radius) {
      showMessage('Estás fuera de la zona permitida para fichar.', true);
      return false;
    }
    if (!Number.isFinite(distance) || !Number.isFinite(position.accuracy) || distance + position.accuracy > plant.radius) {
      showMessage('No pudimos confirmar que estés dentro de la zona. Acercate al centro de planta y volvé a intentar.', true);
      return false;
    }
    return true;
  } catch (error) {
    if (session === sessionVersion && !get('home').hidden) showMessage(error.message, true);
    return false;
  } finally {
    checkingPunchLocation = false;
    refreshAttendanceView();
  }
}

async function canPunch() {
  if (account?.role !== 'worker' || get('home').hidden || punch.disabled || savingPunch) return false;
  if (!readPlantNetwork().enabled) return true;
  const session = sessionVersion;
  const check = ++connectionCheck;
  const button = get('check-plant-connection');
  punch.disabled = true;
  button.disabled = true;
  showPlantConnection('checking', 'Verificando red…');
  let ip;
  try {
    ip = await lookupPublicIPv4();
  } catch {
    // A failed lookup cannot authorize a punch when the restriction is active.
  } finally {
    punch.disabled = false;
  }
  if (session !== sessionVersion || get('home').hidden) return false;
  const config = readPlantNetwork();
  if (check === connectionCheck) {
    button.disabled = false;
    if (navigator.onLine === false) showPlantConnection('offline', 'Sin conexión a internet');
    else renderConnectionResult(ip, config.ip);
  }
  if (!config.enabled || (ip && ip === config.ip)) return true;
  showMessage(ip ? 'Para fichar, conectate a la red de planta.' : 'No pudimos verificar la red de planta. Revisá tu conexión y volvé a intentar.', true);
  return false;
}

punch.addEventListener('click', async () => {
  if (punchDialog.open || !(await canPunch()) || punchDialog.open) return;
  const date = plantDay(new Date());
  const current = shiftSummary(loadMarks(account.username), date);
  const type = current.state === 'open' ? 'out' : 'in';
  pendingPunch = { username: account.username, type, date };
  const action = type === 'in' ? 'entrada' : 'salida';
  get('punch-dialog-title').textContent = `¿Confirmás tu ${action}?`;
  get('punch-dialog-message').textContent = `Tu ${action} se registrará con la hora de planta al confirmar.`;
  get('confirm-punch').textContent = `Confirmar ${action}`;
  punchDialog.showModal();
});

get('cancel-punch').addEventListener('click', () => punchDialog.close());

get('punch-confirmation').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!punchDialog.open) return;
  punchDialog.close();
  const request = pendingPunch;
  const networkBefore = readPlantNetwork();
  if (!request || !(await canPunch()) || !(await verifyPunchLocation()) ||
    request !== pendingPunch || request.username !== account?.username || get('home').hidden) return;
  pendingPunch = undefined;
  const networkNow = readPlantNetwork();
  if (networkNow.enabled && (!networkBefore.enabled || networkNow.ip !== networkBefore.ip)) {
    showMessage('Cambió el control de red. Volvé a intentar la fichada.', true);
    return;
  }

  if (request.date !== plantDay(new Date())) {
    showMessage('Cambió la fecha. Volvé a abrir tu jornada.', true);
    return;
  }
  const session = sessionVersion;
  savingPunch = true;
  punch.disabled = true;
  try {
    const saved = await cloud.punch(request.username, request.date, request.type);
    if (session !== sessionVersion) return;
    if (saved) {
      setWorkerDay(request.date, await cloud.readDay(request.username, request.date), request.username);
      if (session === sessionVersion) showMessage(request.type === 'in' ? 'Entrada registrada.' : 'Salida registrada.');
    } else {
      showMessage('La jornada cambió. Revisá tus fichadas antes de volver a intentar.', true);
    }
  } catch {
    if (session === sessionVersion) showMessage('No pudimos confirmar la fichada. Revisá el estado antes de volver a intentar.', true);
  } finally {
    savingPunch = false;
    if (session === sessionVersion) refreshAttendanceView();
  }
});

function showView(view) {
  const employer = account?.role === 'employer';
  if (!account || !(employer ? employerViews : workerViews).includes(view)) return;
  if (view !== 'workers') {
    get('issued-code').hidden = true;
    get('issued-value').value = '';
  }
  for (const panel of new Set([...workerViews, ...employerViews])) get(panel).hidden = panel !== view;
  get('employer-back').hidden = !employer || view === 'menu';
  document.querySelectorAll('.nav-item').forEach((item) => {
    if (item.dataset.view === view) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  if (view === 'team') renderTeam();
  if (view === 'home') {
    for (const id of ['worker-day-intro', 'worker-clock', 'worker-day-marks']) get(id).hidden = employer;
    get('home-dashboard').classList.toggle('network-settings', employer);
    wifiToggle.hidden = get('plant-network-form').hidden = !employer;
    get('plant-location-form').hidden = !employer || !portalState.has('location');
    if (employer) fillPlantLocation();
    get('plant-ip').value = employer ? readPlantNetwork().ip ?? '' : '';
    setFormError('plant-network-error');
    renderPlantNetwork();
    if (!employer) {
      marks = loadMarks(account.username);
      renderShift(plantDay(new Date()));
      renderWorkerAssignment();
    }
  }
  if (view === 'profile') {
    renderEmployeeProfile();
    loadWorkerHistory();
  }
  if (view === 'menu') renderCorrectionCounter();
  if (view === 'corrections') renderEmployerCorrections();
  if (view === 'reports') openAttendanceReport();
  if (view === 'workers') renderWorkers();
  if (view === 'absences') {
    renderAbsenceWorkers();
    renderAbsenceNotices();
  }
  if (view === 'absence-summary') renderAbsenceReport();
  if (view === 'calendar') openFactoryCalendar();
  if (view === 'factory-hours') renderFactorySchedule();
  get(`${view}-title`).focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

viewButtons.forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));

function setWorkerDay(day, entries, uid) {
  if (account?.username !== uid) return;
  const old = loadOriginalMarks(uid).filter(({ at }) => plantDay(new Date(at)) !== day);
  portalMarks.set(uid, [...old, ...entries]);
}

function refreshAttendanceView() {
  if (!account) return;
  if (account.role === 'worker') {
    marks = loadMarks(account.username);
    renderShift(plantDay(new Date()));
    if (!get('profile').hidden) renderEmployeeProfile();
  } else {
    if (!get('team').hidden) renderTeam();
    if (!get('reports').hidden) renderAttendanceReport();
  }
}

async function loadWorkerDay(date) {
  if (account?.role !== 'worker' || !date) return;
  const uid = account.username;
  const session = sessionVersion;
  const data = await cloud.readDay(uid, date);
  if (session === sessionVersion) setWorkerDay(date, data, uid);
}

function loadWorkerHistory() {
  if (historyLoad || account?.role !== 'worker') return;
  const session = sessionVersion;
  const today = plantDay(new Date());
  const dates = Array.from({ length: 30 }, (_, index) => previousDay(today, index + 1));
  historyLoad = Promise.all(dates.map(loadWorkerDay)).then(() => {
    if (session === sessionVersion && !get('profile').hidden) renderEmployeeProfile();
  }).catch(() => {
    if (session === sessionVersion) {
      historyLoad = undefined;
      showMessage('No pudimos cargar todo el historial reciente. Volvé a abrir Mi perfil.', true);
    }
  });
}

function startPortalWatch() {
  stopPortal?.();
  const session = sessionVersion;
  const today = plantDay(new Date());
  loadedToday = today;
  stopPortal = cloud.watchPortal(account, today, (kind, value) => {
    if (session !== sessionVersion) return;
    if (kind === 'workerProfile' && (!value || value.archivedAt || value.disabled || value.mustChangePassword)) {
      leavePortal();
      cloud.logout().catch(() => {});
      setFormError('access-error', 'Tu acceso está suspendido. Consultá con Administración.');
      return;
    }
    const previous = portalState.get(kind);
    if (kind === 'attendance') {
      portalMarks.clear();
      for (const { uid, marks: batch } of value) portalMarks.set(uid, [...loadOriginalMarks(uid), ...batch]);
      attendanceReady = true;
    } else if (kind === 'today') {
      setWorkerDay(value.day, value.marks, account.username);
      attendanceReady = true;
    } else if (kind === 'staffSchedules') {
      portalState.set(kind, Object.fromEntries(value.map(({ id, ...profile }) => [id, profile])));
    } else {
      portalState.set(kind, value);
    }
    if (['today', 'attendance', 'staff', 'absences', 'corrections', 'schedule', 'staffSchedules', 'calendar'].includes(kind)) {
      refreshAttendanceView();
    }
    if (kind === 'network' && !get('home').hidden) {
      if (account.role === 'employer' && document.activeElement !== get('plant-ip')) get('plant-ip').value = value?.ip ?? '';
      renderPlantNetwork();
      if (account.role === 'worker') refreshAttendanceView();
    }
    if (kind === 'location' && !get('home').hidden) {
      if (account.role === 'employer' && get('plant-location-form').hidden) {
        fillPlantLocation();
        get('plant-location-form').hidden = false;
      }
      renderPlantLocation();
      refreshAttendanceView();
    }
    if (['schedule', 'staffSchedules'].includes(kind)) {
      if (account.role === 'worker' && !get('home').hidden) renderWorkerAssignment();
      if (!get('factory-hours').hidden) renderFactorySchedule();
    }
    if (['staff', 'staffSchedules'].includes(kind) && !get('workers').hidden) renderWorkers();
    if (kind === 'staff' && !get('reports').hidden) openAttendanceReport();
    if (kind === 'staff' && !get('absences').hidden) renderAbsenceWorkers();
    if (['staff', 'absenceNotices', 'absences'].includes(kind)) {
      renderNotifications();
      if (account.role === 'employer' && !get('absences').hidden) renderAbsenceNotices();
    }
    if (kind === 'absences' && account.role === 'employer' && !get('absences').hidden) renderAbsenceForm(false);
    if (['staff', 'absences'].includes(kind) && !get('absence-summary').hidden) renderAbsenceReport();
    if (kind === 'calendar' && !get('calendar').hidden) renderFactoryCalendar();
    if (kind === 'corrections') {
      renderCorrectionCounter();
      if (!get('corrections').hidden) renderEmployerCorrections();
      if (account.role === 'worker') {
        const known = new Map((previous ?? []).map(({ id, status }) => [id, status]));
        const changedDays = new Set(value.filter((item) => item.status === 'approved' && known.get(item.id) !== 'approved')
          .map((item) => item.date));
        if (changedDays.size) Promise.all([...changedDays].map(loadWorkerDay)).then(() => {
          if (session === sessionVersion) refreshAttendanceView();
        }).catch(() => {
          if (session === sessionVersion) showMessage('No pudimos cargar una fichada corregida.', true);
        });
      }
    }
  }, () => {
    if (session === sessionVersion) showMessage('No pudimos sincronizar todos los datos. Revisá la conexión.', true);
  });
}

function enterPortal(match) {
  if (match.mustChangePassword) {
    firstAccess = { uid: match.username, dni: match.dni, initialPassword: get('password').value };
    get('access-form').reset();
    showAccessActivation(true);
    get('activate-access-submit').disabled = false;
    return;
  }
  account = { ...match, initials: match.name.trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase(),
    detail: match.role === 'employer' ? 'Administración' : match.dni ? 'DNI ' + match.dni : 'Personal' };
  const employer = account.role === 'employer';
  get('access-form').reset();
  get('portal-label').textContent = employer ? 'Portal del empleador' : 'Portal del personal';
  get('identity-avatar').textContent = account.initials;
  get('identity-name').textContent = account.name;
  get('identity-detail').textContent = account.detail;
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.hidden = !(employer ? ['menu'] : workerViews).includes(item.dataset.view);
  });
  get('access').hidden = true;
  get('workspace').hidden = false;
  get('rail').hidden = false;
  startPortalWatch();
  showView(employer ? 'menu' : 'home');
}

get('forgot-password').addEventListener('click', async () => {
  const button = get('forgot-password');
  const email = get('username').value.trim();
  if (!cloud || button.disabled) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setFormError('access-error', 'Si entrás con DNI, pedile a Administración que restablezca tu clave. Para recuperar el acceso de empleador, ingresá tu correo y tocá esta opción.');
    return;
  }
  button.disabled = true;
  try {
    await cloud.recoverEmployer(email);
    showMessage('Si el correo corresponde a una cuenta, vas a recibir un enlace para cambiar la contraseña.');
  } catch (error) {
    if (error.code === 'auth/user-not-found') showMessage('Si el correo corresponde a una cuenta, vas a recibir un enlace para cambiar la contraseña.');
    else setFormError('access-error', 'No se pudo solicitar el correo. Volvé a intentar.');
  } finally {
    button.disabled = false;
  }
});

handleForm('access-form', 'access-error', async () => {
  if (!cloud || account) return;
  try {
    const match = await cloud.login(get('username').value.trim(), get('password').value);
    if (match) enterPortal(match);
    else setFormError('access-error', 'La cuenta todavía no está habilitada. Consultá con Administración.');
  } catch (error) {
    const invalid = ['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email'];
    const message = error.code === 'portal/worker-inactive'
      ? 'Tu acceso está suspendido. Consultá con Administración.'
      : invalid.includes(error.code) ? 'El usuario o la contraseña no coinciden.'
        : 'No pudimos iniciar sesión. Revisá la conexión y volvé a intentar.';
    setFormError('access-error', message);
  }
});

async function bootPortal() {
  const button = get('access-form').querySelector('button[type="submit"]');
  if (location.protocol === 'file:') {
    get('published-portal').hidden = false;
    setFormError('access-error', 'Abrí el portal publicado para iniciar sesión con Firebase.');
    return;
  }
  const code = new URLSearchParams(location.hash.slice(1)).get('reactivar');
  if (code) {
    activationCode = code;
    history.replaceState(null, '', location.pathname + location.search);
    showAccessActivation(true);
  }
  try {
    cloud = await import('./portal-firebase.js?v=sesion-1');
    if (activationCode) {
      get('activate-access-submit').disabled = false;
      return;
    }
    const match = await cloud.resume();
    if (match?.mustChangePassword) await cloud.logout();
    else if (match) enterPortal(match);
  } catch (error) {
    setFormError(activationCode ? 'activate-access-error' : 'access-error', error.code === 'portal/worker-inactive'
      ? 'Tu acceso está suspendido. Consultá con Administración.'
      : 'No pudimos conectar con el portal. Volvé a abrir el enlace para reintentar.');
  } finally {
    button.disabled = !cloud;
  }
}

let activationCode = '';
let firstAccess;
const resetRequests = new Map();

function validNewPassword(password) {
  return Array.from(password).length >= 8 && password.length <= 128 && /\p{Lu}/u.test(password) && /\d/.test(password);
}

function showAccessActivation(visible) {
  get('activate-access-title').textContent = firstAccess ? 'Elegí tu nueva contraseña' : 'Reactivar mi acceso';
  const dni = get('activate-access-dni');
  dni.readOnly = Boolean(firstAccess);
  dni.value = firstAccess?.dni ?? '';
  get('sign-in-content').hidden = visible;
  get('activate-access').hidden = !visible;
  get('access').setAttribute('aria-labelledby', visible ? 'activate-access-title' : 'access-title');
  get(visible ? firstAccess ? 'activate-access-password' : 'activate-access-dni' : 'username').focus();
}

get('activate-access-cancel').addEventListener('click', async () => {
  if (firstAccess) await cloud.logout().catch(() => {});
  firstAccess = undefined;
  activationCode = '';
  get('activate-access-form').reset();
  showAccessActivation(false);
});

handleForm('activate-access-form', 'activate-access-error', async () => {
  if (!cloud || (!activationCode && !firstAccess)) return;
  const dni = get('activate-access-dni').value.trim().replaceAll('.', '');
  const password = get('activate-access-password').value;
  if (!/^[0-9]{7,8}$/.test(dni)) {
    setFormError('activate-access-error', 'Ingresá un DNI de 7 u 8 dígitos.');
    return;
  }
  if (!validNewPassword(password)) {
    setFormError('activate-access-error', 'Usá al menos 8 caracteres, con letras, números y una mayúscula.');
    return;
  }
  if (password !== get('activate-access-repeat').value) {
    setFormError('activate-access-error', 'Las contraseñas nuevas no coinciden.');
    return;
  }
  const cancel = get('activate-access-cancel');
  cancel.disabled = true;
  try {
    if (firstAccess) {
      const match = await cloud.finishFirstAccess(firstAccess.uid, password, firstAccess.initialPassword);
      if (match?.mustChangePassword) throw new Error('El cambio no se confirmó.');
      firstAccess = undefined;
      get('activate-access-form').reset();
      showAccessActivation(false);
      if (match) {
        enterPortal(match);
        showMessage('Contraseña guardada.');
      } else {
        setFormError('access-error', 'Tu acceso está suspendido. Consultá con Administración.');
      }
      return;
    }
    if (!await cloud.activateAccess(dni, activationCode, password)) {
      setFormError('activate-access-error', 'El DNI no coincide con la cuenta del enlace.');
      return;
    }
    activationCode = '';
    get('activate-access-form').reset();
    showAccessActivation(false);
    get('username').value = dni;
    get('password').focus();
    showMessage('Acceso reactivado. Ingresá con tu nueva contraseña.');
  } catch (error) {
    const invalid = ['auth/expired-action-code', 'auth/invalid-action-code', 'auth/user-not-found'];
    setFormError('activate-access-error', error.code === 'portal/same-password'
      ? 'Elegí una contraseña distinta de la clave inicial.'
      : error.code === 'auth/requires-recent-login' ? 'Volvé al ingreso, iniciá sesión y elegí la nueva clave.'
      : invalid.includes(error.code)
      ? 'El enlace venció o ya fue usado. Pedile uno nuevo a Administración.'
      : 'No se pudo guardar la contraseña. Revisá la conexión y volvé a intentar.');
  } finally {
    cancel.disabled = false;
  }
});

const changePasswordDialog = get('password-change-dialog');
const changePasswordForm = get('password-change-form');
const savePasswordChange = get('save-password-change');
const cancelPasswordChange = get('cancel-password-change');

get('open-password-change').addEventListener('click', () => {
  if (account?.role !== 'worker' || changePasswordDialog.open || savePasswordChange.disabled) return;
  changePasswordForm.reset();
  setFormError('change-password-error');
  changePasswordDialog.showModal();
});
cancelPasswordChange.addEventListener('click', () => changePasswordDialog.close());
changePasswordDialog.addEventListener('cancel', (event) => {
  if (savePasswordChange.disabled) event.preventDefault();
});
changePasswordDialog.addEventListener('close', () => {
  changePasswordForm.reset();
  setFormError('change-password-error');
});

handleForm('password-change-form', 'change-password-error', async () => {
  if (account?.role !== 'worker' || !changePasswordDialog.open) return;
  const current = get('change-password-current').value;
  const next = get('change-password-new').value;
  if (!validNewPassword(next)) {
    setFormError('change-password-error', 'Usá al menos 8 caracteres, con letras, números y una mayúscula.');
    return;
  }
  if (next === current || next !== get('change-password-repeat').value) {
    setFormError('change-password-error', next === current
      ? 'Elegí una contraseña distinta de la actual.'
      : 'Las contraseñas nuevas no coinciden.');
    return;
  }
  const session = sessionVersion;
  cancelPasswordChange.disabled = true;
  try {
    await cloud.changePassword(account.username, current, next);
    if (session !== sessionVersion) return;
    changePasswordDialog.close();
    showMessage('Contraseña actualizada. Usá la nueva la próxima vez que ingreses.');
  } catch (error) {
    if (session !== sessionVersion) return;
    const messages = {
      'auth/invalid-credential': 'La contraseña actual no coincide.',
      'auth/wrong-password': 'La contraseña actual no coincide.',
      'auth/invalid-login-credentials': 'La contraseña actual no coincide.',
      'auth/requires-recent-login': 'Volvé a iniciar sesión y probá otra vez.',
      'auth/too-many-requests': 'Hubo demasiados intentos. Esperá un momento y volvé a probar.',
      'auth/network-request-failed': 'Se interrumpió la conexión. Si el cambio se guardó, usá la clave nueva al ingresar.',
      'portal/worker-inactive': 'Tu acceso está suspendido. Consultá con Administración.',
    };
    setFormError('change-password-error', messages[error.code] ?? 'No pudimos cambiar la contraseña. Volvé a intentar.');
  } finally {
    cancelPasswordChange.disabled = false;
  }
});

function renderAccessReset(uid) {
  const entry = resetRequests.get(uid);
  const result = get('reset-worker-result');
  const message = get('reset-worker-message');
  get('reset-worker-access').disabled = Boolean(entry?.pending);
  result.hidden = !entry?.link;
  get('reset-worker-link').value = entry?.link ?? '';
  message.textContent = entry?.message ?? '';
  message.hidden = !entry?.message;
}

function updateAccessReset(uid, entry, message) {
  if (resetRequests.get(uid) !== entry) return;
  entry.message = message;
  if (scheduleEditorWorker?.id === uid && get('schedule-dialog').open) renderAccessReset(uid);
}

get('reset-worker-access').addEventListener('click', async () => {
  const uid = scheduleEditorWorker?.id;
  if (!uid || account?.role !== 'employer' || !get('schedule-dialog').open || resetRequests.get(uid)?.pending) return;
  if (!staffDirectory().some((worker) => worker.id === uid && worker.active && !worker.disabled)) return;
  const contact = (portalState.get('staffRecoveryContacts') ?? []).find((item) => item.id === uid)?.email ?? '';
  if (get('profile-recovery-email').value.trim() !== contact) {
    resetRequests.set(uid, { message: 'Guardá el correo de recuperación antes de reiniciar el acceso.' });
    renderAccessReset(uid);
    return;
  }
  if (!await confirmAction('¿Reiniciar el acceso?', 'La contraseña actual dejará de funcionar.', 'Reiniciar acceso', true)) return;
  const entry = { pending: true, requestId: crypto.randomUUID() };
  resetRequests.set(uid, entry);
  updateAccessReset(uid, entry, 'Solicitando reinicio…');
  try {
    const keys = await crypto.subtle.generateKey({
      name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
    }, false, ['encrypt', 'decrypt']);
    const publicKey = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey))));
    if (resetRequests.get(uid) !== entry) return;
    if (!await cloud.requestAccessReset(uid, entry.requestId, publicKey)) {
      entry.pending = false;
      updateAccessReset(uid, entry, 'Ya hay un reinicio en curso para este empleado.');
      return;
    }
    if (resetRequests.get(uid) !== entry) return;
    updateAccessReset(uid, entry, 'Esperando que la PC de Administración procese el reinicio…');
    entry.stop = cloud.watchAccessReset(uid, async (data) => {
      if (resetRequests.get(uid) !== entry || data?.requestId !== entry.requestId || !entry.pending) return;
      if (data.status === 'failed') {
        entry.pending = false;
        entry.stop?.();
        updateAccessReset(uid, entry, 'No se pudo generar el enlace. Volvé a intentar.');
      } else if (data.status === 'ready') {
        entry.pending = false;
        entry.stop?.();
        try {
          const bytes = Uint8Array.from(atob(data.sealed), (character) => character.charCodeAt(0));
          const code = new TextDecoder().decode(await crypto.subtle.decrypt('RSA-OAEP', keys.privateKey, bytes));
          const link = new URL('./', location.href);
          link.hash = new URLSearchParams({ reactivar: code }).toString();
          entry.link = link.href;
          updateAccessReset(uid, entry, 'Copiá el enlace y compartilo en privado. Se puede usar una sola vez.');
        } catch {
          updateAccessReset(uid, entry, 'No pudimos abrir el enlace. Solicitá uno nuevo.');
        }
      }
    }, () => {
      entry.pending = false;
      updateAccessReset(uid, entry, 'Se interrumpió la conexión mientras esperábamos el reinicio.');
    });
  } catch {
    entry.pending = false;
    updateAccessReset(uid, entry, 'No se pudo solicitar el reinicio. Revisá la conexión.');
  }
});

get('copy-reset-worker-link').addEventListener('click', async () => {
  const field = get('reset-worker-link');
  if (!field.value) return;
  try {
    await navigator.clipboard.writeText(field.value);
    showMessage('Enlace copiado.');
  } catch {
    field.focus();
    field.select();
  }
});

function renderWorkers() {
  const profiles = readReportSetting(workerProfilesKey, {});
  const rows = staffDirectory().filter((worker) => worker.active).map((worker) => {
    const row = document.createElement('li');
    row.className = 'worker-row';
    row.innerHTML = '<div><button type="button" class="worker-profile-link"><strong></strong><small></small></button></div><span class="team-status"></span>';
    const profile = row.querySelector('.worker-profile-link');
    profile.querySelector('strong').textContent = worker.name;
    const position = profiles[worker.id]?.position;
    profile.querySelector('small').textContent = position ? `${worker.label} · ${position}` : worker.label;
    profile.setAttribute('aria-label', `Editar el perfil de ${worker.name}`);
    profile.setAttribute('aria-haspopup', 'dialog');
    const status = row.querySelector('.team-status');
    status.dataset.state = worker.disabled ? 'waiting' : 'open';
    status.textContent = worker.disabled ? 'Desactivada' : 'Activa';
    profile.addEventListener('click', () => openScheduleEditor(worker, status.textContent));
    return row;
  });
  get('workers-list').replaceChildren(...rows);
}

get('toggle-worker-access').addEventListener('click', async () => {
  const target = scheduleEditorWorker;
  const dialog = get('schedule-dialog');
  const button = get('toggle-worker-access');
  if (account?.role !== 'employer' || !target || !dialog.open || button.disabled) return;
  const worker = staffDirectory().find((item) => item.id === target.id && item.active);
  if (!worker) return;
  const disabled = !worker.disabled;
  const action = disabled ? 'Desactivar' : 'Reactivar';
  const message = disabled ? 'El empleado perderá el acceso hasta que lo reactives.' : 'El empleado podrá volver a iniciar sesión.';
  if (!await confirmAction(`¿${action} el acceso de ${worker.name}?`, message, `${action} acceso`, disabled)) return;
  const session = sessionVersion;
  button.disabled = true;
  setFormError('archive-worker-error');
  try {
    await cloud.setWorkerDisabled(worker.id, disabled);
    if (session !== sessionVersion) return;
    if (scheduleEditorWorker === target) dialog.close();
    showMessage(disabled ? 'Acceso desactivado.' : 'Acceso reactivado.');
  } catch {
    if (session === sessionVersion && scheduleEditorWorker === target) {
      setFormError('archive-worker-error', 'No se pudo cambiar el acceso. Revisá la conexión.');
    }
  } finally {
    button.disabled = false;
  }
});

get('archive-worker').addEventListener('click', async () => {
  const target = scheduleEditorWorker;
  const dialog = get('schedule-dialog');
  const button = get('archive-worker');
  if (account?.role !== 'employer' || !target || !dialog.open || button.disabled) return;
  if (!await confirmAction(`¿Dar de baja a ${target.name}?`, 'Perderá el acceso al portal. Sus fichadas se conservarán.', 'Dar de baja', true)) return;

  const session = sessionVersion;
  button.disabled = true;
  setFormError('archive-worker-error');
  try {
    await cloud.archiveWorker(target.id);
    if (session !== sessionVersion) return;
    if (scheduleEditorWorker === target) dialog.close();
    showMessage(`${target.name} fue dado de baja.`);
  } catch {
    if (session === sessionVersion && scheduleEditorWorker === target) {
      setFormError('archive-worker-error', 'No se pudo confirmar la baja. Revisá la conexión y volvé a intentar.');
    }
  } finally {
    button.disabled = false;
  }
});

handleForm('worker-form', 'worker-error', async () => {
  if (account?.role !== 'employer' || get('worker-add').hidden) return;
  const first = get('worker-first').value.trim();
  const last = get('worker-last').value.trim();
  const dni = get('worker-dni').value;
  if (!first || !last || !/^[0-9]{7,8}$/.test(dni)) {
    setFormError('worker-error', 'Completá el nombre, el apellido y un DNI de 7 u 8 números.');
    return;
  }
  const name = first + ' ' + last;
  if (name.length > 120) {
    setFormError('worker-error', 'El nombre completo puede tener hasta 120 caracteres.');
    return;
  }
  if (workerDraft && (workerDraft.dni !== dni || workerDraft.name !== name)) {
    setFormError('worker-error', 'Terminá el alta pendiente con el mismo nombre y DNI.');
    return;
  }
  const draft = workerDraft ??= {
    dni, name, employer: account.username, createdOn: plantDay(new Date()),
    password: 'Aa7' + hex(crypto.getRandomValues(new Uint8Array(9))),
  };
  const session = sessionVersion;
  try {
    const created = await cloud.createWorker(draft);
    if (session !== sessionVersion) return;
    const staff = (portalState.get('staff') ?? []).filter((item) => item.id !== created.id);
    portalState.set('staff', [...staff, created]);
    workerDraft = undefined;
    get('issued-name').textContent = 'Clave inicial de ' + name;
    get('issued-value').value = draft.password;
    get('issued-code').hidden = false;
    get('worker-form').reset();
    showView('workers');
    get('issued-code').focus();
  } catch (error) {
    if (session !== sessionVersion) return;
    if (!draft.uid && !draft.uncertain) workerDraft = undefined;
    setFormError('worker-error', error.code === 'auth/email-already-in-use' && !draft.uncertain
      ? 'Ya existe una cuenta con ese DNI.'
      : 'No se pudo confirmar el alta. Volvé a intentar desde esta pestaña.');
  }
});

get('copy-issued-password').addEventListener('click', async () => {
  const output = get('issued-value');
  if (!output.value) return;
  try {
    await navigator.clipboard.writeText(output.value);
    showMessage('Clave copiada.');
  } catch {
    const range = document.createRange();
    range.selectNodeContents(output);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
});

function renderAbsenceWorkers(selectMatch = false) {
  const select = get('absence-worker');
  const selected = select.value;
  const query = get('absence-search').value.trim();
  const staff = staffDirectory().filter((worker) => worker.active && matchesWorker(worker, query));
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = staff.length ? 'Seleccioná un empleado' : 'Sin coincidencias';
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

function renderAbsenceForm(updateFields = true) {
  const workerId = get('absence-worker').value;
  const date = get('absence-date').value;
  const absences = readAbsences().filter((absence) => absence.workerId === workerId);
  const existing = absences.find((absence) => absence.date === date);
  if (updateFields !== false) {
    get('absence-reason').value = existing?.reason || '';
    get('absence-end').value = '';
    get('absence-from-time').value = existing?.fromTime ?? '';
    get('absence-to-time').value = existing?.toTime ?? '';
    renderPermissionHours();
    get('absence-note').value = existing?.note || '';
    get('absence-certificate').checked = Boolean(existing?.certificate);
    get('absence-save').textContent = existing ? 'Guardar cambios' : 'Guardar novedad';
    setFormError('absence-error');
  }
  const empty = get('absence-empty');
  empty.textContent = workerId ? 'Esta persona todavía no tiene novedades registradas.' : 'Seleccioná un empleado para consultar sus novedades.';
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
    row.querySelector('small').textContent = absence.fromTime ? `${absence.fromTime} a ${absence.toTime}`
      : absence.certificate ? 'Certificado presentado' : '';
    const note = row.querySelector('p');
    note.textContent = absence.note;
    note.hidden = !absence.note;
    const edit = row.querySelector('button');
    edit.setAttribute('aria-label', `Editar novedad del ${dateLabel}`);
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
    const name = worker?.name || `Empleado ${workerId}`;
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
      showView('absences');
      get('absence-worker').value = workerId;
      get('absence-date').value = group.latest;
      renderAbsenceForm();
      get('absence-list-title').focus();
    });
    return row;
  });
  get('month-workers').replaceChildren(...rows);
}

get('absence-month-help').hidden = get('absence-month').type === 'month';
get('absence-month').addEventListener('change', () => {
  const filter = get('absence-month');
  if (!filter.validity.valid) filter.value = displayedDay.slice(0, 7);
  renderAbsenceReport();
});

get('absence-search').addEventListener('input', () => renderAbsenceWorkers(true));
get('absence-worker').addEventListener('change', renderAbsenceForm);
get('absence-date').addEventListener('change', renderAbsenceForm);
get('absence-reason').addEventListener('change', renderPermissionHours);

function renderPermissionHours() {
  const hours = get('absence-permission-hours');
  hours.disabled = hours.hidden = get('absence-reason').value !== 'permission';
}

const notificationsDialog = get('notifications-dialog');
const absenceNoticeDialog = get('absence-notice-dialog');

function noticeDate(date) {
  return shortDateFormat.format(new Date(date + 'T12:00:00-03:00'));
}

function notificationItems() {
  const notices = portalState.get('absenceNotices') ?? [];
  if (account?.role === 'employer') {
    const names = new Map(staffDirectory().map(({ id, name }) => [id, name]));
    return notices.filter(({ status }) => status === 'pending').map((item) => ({
      key: 'notice:' + item.id, date: item.date,
      title: (names.get(item.workerId) ?? 'Empleado') + ' avisó una ausencia',
    }));
  }
  return [
    ...readAbsences().map((item) => ({
      key: 'novelty:' + item.id + ':' + item.updatedAt?.toMillis(), date: item.date,
      title: 'Novedad de Administración: ' + absenceReasons.get(item.reason),
      detail: item.fromTime ? item.fromTime + ' a ' + item.toTime : '',
    })),
    ...notices.map((item) => ({
      key: 'response:' + item.id + ':' + item.status, date: item.date,
      title: { accepted: 'Aviso de ausencia registrado', rejected: 'Aviso de ausencia rechazado', pending: 'Aviso de ausencia pendiente' }[item.status],
    })),
  ];
}

function renderNotifications() {
  const items = notificationItems().sort((a, b) => b.date.localeCompare(a.date));
  if (notificationsDialog.open) items.forEach(({ key }) => seenNotifications.add(key));
  const unread = items.filter(({ key }) => !seenNotifications.has(key)).length;
  const count = get('notification-count');
  count.hidden = unread === 0;
  count.textContent = unread > 99 ? '99+' : String(unread);
  get('open-notifications').setAttribute('aria-label', unread ? `Notificaciones: ${unread} nuevas` : 'Notificaciones');
  get('notifications-empty').hidden = items.length > 0;
  get('view-notice-inbox').hidden = account?.role !== 'employer';
  get('notifications-list').replaceChildren(...items.map(({ title, date, detail }) => {
    const row = document.createElement('li');
    row.className = 'worker-row absence-row';
    const copy = document.createElement('div');
    const heading = document.createElement('strong');
    heading.textContent = title;
    const day = document.createElement('small');
    day.textContent = [noticeDate(date), detail].filter(Boolean).join(' · ');
    copy.append(heading, day);
    row.append(copy);
    return row;
  }));
}

get('open-notifications').addEventListener('click', () => {
  if (!account || notificationsDialog.open) return;
  notificationsDialog.showModal();
  renderNotifications();
});
get('close-notifications').addEventListener('click', () => notificationsDialog.close());
get('view-notice-inbox').addEventListener('click', () => {
  notificationsDialog.close();
  showView('absences');
});

get('open-absence-notice').addEventListener('click', () => {
  if (account?.role !== 'worker' || absenceNoticeDialog.open) return;
  get('absence-notice-form').reset();
  setFormError('absence-notice-error');
  get('absence-notice-date').value = plantDay(new Date());
  absenceNoticeDialog.showModal();
});
get('cancel-absence-notice').addEventListener('click', () => absenceNoticeDialog.close());
handleForm('absence-notice-form', 'absence-notice-error', async () => {
  if (account?.role !== 'worker' || !absenceNoticeDialog.open) return;
  const date = get('absence-notice-date').value;
  const reason = get('absence-notice-reason').value;
  const note = get('absence-notice-note').value.trim();
  const session = sessionVersion;
  const sent = await cloud.sendAbsenceNotice(account.username, date, reason, note);
  if (session !== sessionVersion) return;
  if (!sent) {
    setFormError('absence-notice-error', 'Ya enviaste un aviso para esa fecha.');
    return;
  }
  absenceNoticeDialog.close();
  showMessage('Aviso enviado a Administración.');
});

function renderAbsenceNotices() {
  const pending = (portalState.get('absenceNotices') ?? []).filter((item) => item.status === 'pending')
    .sort((a, b) => a.date.localeCompare(b.date));
  const staff = new Map(staffDirectory().map(({ id, name }) => [id, name]));
  get('absence-notices-empty').hidden = pending.length > 0;
  get('absence-notices-list').replaceChildren(...pending.map((item) => {
    const row = document.createElement('li');
    row.className = 'worker-row absence-row';
    const copy = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = staff.get(item.workerId) ?? 'Empleado';
    const description = document.createElement('small');
    description.textContent = noticeDate(item.date) + ' · ' + absenceReasons.get(item.reason);
    const note = document.createElement('p');
    note.textContent = item.note;
    copy.append(name, description, note);
    const actions = document.createElement('div');
    actions.className = 'section-links';
    for (const [status, label] of [['accepted', 'Registrar'], ['rejected', 'Rechazar']]) {
      const button = document.createElement('button');
      button.className = 'report-button';
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', async () => {
        if (account?.role !== 'employer') return;
        if (status === 'rejected' && !await confirmAction('¿Rechazar este aviso de ausencia?', '', 'Rechazar aviso', true)) return;
        const session = sessionVersion;
        for (const control of actions.children) control.disabled = true;
        try {
          const result = await cloud.reviewAbsenceNotice(item, status);
          if (session !== sessionVersion) return;
          if (result === 'saved' && get('absence-worker').value === item.workerId && get('absence-date').value === item.date) {
            renderAbsenceForm();
          }
          showMessage(result === 'reviewed' ? 'El aviso ya fue revisado.' : 'Aviso revisado. El empleado recibirá una notificación.');
        } catch {
          if (session === sessionVersion) showMessage('No se pudo revisar el aviso. Volvé a intentar.', true);
        } finally {
          for (const control of actions.children) control.disabled = false;
        }
      });
      actions.append(button);
    }
    row.append(copy, actions);
    return row;
  }));
}

handleForm('absence-form', 'absence-error', async () => {
  if (account?.role !== 'employer' || get('absences').hidden) return;
  const workerId = get('absence-worker').value;
  const date = get('absence-date').value;
  const reason = get('absence-reason').value;
  if (!staffDirectory().some((worker) => worker.id === workerId) || !date || !get('absence-date').validity.valid || !absenceReasons.has(reason)) {
    setFormError('absence-error', 'Seleccioná un empleado, una fecha y un motivo.');
    return;
  }

  const dates = reportDates(date, get('absence-end').value || date);
  if (!dates.length || dates.length > 90) {
    setFormError('absence-error', 'Elegí un período válido de hasta 90 días.');
    return;
  }
  const novelty = { reason, note: get('absence-note').value.trim(), certificate: get('absence-certificate').checked };
  const fromTime = get('absence-from-time').value;
  const toTime = get('absence-to-time').value;
  if (reason === 'permission' && (fromTime || toTime)) {
    if (!fromTime || !toTime || fromTime >= toTime) {
      setFormError('absence-error', 'Completá el horario del permiso con un inicio y un fin posterior.');
      return;
    }
    Object.assign(novelty, { fromTime, toTime });
  }
  const conflicts = readAbsences().some((item) => item.workerId === workerId && dates.includes(item.date));
  if (dates.length > 1 && conflicts && !await confirmAction('¿Reemplazar las novedades?', 'El período incluye novedades ya registradas.', 'Reemplazar', true)) return;
  const session = sessionVersion;
  await cloud.saveNovelties(workerId, dates, novelty);
  if (session !== sessionVersion) return;
  if (!get('absences').hidden && get('absence-worker').value === workerId) renderAbsenceForm();
  showMessage('Novedad guardada. El empleado podrá verla en su campana.');
});

function leavePortal() {
  sessionVersion++;
  if (actionConfirmation.open) actionConfirmation.close('cancel');
  stopPortal?.();
  stopPortal = undefined;
  portalState.clear();
  portalMarks.clear();
  workerDraft = undefined;
  historyLoad = undefined;
  attendanceReady = false;
  account = null;
  marks = [];
  pendingPunch = undefined;
  if (punchDialog.open) punchDialog.close();
  if (notificationsDialog.open) notificationsDialog.close();
  if (absenceNoticeDialog.open) absenceNoticeDialog.close();
  seenNotifications.clear();
  get('notification-count').hidden = true;
  if (changePasswordDialog.open) changePasswordDialog.close();
  changePasswordForm.reset();
  for (const reset of resetRequests.values()) reset.stop?.();
  resetRequests.clear();
  renderAccessReset();
  clearTimeout(toastTimer);
  get('toast').hidden = true;
  get('announcement').textContent = '';
  get('workspace').hidden = true;
  get('rail').hidden = true;
  get('team-date').value = displayedDay;
  get('team-search').value = '';
  teamStatus = '';
  get('worker-form').reset();
  get('absence-form').reset();
  get('absence-date').value = plantDay(new Date());
  get('absence-list').replaceChildren();
  get('absence-month').value = displayedDay.slice(0, 7);
  get('month-workers').replaceChildren();
  setFormError('worker-error');
  get('issued-value').value = '';
  get('issued-code').hidden = true;
  get('access').hidden = false;
  get('access-title').focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

get('sign-out').addEventListener('click', async () => {
  if (!account) return;
  try { await cloud.logout(); }
  catch { showMessage('No pudimos cerrar la sesión. Volvé a intentar.', true); return; }
  leavePortal();
});

get('team-date').addEventListener('change', () => {
  const filter = get('team-date');
  if (!filter.validity.valid) filter.value = displayedDay;
  renderTeam();
});
get('team-search').addEventListener('input', () => renderTeam());
teamStatusButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const status = button.dataset.teamStatus;
    teamStatus = teamStatus === status ? '' : status;
    renderTeam();
  });
});
get('clear-team-status').addEventListener('click', () => {
  const selected = Array.from(teamStatusButtons).find((button) => button.dataset.teamStatus === teamStatus);
  teamStatus = '';
  renderTeam();
  selected?.focus();
});

updateClock();
setInterval(() => {
  updateClock();
  if (account?.role === 'worker' && loadedToday !== displayedDay) {
    attendanceReady = false;
    refreshAttendanceView();
    startPortalWatch();
  }
}, 1000);
bootPortal();
