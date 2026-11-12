const correctionStatus = { pending: 'Pendiente', approved: 'Aprobada', rejected: 'Rechazada' };
const markLabels = { in: 'Entrada', out: 'Salida' };

function readCorrections() {
  return [...(portalState.get('corrections') ?? [])]
    .sort((a, b) => (a.reviewedAt ?? a.createdAt ?? a.at).localeCompare(b.reviewedAt ?? b.createdAt ?? b.at));
}

function loadMarks(uid) {
  const adjustments = new Map();
  for (const item of readCorrections()) {
    if (item.workerId === uid && item.status === 'approved') adjustments.set(item.type + item.at, item);
  }
  return loadOriginalMarks(uid).map((mark) => {
    const adjustment = adjustments.get(mark.type + mark.at);
    return adjustment ? { ...mark, correctionId: adjustment.id, manual: Boolean(adjustment.manual) } : mark;
  }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function marksOnDate(workerId, date) {
  return loadMarks(workerId).filter((mark) => plantDay(new Date(mark.at)) === date).reverse();
}

function correctionConflict(request, now = new Date()) {
  if (Date.parse(request.at) > now.getTime()) return 'La hora indicada todavía no pasó.';
  const records = marksOnDate(request.workerId, request.date);
  const index = records.findIndex((mark) => mark.at === request.previousAt && mark.type === request.type);
  if (request.previousAt && index < 0) return 'La fichada original cambió. Hacé una solicitud sobre el registro actual.';
  if (!request.previousAt && records.some((mark) => mark.type === request.type)) {
    return 'Ya hay una fichada de ese tipo. Seleccioná la existente para corregirla.';
  }
  const corrected = { type: request.type, at: request.at };
  if (index >= 0) records[index] = corrected;
  else records.push(corrected);
  records.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (records.length > 1 && records.some((mark, position) => (
    mark.type !== (position % 2 === 0 ? 'in' : 'out') || mark.at === records[position - 1]?.at
  ))) return 'El cambio debe dejar las entradas y salidas del día en orden y con horas distintas.';
  return '';
}

function fillCorrectionChoices(input, workerId, date) {
  const selected = input.value;
  const records = marksOnDate(workerId, date);
  const options = [
    new Option('Seleccioná una fichada', ''),
    new Option('Agregar entrada faltante', 'in:'),
    new Option('Agregar salida faltante', 'out:'),
    ...records.map((mark) => new Option(`Corregir ${markLabels[mark.type].toLowerCase()} de las ${markTime(mark)}`, `${mark.type}:${mark.at}`)),
  ];
  input.replaceChildren(...options);
  input.value = options.some((option) => option.value === selected) ? selected : '';
}

function refreshCorrectionChoices() {
  fillCorrectionChoices(get('correction-mark'), account.username, get('correction-date').value);
}

function proposedCorrection(workerId, date, selection, time, reason) {
  const separator = selection.indexOf(':');
  const type = selection.slice(0, separator);
  const previousAt = selection.slice(separator + 1);
  const at = new Date(`${date}T${time}:00-03:00`);
  if (!Object.hasOwn(markLabels, type) || !Number.isFinite(at.getTime())) return null;
  return { workerId, date, type, at: at.toISOString(), previousAt, reason };
}

function renderCorrectionCounter() {
  const total = readCorrections().filter((request) => request.status === 'pending').length;
  const badge = get('pending-corrections');
  badge.hidden = total === 0;
  badge.textContent = total === 1 ? '1 pendiente' : `${total} pendientes`;
}

function correctionRow(request, workerName) {
  const row = document.createElement('li');
  row.className = 'correction-row';
  row.innerHTML = '<div class="correction-heading"><strong></strong><span class="team-status"></span></div><p class="field-hint correction-times"></p><p class="field-hint correction-reason"></p><p class="field-hint correction-decision" hidden></p>';
  const title = `${reportDate(request.date)} · ${markLabels[request.type]}`;
  row.querySelector('strong').textContent = workerName ? `${workerName} · ${title}` : title;
  const badge = row.querySelector('.team-status');
  badge.dataset.state = request.status === 'approved' ? 'open' : request.status === 'rejected' ? 'absent' : 'waiting';
  badge.textContent = request.manual ? 'Ajuste manual' : correctionStatus[request.status];
  const target = markTime(request);
  row.querySelector('.correction-times').textContent = request.previousAt
    ? `De ${markTime({ at: request.previousAt })} a ${target}` : `Agregar fichada a las ${target}`;
  const reason = row.querySelector('.correction-reason');
  reason.textContent = request.reason;
  reason.hidden = !request.reason;
  if (request.status !== 'pending') {
    const decision = row.querySelector('.correction-decision');
    const when = new Date(request.reviewedAt);
    const action = request.manual ? 'Registrado' : 'Revisada';
    const reviewer = request.reviewer === 'Empleador demo' ? 'Administración Faroni' : request.reviewer;
    const comment = request.decisionNote ? ` ${request.decisionNote}` : '';
    decision.textContent = `${action} por ${reviewer} el ${reportDate(plantDay(when))} a las ${timeFormat.format(when)}.${comment}`;
    decision.hidden = false;
  }
  return row;
}

function renderEmployeeCorrections() {
  const date = get('correction-date');
  date.max = plantDay(new Date());
  if (!date.value) date.value = date.max;
  refreshCorrectionChoices();
  const requests = readCorrections().filter((request) => request.workerId === account.username).reverse();
  get('employee-corrections-empty').hidden = requests.length > 0;
  get('employee-corrections').replaceChildren(...requests.map((request) => correctionRow(request)));
}

function renderEmployerCorrections() {
  const requests = readCorrections().reverse();
  const staff = new Map(staffDirectory().map((worker) => [worker.id, worker.name]));
  const pending = [];
  const reviewed = [];
  for (const request of requests) {
    const row = correctionRow(request, staff.get(request.workerId) || `Empleado ${request.workerId}`);
    if (request.status !== 'pending') {
      reviewed.push(row);
      continue;
    }
    const form = get('correction-review-template').content.firstElementChild.cloneNode(true);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const error = form.querySelector('.form-error');
      const submitter = event.submitter;
      const status = submitter?.value;
      const buttons = [...form.querySelectorAll('button')];
      if (buttons.some((button) => button.disabled)) return;
      buttons.forEach((button) => { button.disabled = true; });
      const message = await reviewCorrection(request.id, status, form.elements['decision-note'].value.trim());
      buttons.forEach((button) => { button.disabled = false; });
      if (message) {
        error.textContent = message;
        error.hidden = false;
      }
    });
    row.append(form);
    pending.push(row);
  }
  get('pending-empty').hidden = pending.length > 0;
  get('reviewed-empty').hidden = reviewed.length > 0;
  get('pending-correction-list').replaceChildren(...pending);
  get('reviewed-correction-list').replaceChildren(...reviewed);
}

async function reviewCorrection(id, status, note) {
  if (account?.role !== 'employer' || get('corrections').hidden || !['approved', 'rejected'].includes(status)) return '';
  if (!note) return 'Ingresá el motivo de la decisión.';
  const requests = readCorrections();
  const request = requests.find((item) => item.id === id);
  if (!request || request.status !== 'pending') return 'Esta solicitud ya fue revisada. Volvé a abrir Correcciones.';
  if (status === 'approved') {
    const conflict = correctionConflict(request);
    if (conflict) return conflict;
  }
  const review = { status, decisionNote: note, reviewer: account.name, reviewedAt: new Date().toISOString() };
  try {
    const saved = status === 'approved'
      ? await cloud.applyCorrection({ ...request, ...review })
      : await cloud.reviewCorrection(id, review);
    if (!saved) return 'Las fichadas o la solicitud cambiaron. Revisá los datos y volvé a intentar.';
  } catch {
    return 'No se pudo guardar la decisión. Volvé a intentar.';
  }
  renderEmployerCorrections();
  renderCorrectionCounter();
  get('corrections-title').focus({ preventScroll: true });
  showMessage(status === 'approved' ? 'Corrección aprobada y aplicada al historial.' : 'Solicitud rechazada.');
  return '';
}

let manualTarget;
let manualDraft;

function showManualStep(review) {
  get('manual-edit').hidden = review;
  get('manual-edit').disabled = review;
  get('manual-review').hidden = !review;
  get('manual-review').disabled = !review;
  get('manual-next').hidden = review;
  get('back-manual').hidden = !review;
  get('confirm-manual').hidden = !review;
  setFormError('manual-error');
}

function openManualAdjustment(worker, date) {
  const dialog = get('manual-adjustment');
  if (account?.role !== 'employer' || get('team').hidden || dialog.open) return;
  manualTarget = { worker, date };
  manualDraft = null;
  get('manual-form').reset();
  get('manual-mark').value = '';
  fillCorrectionChoices(get('manual-mark'), worker.id, date);
  get('manual-context').textContent = `${worker.name} · ${worker.label} · ${reportDate(date)}`;
  showManualStep(false);
  dialog.showModal();
  get('manual-adjustment-title').focus();
}

get('cancel-manual').addEventListener('click', () => get('manual-adjustment').close());
get('back-manual').addEventListener('click', () => {
  manualDraft = null;
  fillCorrectionChoices(get('manual-mark'), manualTarget.worker.id, manualTarget.date);
  showManualStep(false);
  get('manual-mark').focus();
});

handleForm('manual-form', 'manual-error', () => {
  if (account?.role !== 'employer' || !get('manual-adjustment').open || !manualTarget || manualDraft) return;
  const { worker, date } = manualTarget;
  const time = get('manual-time').value;
  const reason = get('manual-reason').value.trim();
  const request = proposedCorrection(worker.id, date, get('manual-mark').value, time, reason);
  if (!request) {
    setFormError('manual-error', 'Elegí una fichada e ingresá la hora correcta.');
    return;
  }
  if (request.previousAt && markTime({ at: request.previousAt }) === time) {
    setFormError('manual-error', 'Ingresá una hora distinta de la fichada actual.');
    return;
  }
  const conflict = correctionConflict(request);
  if (conflict) {
    setFormError('manual-error', conflict);
    return;
  }
  manualDraft = { request, snapshot: JSON.stringify(marksOnDate(worker.id, date)) };
  const label = markLabels[request.type];
  get('manual-preview').textContent = request.previousAt
    ? `${label}: cambiar de ${markTime({ at: request.previousAt })} a ${time}.`
    : `Agregar ${label.toLowerCase()} a las ${time}.`;
  get('manual-preview-reason').textContent = reason;
  get('manual-preview-reason').hidden = !reason;
  showManualStep(true);
  get('back-manual').focus();
});

get('confirm-manual').addEventListener('click', async () => {
  const dialog = get('manual-adjustment');
  if (account?.role !== 'employer' || !dialog.open || get('team').hidden || !manualDraft) return;
  const confirm = get('confirm-manual');
  if (confirm.disabled) return;
  const { request, snapshot } = manualDraft;
  if (JSON.stringify(marksOnDate(request.workerId, request.date)) !== snapshot) {
    setFormError('manual-error', 'Las fichadas cambiaron. Volvé a editar para revisar los horarios actuales.');
    return;
  }
  const conflict = correctionConflict(request);
  if (conflict) {
    setFormError('manual-error', conflict);
    return;
  }
  confirm.disabled = true;
  try {
    const saved = await cloud.applyCorrection({
      ...request, id: hex(crypto.getRandomValues(new Uint8Array(12))), manual: true, status: 'approved',
      reviewer: account.name, reviewedAt: new Date().toISOString(),
    });
    if (!saved) {
      setFormError('manual-error', 'Las fichadas cambiaron. Volvé a editar el ajuste.');
      return;
    }
  } catch {
    setFormError('manual-error', 'No se pudo guardar el ajuste. Volvé a intentar.');
    return;
  } finally {
    confirm.disabled = false;
  }
  manualDraft = null;
  dialog.close();
  renderTeam();
  get('team-records-title').focus({ preventScroll: true });
  showMessage('Ajuste manual guardado.');
});

get('correction-date').addEventListener('change', async () => {
  get('correction-mark').value = '';
  get('correction-time').value = '';
  try {
    await loadWorkerDay(get('correction-date').value);
    if (account?.role === 'worker') refreshCorrectionChoices();
  } catch {
    setFormError('correction-error', 'No pudimos consultar esa fecha.');
  }
});

handleForm('correction-form', 'correction-error', async () => {
  if (account?.role !== 'worker' || get('profile').hidden) return;
  const date = get('correction-date').value;
  const time = get('correction-time').value;
  const selection = get('correction-mark').value;
  const reason = get('correction-reason').value.trim();
  const draft = proposedCorrection(account.username, date, selection, time, reason);
  if (!draft || !reason) {
    setFormError('correction-error', 'Completá la fecha, la fichada, la hora correcta y el motivo.');
    return;
  }
  const requests = readCorrections();
  if (requests.some((request) => request.workerId === account.username && request.date === date && request.status === 'pending')) {
    setFormError('correction-error', 'Ya hay una solicitud pendiente para esta fecha.');
    return;
  }
  const request = { ...draft, id: hex(crypto.getRandomValues(new Uint8Array(12))), status: 'pending', createdAt: new Date().toISOString() };
  if (draft.previousAt && markTime({ at: draft.previousAt }) === time) {
    setFormError('correction-error', 'Ingresá una hora distinta de la fichada original.');
    return;
  }
  const conflict = correctionConflict(request);
  if (conflict) {
    setFormError('correction-error', conflict);
    return;
  }
  await cloud.addCorrection(request);
  get('correction-form').reset();
  get('correction-details').open = false;
  get('correction-details').querySelector('summary').focus();
  renderEmployeeCorrections();
  showMessage('Solicitud enviada para revisión.');
});

get('sign-out').addEventListener('click', () => {
  get('manual-adjustment').close();
  manualTarget = null;
  manualDraft = null;
  get('correction-form').reset();
  get('correction-details').open = false;
  setFormError('correction-error');
});
