const reportSettingsKey = 'schedule';
const workerProfilesKey = 'staffSchedules';
const factoryCalendarKey = 'calendar';
const defaultSchedule = { start: '08:00', end: '16:00', grace: 0, days: [1, 2, 3, 4, 5] };
const weekdayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const weekdaysInOrder = [1, 2, 3, 4, 5, 6, 0];
const closureTypes = { holiday: 'Feriado', vacation: 'Vacaciones de fábrica', shutdown: 'Cierre de fábrica' };
const reportIndicators = {
  normal: 'Horario normal', late: 'Tardanza', absent: 'Falta', review: 'Revisar fichadas',
  pending: 'Pendiente', closure: 'Feriado o cierre', extra: 'Fuera de jornada',
};
const dateForReport = new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
let displayedReport;
let editingClosure;
let scheduleEditorWorker;
let personalScheduleDraft;

function readReportSetting(key, fallback) {
  return portalState.get(key) ?? fallback;
}

function reportDate(day) {
  return dateForReport.format(new Date(`${day}T12:00:00Z`));
}

function minuteOfDay(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function selectedAttendanceRange() {
  const period = get('report-period').value;
  if (period === 'custom') return [get('report-from').value, get('report-to').value];
  const month = get('report-month').value;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return [];
  const last = new Date(`${month}-01T12:00:00Z`);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  const end = last.toISOString().slice(0, 10);
  if (period === 'month') return [`${month}-01`, end];
  return get('report-half').value === 'first' ? [`${month}-01`, `${month}-15`] : [`${month}-16`, end];
}

function reportDates(from, to) {
  const isoDay = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoDay.test(from) || !isoDay.test(to) || from > to) return [];
  const days = [];
  for (let day = from; day <= to && days.length <= 366; day = previousDay(day, -1)) {
    days.push(day);
    if (day === to) break;
  }
  return days;
}

function scheduleGroups(schedule) {
  const groups = new Map();
  for (const day of weekdaysInOrder) {
    if (!schedule.days.includes(day)) continue;
    const { start, end } = schedule.overrides?.[day] ?? schedule;
    const key = `${start}-${end}`;
    if (!groups.has(key)) groups.set(key, { start, end, days: [] });
    groups.get(key).days.push(day);
  }
  return Array.from(groups.values());
}

function describeSchedule(schedule) {
  const hours = scheduleGroups(schedule).map(({ days, start, end }) => `${days.map((day) => weekdayNames[day]).join(', ')} ${start} a ${end}`);
  return `${hours.join(' · ')} · Tolerancia ${schedule.grace} min`;
}

function renderWorkerAssignment(now = new Date()) {
  const profile = readReportSetting(workerProfilesKey, {})[account.username];
  const schedule = profile?.schedule ?? readReportSetting(reportSettingsKey, defaultSchedule);
  const source = profile?.schedule ? 'Horario propio' : 'Horario general';
  const day = plantDay(now);
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const { start, end } = schedule.overrides?.[weekday] ?? schedule;
  const date = get('worker-assignment-date');
  date.dateTime = day;
  date.textContent = longDateFormat.format(now);
  const hours = schedule.days.includes(weekday) ? `${start} a ${end} · ${source}` : 'Día sin horario asignado';
  get('worker-assignment').textContent = hours;
}

function renderEmployeeProfile() {
  const profile = readReportSetting(workerProfilesKey, {})[account.username];
  const schedule = profile?.schedule ?? readReportSetting(reportSettingsKey, defaultSchedule);
  const source = profile?.schedule ? 'Horario propio' : 'Horario general';
  get('employee-profile-name').textContent = account.name;
  get('employee-profile-detail').textContent = [account.detail, profile?.position].filter(Boolean).join(' · ');
  get('employee-profile-schedule').textContent = `${source} · ${describeSchedule(schedule)}`;
  recordList(get('history-list'), loadMarks(account.username));
  renderEmployeeCorrections();
}

function updateScheduleGroupLabels() {
  const groups = Array.from(get('schedule-groups').children);
  groups.forEach((group, index) => {
    group.querySelector('legend').textContent = `Horario ${index + 1}`;
    const remove = group.querySelector('.remove-schedule-group');
    remove.hidden = groups.length === 1;
    remove.setAttribute('aria-label', `Quitar horario ${index + 1}`);
  });
}

function appendScheduleGroup({ days = [], start = '', end = '' } = {}) {
  const group = get('schedule-group-template').content.firstElementChild.cloneNode(true);
  group.querySelector('[name="group-start"]').value = start;
  group.querySelector('[name="group-end"]').value = end;
  group.querySelectorAll('[name="workday"]').forEach((input) => {
    input.checked = days.includes(Number(input.value));
  });
  group.querySelector('.remove-schedule-group').addEventListener('click', () => {
    group.remove();
    updateScheduleGroupLabels();
    get('add-schedule-group').focus();
  });
  get('schedule-groups').append(group);
  updateScheduleGroupLabels();
  return group;
}

function setScheduleHours(schedule) {
  const hours = get('schedule-hours');
  hours.hidden = !schedule;
  hours.disabled = !schedule;
  get('schedule-groups').replaceChildren();
  if (schedule) {
    const groups = scheduleGroups(schedule);
    if (groups.length) groups.forEach(appendScheduleGroup);
    else appendScheduleGroup();
    get('schedule-grace').value = schedule.grace;
  }
  get('assign-schedule').hidden = Boolean(schedule);
  get('inherit-schedule').hidden = !scheduleEditorWorker || (!schedule && !personalScheduleDraft);
}

function updateProfileScheduleSummary() {
  const general = readReportSetting(reportSettingsKey, defaultSchedule);
  const source = personalScheduleDraft ? 'Horario propio' : 'Horario general';
  get('profile-schedule-summary').textContent = `${source} · ${describeSchedule(personalScheduleDraft ?? general)}`;
  get('assign-schedule').textContent = personalScheduleDraft ? 'Editar horario propio' : 'Asignar horario';
}

function openScheduleEditor(worker = null, status = '') {
  if (account?.role !== 'employer' || get('schedule-dialog').open) return;
  if (worker && !portalState.has('staffRecoveryContacts')) {
    showMessage('Todavía estamos cargando el perfil. Volvé a intentar.', true);
    return;
  }
  scheduleEditorWorker = worker ? { ...worker } : null;
  setFormError('schedule-editor-error');
  const profileFields = get('schedule-profile-fields');
  profileFields.hidden = !worker;
  profileFields.disabled = !worker;
  if (worker) {
    const profile = readReportSetting(workerProfilesKey, {})[worker.id];
    personalScheduleDraft = profile?.schedule ?? null;
    get('schedule-dialog-title').textContent = worker.name;
    get('schedule-profile-id').textContent = worker.label;
    get('schedule-profile-status').textContent = status;
    get('profile-position').value = profile?.position ?? '';
    get('profile-recovery-email').value = (portalState.get('staffRecoveryContacts') ?? [])
      .find((contact) => contact.id === worker.id)?.email ?? '';
    get('save-schedule').textContent = 'Guardar perfil';
    updateProfileScheduleSummary();
    setScheduleHours(null);
  } else {
    get('schedule-dialog-title').textContent = 'Horario general de fábrica';
    get('save-schedule').textContent = 'Guardar horario';
    setScheduleHours(readReportSetting(reportSettingsKey, defaultSchedule));
  }
  renderAccessReset(worker?.id);
  get('schedule-dialog').showModal();
}

function readScheduleGroups() {
  const days = [];
  const overrides = {};
  let base;
  const grace = Number(get('schedule-grace').value);
  for (const [index, group] of Array.from(get('schedule-groups').children).entries()) {
    const start = group.querySelector('[name="group-start"]').value;
    const end = group.querySelector('[name="group-end"]').value;
    const selected = Array.from(group.querySelectorAll('[name="workday"]:checked'), (input) => Number(input.value));
    if (!selected.length || !start || !end || start >= end) {
      setFormError('schedule-editor-error', `En el horario ${index + 1}, marcá al menos un día e ingresá una entrada y salida en orden, dentro del mismo día.`);
      return null;
    }
    const repeated = selected.find((day) => days.includes(day));
    if (repeated !== undefined) {
      setFormError('schedule-editor-error', `${weekdayNames[repeated]} aparece en más de un horario. Elegí en cuál querés dejarlo.`);
      return null;
    }
    if (!base) base = { start, end };
    else if (start !== base.start || end !== base.end) selected.forEach((day) => { overrides[day] = { start, end }; });
    days.push(...selected);
  }
  return base ? { ...base, grace, days, overrides } : null;
}

function attendanceDay({ day, worker, marksForDay, absence, closure, scheduled, today, nowTime, schedule }) {
  const entry = marksForDay.find(({ type }) => type === 'in');
  const exit = marksForDay.findLast(({ type }) => type === 'out');
  const notes = [];
  if (marksForDay.some((mark) => mark.correctionId && !mark.manual)) notes.push('Incluye una corrección aprobada');
  if (marksForDay.some((mark) => mark.manual)) notes.push('Incluye un ajuste manual');
  let status;
  if (absence) {
    notes.push(`Aviso: ${absenceReasons.get(absence.reason)}${absence.certificate ? ' · Certificado presentado' : ''}`);
    if (absence.note) notes.push(absence.note);
  }
  if (closure) {
    status = 'closure';
    notes.push(closureTypes[closure.type]);
    if (closure.note) notes.push(closure.note);
    if (marksForDay.length) notes.push('Hay fichadas durante el cierre');
  } else if (!scheduled) {
    status = 'extra';
  } else if (!marksForDay.length) {
    const ended = day < today || (day === today && nowTime >= schedule.end);
    status = ended ? 'absent' : 'pending';
  } else {
    const late = entry && minuteOfDay(markTime(entry)) > minuteOfDay(schedule.start) + schedule.grace;
    const complete = marksForDay.every(({ type }, index) => type === (index % 2 === 0 ? 'in' : 'out')) && marksForDay.length % 2 === 0;
    const early = complete && markTime(exit) < schedule.end;
    const inProgress = day === today && nowTime < schedule.end && marksForDay.at(-1).type === 'in';
    if (!complete) notes.push(inProgress ? 'Jornada en curso' : 'Fichadas incompletas');
    if (early) notes.push('Salida antes del horario previsto');
    if (late) status = 'late';
    else if (inProgress) status = 'pending';
    else status = complete && !early ? 'normal' : 'review';
  }
  return { day, worker, schedule, entry: entry ? markTime(entry) : '', exit: exit ? markTime(exit) : '', status, note: notes.join(' · ') };
}

function buildAttendanceReport(days, workerId, now = new Date()) {
  const from = days[0];
  const to = days.at(-1);
  const today = plantDay(now);
  const generalSchedule = readReportSetting(reportSettingsKey, defaultSchedule);
  const profiles = readReportSetting(workerProfilesKey, {});
  const closures = readReportSetting(factoryCalendarKey, []).filter((item) => item.from <= to && item.to >= from);
  const absences = new Map(readAbsences().map((absence) => [`${absence.workerId}/${absence.date}`, absence]));
  const staff = staffDirectory().filter((worker) => !workerId || worker.id === workerId).map((worker) => {
    const profile = profiles[worker.id];
    return { ...worker, position: profile?.position, schedule: profile?.schedule ?? generalSchedule, personalSchedule: Boolean(profile?.schedule) };
  });
  const totals = Object.fromEntries(Object.keys(reportIndicators).map((status) => [status, 0]));
  const nowTime = timeFormat.format(now);
  const rows = [];
  for (const worker of staff) {
    const { schedule } = worker;
    const marksByDate = new Map();
    const marks = loadMarks(worker.id, now);
    let coverage = worker.createdOn || (worker.entry ? previousDay(today, 3) : today);
    for (const mark of marks) {
      const day = plantDay(new Date(mark.at));
      if (!worker.createdOn && day < coverage) coverage = day;
      if (!marksByDate.has(day)) marksByDate.set(day, []);
      marksByDate.get(day).push(mark);
    }
    for (const day of days) {
      const absence = absences.get(`${worker.id}/${day}`);
      const closure = closures.find((item) => item.from <= day && item.to >= day);
      const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
      const scheduled = schedule.days.includes(weekday) && ((worker.active && day >= coverage) || Boolean(absence));
      const marksForDay = worker.entry && closure ? (marksByDate.get(day) || []).filter((mark) => mark.correctionId) : marksByDate.get(day) || [];
      if (!scheduled && !marksForDay.length && !absence) continue;
      const sorted = marksForDay.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const daySchedule = schedule.overrides?.[weekday] ? { ...schedule, ...schedule.overrides[weekday] } : schedule;
      const row = attendanceDay({ day, worker, marksForDay: sorted, absence, closure, scheduled, today, nowTime, schedule: daySchedule });
      rows.push(row);
      totals[row.status] += 1;
    }
  }
  rows.sort((a, b) => a.day.localeCompare(b.day) || a.worker.name.localeCompare(b.worker.name, 'es-AR'));
  return { from, to, workerId, scope: workerId ? staff[0]?.name : 'Todo el personal', generalSchedule, staff, rows, totals, closures };
}

function reportScheduleLine(report) {
  const worker = report.workerId ? report.staff[0] : null;
  if (worker) return `${worker.personalSchedule ? 'Horario propio' : 'Horario general'} · ${describeSchedule(worker.schedule)}`;
  return `Horario general · ${describeSchedule(report.generalSchedule)} · Se aplican los horarios propios asignados`;
}

function renderAttendanceReport() {
  if (account?.role !== 'employer' || get('reports').hidden) return;
  if (!attendanceReady || !['staff', 'absences', 'calendar', 'schedule', 'staffSchedules', 'corrections'].every((key) => portalState.has(key))) {
    displayedReport = undefined;
    setFormError('report-error', 'Cargando los datos de asistencia…');
    get('export-attendance-xlsx').disabled = true;
    get('export-attendance-pdf').disabled = true;
    return;
  }
  const days = reportDates(...selectedAttendanceRange());
  if (!days.length || days.length > 366) {
    setFormError('report-error', 'Elegí un período válido de hasta 366 días, con la fecha final igual o posterior a la inicial.');
    get('export-attendance-xlsx').disabled = true;
    get('export-attendance-pdf').disabled = true;
    return;
  }
  setFormError('report-error');
  displayedReport = buildAttendanceReport(days, get('report-worker').value);
  const { from, to, scope, totals, rows, closures } = displayedReport;
  get('attendance-period').textContent = `${reportDate(from)} al ${reportDate(to)} · ${scope}`;
  get('attendance-schedule').textContent = reportScheduleLine(displayedReport);
  get('attendance-notice').textContent = 'Cada indicador cuenta un día por empleado. Las faltas se computan al terminar el horario previsto.';
  get('attendance-empty').hidden = rows.length > 0;
  get('export-attendance-xlsx').disabled = false;
  get('export-attendance-pdf').disabled = false;
  get('attendance-totals').replaceChildren(...Object.entries(reportIndicators).map(([status, label]) => {
    const card = document.createElement('div');
    card.className = 'attendance-stat';
    card.dataset.indicator = status;
    card.innerHTML = '<dt></dt><dd></dd>';
    card.querySelector('dt').textContent = label;
    card.querySelector('dd').textContent = totals[status];
    return card;
  }));
  const detail = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.insertCell().textContent = reportDate(row.day);
    const workerCell = tr.insertCell();
    workerCell.textContent = `${row.worker.name} · ${row.worker.label}`;
    const assignment = document.createElement('small');
    const position = row.worker.position ? `${row.worker.position} · ` : '';
    assignment.textContent = `${position}${row.worker.personalSchedule ? 'Horario propio' : 'Horario general'} ${row.schedule.start}–${row.schedule.end}`;
    workerCell.append(assignment);
    for (const value of [row.entry || '—', row.exit || '—']) {
      tr.insertCell().textContent = value;
    }
    const badge = document.createElement('span');
    badge.className = 'attendance-badge';
    badge.dataset.indicator = row.status;
    badge.textContent = reportIndicators[row.status];
    tr.insertCell().append(badge);
    tr.insertCell().textContent = row.note || '—';
    detail.append(tr);
  }
  get('attendance-rows').replaceChildren(detail);
  get('report-closures-empty').hidden = closures.length > 0;
  get('report-closures').replaceChildren(...closures.map((closure) => closureRow(closure, false)));
}

function updatePeriodFields() {
  const mode = get('report-period').value;
  for (const [id, visible] of Object.entries({ month: mode !== 'custom', half: mode === 'half', from: mode === 'custom', to: mode === 'custom' })) {
    get(`report-${id}-label`).hidden = !visible;
    get(`report-${id}`).disabled = !visible;
  }
}

function openAttendanceReport() {
  const today = plantDay(new Date());
  const month = today.slice(0, 7);
  if (!get('report-month').value) get('report-month').value = month;
  if (!get('report-from').value) get('report-from').value = `${month}-01`;
  if (!get('report-to').value) get('report-to').value = today;
  const workers = get('report-worker');
  const selected = workers.value;
  const options = staffDirectory().map((worker) => new Option(`${worker.name} · ${worker.label}`, worker.id));
  workers.replaceChildren(new Option('Todo el personal', ''), ...options);
  workers.value = options.some((option) => option.value === selected) ? selected : '';
  updatePeriodFields();
  renderAttendanceReport();
}

function renderFactorySchedule() {
  const schedule = readReportSetting(reportSettingsKey, defaultSchedule);
  get('factory-schedule-summary').textContent = describeSchedule(schedule);
}

function openFactoryCalendar() {
  if (!get('closure-from').value) setClosureForm();
  renderFactoryCalendar();
}

function closureRow(closure, editable) {
  const row = document.createElement('li');
  row.className = 'worker-row';
  const detail = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = closureTypes[closure.type];
  const dates = document.createElement('small');
  dates.textContent = closure.from === closure.to ? reportDate(closure.from) : `${reportDate(closure.from)} al ${reportDate(closure.to)}`;
  detail.append(title, dates);
  if (closure.note) {
    const note = document.createElement('p');
    note.className = 'field-hint';
    note.textContent = closure.note;
    detail.append(note);
  }
  row.append(detail);
  if (editable) {
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'history-link';
    edit.textContent = 'Editar';
    edit.addEventListener('click', () => setClosureForm(closure));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'history-link';
    remove.textContent = 'Quitar';
    remove.addEventListener('click', async () => {
      if (account?.role !== 'employer' || !window.confirm('¿Quitar este registro del calendario de fábrica?')) return;
      try {
        const calendar = readReportSetting(factoryCalendarKey, []);
        const session = sessionVersion;
        await cloud.saveRecord('plantClosures', closure.id, null);
        if (session !== sessionVersion) return;
        portalState.set(factoryCalendarKey, calendar.filter(({ id }) => id !== closure.id));
        if (editingClosure === closure.id) setClosureForm();
        renderFactoryCalendar();
        renderAttendanceReport();
      } catch {
        setFormError('closure-error', 'No se pudo guardar el cambio.');
      }
    });
    row.append(edit, remove);
  }
  return row;
}

function renderFactoryCalendar() {
  const calendar = readReportSetting(factoryCalendarKey, []);
  calendar.sort((a, b) => b.from.localeCompare(a.from));
  get('calendar-empty').hidden = calendar.length > 0;
  get('closure-list').replaceChildren(...calendar.map((closure) => closureRow(closure, true)));
}

function setClosureForm(closure) {
  const today = plantDay(new Date());
  editingClosure = closure?.id;
  get('closure-type').value = closure?.type || 'holiday';
  get('closure-from').value = closure?.from || today;
  get('closure-to').value = closure?.to || today;
  get('closure-note').value = closure?.note || '';
  get('closure-save').textContent = closure ? 'Guardar cambios' : 'Agregar al calendario';
  get('closure-cancel').hidden = !closure;
  setFormError('closure-error');
  if (closure) get('closure-title').focus();
}

get('report-filters').addEventListener('submit', (event) => {
  event.preventDefault();
  renderAttendanceReport();
});
get('report-period').addEventListener('change', updatePeriodFields);
get('report-filters').addEventListener('change', renderAttendanceReport);
get('closure-cancel').addEventListener('click', () => setClosureForm());
get('closure-from').addEventListener('change', () => {
  if (get('closure-to').value < get('closure-from').value) get('closure-to').value = get('closure-from').value;
});

document.querySelectorAll('[data-open-factory-schedule]').forEach((button) => {
  button.addEventListener('click', () => openScheduleEditor());
});
get('assign-schedule').addEventListener('click', () => {
  const general = readReportSetting(reportSettingsKey, defaultSchedule);
  setScheduleHours(personalScheduleDraft ?? { days: [], grace: general.grace });
  get('schedule-groups').querySelector('[name="workday"]').focus();
});
get('inherit-schedule').addEventListener('click', () => {
  personalScheduleDraft = null;
  setFormError('schedule-editor-error');
  updateProfileScheduleSummary();
  setScheduleHours(null);
  get('assign-schedule').focus();
});
get('add-schedule-group').addEventListener('click', () => appendScheduleGroup().querySelector('[name="workday"]').focus());
get('cancel-schedule').addEventListener('click', () => get('schedule-dialog').close());

handleForm('schedule-editor-form', 'schedule-editor-error', async () => {
  if (account?.role !== 'employer' || !get('schedule-dialog').open) return;
  const session = sessionVersion;
  let schedule = personalScheduleDraft;
  if (!get('schedule-hours').disabled) {
    schedule = readScheduleGroups();
    if (!schedule) return;
  }
  if (scheduleEditorWorker) {
    const uid = scheduleEditorWorker.id;
    const profile = { position: get('profile-position').value.trim(), schedule: schedule ?? null };
    const email = get('profile-recovery-email').value.trim();
    await cloud.saveWorkerSettings(uid, profile, email);
    if (session !== sessionVersion) return;
    portalState.set(workerProfilesKey, { ...readReportSetting(workerProfilesKey, {}), [uid]: profile });
    const contacts = (portalState.get('staffRecoveryContacts') ?? []).filter((item) => item.id !== uid);
    portalState.set('staffRecoveryContacts', [...contacts, { id: uid, email }]);
    get('schedule-dialog').close();
    renderWorkers();
    get('workers-title').focus();
    showMessage('Perfil del empleado guardado.');
  } else {
    await cloud.saveSetting(reportSettingsKey, schedule);
    if (session !== sessionVersion) return;
    portalState.set(reportSettingsKey, schedule);
    get('schedule-dialog').close();
    renderFactorySchedule();
    showMessage('Horario general guardado.');
  }
});

handleForm('closure-form', 'closure-error', async () => {
  if (account?.role !== 'employer' || get('calendar').hidden) return;
  const from = get('closure-from').value;
  const to = get('closure-to').value;
  const type = get('closure-type').value;
  if (!from || !to || from > to || !Object.hasOwn(closureTypes, type)) {
    setFormError('closure-error', 'Elegí un tipo y un rango de fechas válido.');
    return;
  }
  const calendar = readReportSetting(factoryCalendarKey, []);
  if (calendar.some((item) => item.id !== editingClosure && item.from <= to && item.to >= from)) {
    setFormError('closure-error', 'Ya existe un feriado o cierre que coincide con esas fechas. Podés editarlo desde el calendario.');
    return;
  }
  const id = editingClosure || hex(crypto.getRandomValues(new Uint8Array(12)));
  const closure = { id, from, to, type, note: get('closure-note').value.trim() };
  const { id: closureId, ...data } = closure;
  const session = sessionVersion;
  await cloud.saveRecord('plantClosures', closureId, data);
  if (session !== sessionVersion) return;
  portalState.set(factoryCalendarKey, [...calendar.filter((item) => item.id !== id), closure]);
  setClosureForm();
  renderFactoryCalendar();
  renderAttendanceReport();
  showMessage('Calendario de fábrica actualizado.');
});

get('sign-out').addEventListener('click', () => {
  displayedReport = undefined;
  setClosureForm();
  get('report-filters').reset();
  get('schedule-dialog').close();
});

get('export-attendance-xlsx').addEventListener('click', () => {
  if (!displayedReport || account?.role !== 'employer') return;
  const { from, to, workerId, scope, staff, totals, rows, closures } = displayedReport;
  const sheets = [
    { name: 'Resumen', rows: [
      ['Indicador', 'Cantidad de días por empleado'],
      ...Object.entries(reportIndicators).map(([status, label]) => [label, totals[status]]),
      [], ['Desde', from], ['Hasta', to], ['Alcance', scope], ['Horario de referencia', reportScheduleLine(displayedReport)],
    ] },
    { name: 'Detalle', rows: [
      ['Fecha', 'Empleado', 'DNI o legajo', 'Entrada', 'Salida', 'Indicador', 'Observación'],
      ...rows.map((row) => [row.day, row.worker.name, row.worker.label, row.entry, row.exit, reportIndicators[row.status], row.note]),
    ] },
    { name: 'Cierres', rows: [
      ['Tipo', 'Desde', 'Hasta', 'Descripción'],
      ...closures.map((item) => [closureTypes[item.type], item.from, item.to, item.note]),
    ] },
    { name: 'Perfiles y horarios', rows: [
      ['Empleado', 'DNI o legajo', 'Puesto', 'Tipo de horario', 'Días laborables', 'Entrada prevista', 'Salida prevista', 'Tolerancia (min)'],
      ...staff.flatMap((worker) => scheduleGroups(worker.schedule).map(({ days, start, end }) => [
        worker.name, worker.label, worker.position || '', worker.personalSchedule ? 'Propio' : 'General',
        days.map((day) => weekdayNames[day]).join(', '), start, end, worker.schedule.grace,
      ])),
    ] },
  ];
  const url = URL.createObjectURL(attendanceWorkbook(sheets));
  const download = document.createElement('a');
  download.href = url;
  download.download = `asistencia-faroni-${workerId ? 'individual' : 'general'}-${from}-a-${to}.xlsx`;
  document.body.append(download);
  download.click();
  download.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
});

get('export-attendance-pdf').addEventListener('click', () => {
  if (!displayedReport || account?.role !== 'employer') return;
  document.body.classList.add('printing-attendance');
  window.print();
});
window.addEventListener('afterprint', () => document.body.classList.remove('printing-attendance'));
