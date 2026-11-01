import { api, h, clear, money, pct, stepper, ticket, toast, token, withToken, transfersTicket, crossMembers } from '/assets/common.js';

const root = document.getElementById('app');
const POLL_MS = 8000;
let pollTimer = null;
const stopPolling = () => { clearInterval(pollTimer); pollTimer = null; };

function notice(title, text, done = false) {
  stopPolling();
  clear(root);
  root.append(h('h1', {}, title), h('div', { class: `notice${done ? ' done' : ''}` }, text));
}

async function init() {
  stopPolling();
  if (!token) return notice('Falta el enlace', 'Abre el enlace completo que te compartió el organizador.');
  const s = await api(withToken('/api/company'));
  if (s.status === 'invalid') return notice('Enlace no válido', 'Este enlace no existe o fue reemplazado. Pide uno nuevo al organizador.');
  if (s.kind === 'cross') return renderCross(s);
  if (s.status === 'none') return notice('Todavía no hay cuenta', 'El organizador aún no ha creado la cuenta.');
  if (s.status === 'setup' || s.status === 'honoree') return notice(s.eventName, 'Aún no está habilitado. Faltan los consumos de exentos e invitados; vuelve a abrir este enlace en unos minutos.');
  if (s.status === 'closed') return notice(s.eventName, 'El cobro ya fue cerrado. Si necesitas algo, habla con el organizador.');
  if (s.rulesVersion === 2 && s.registered >= s.payersCount) return notice(s.eventName, 'Ya se registraron todos los participantes que pagan.');
  renderForm(s);
}

function renderForm(s) {
  let quoted = false;
  const ticketBox = h('div', { 'aria-live': 'polite' });
  const saveBox = h('div');
  const quoteBtn = h('button', { type: 'button', class: 'btn grow', onClick: onQuote }, 'Ver total');

  const rows = s.items.map((it) => {
    const st = stepper({ max: it.available, label: it.name, onChange: invalidate });
    const price = h('div', { class: 'meta' }, `${money(it.price)} c/u`);
    const left = h('div', { class: 'meta' });
    const row = h('li', { class: 'item' }, h('div', {}, h('div', { class: 'name' }, it.name), price, left), st.el);
    const paint = (avail) => {
      left.textContent = avail > 0 ? `Quedan ${avail}` : 'Agotado';
      row.classList.toggle('out', avail <= 0);
    };
    paint(it.available);
    return { it, st, paint, row };
  });

  const selection = () => rows.filter((r) => r.st.value > 0).map((r) => ({ itemId: r.it.id, qty: r.st.value }));

  function invalidate() {
    if (!quoted) return;
    quoted = false;
    clear(ticketBox);
    clear(saveBox);
  }

  async function onQuote() {
    const sel = selection();
    if (!sel.length) return toast('Selecciona al menos un ítem.', true);
    quoteBtn.disabled = true;
    try {
      const { breakdown } = await api(withToken('/api/company/quote'), { method: 'POST', body: { selection: sel } });
      quoted = true;
      clear(ticketBox);
      ticketBox.append(ticket(breakdown));
      renderSave();
      ticketBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      toast(err.message, true);
      if (err.status === 409) init();
    } finally {
      quoteBtn.disabled = false;
    }
  }

  function renderSave() {
    const nameIn = h('input', { type: 'text', id: 'guest-name', maxLength: 60, autocomplete: 'name', placeholder: 'Nombre y apellido' });
    const saveBtn = h('button', { type: 'button', class: 'btn grow' }, 'Guardar mi cuenta');
    saveBtn.addEventListener('click', async () => {
      const name = nameIn.value.trim();
      if (!name) return toast('Escribe tu nombre.', true);
      saveBtn.disabled = true;
      try {
        const r = await api(withToken('/api/company/guests'), { method: 'POST', body: { name, selection: selection() } });
        renderSaved(r);
      } catch (err) {
        toast(err.message, true);
        saveBtn.disabled = false;
        if (err.status === 409 && !/nombre/i.test(err.message)) init();
      }
    });
    clear(saveBox);
    saveBox.append(h('div', { class: 'panel save' },
      h('div', { class: 'field' }, h('label', { for: 'guest-name' }, 'Tu nombre'), nameIn),
      h('div', { class: 'actions' }, saveBtn)));
  }

  function renderSaved({ guest, breakdown }) {
    stopPolling();
    clear(root);
    root.append(
      h('h1', {}, `Gracias, ${guest.name}`),
      h('div', { class: 'notice done' }, 'Tu cuenta quedó guardada. Este es el valor que debes pagar.'),
      ticket(breakdown, { title: 'Tu cuenta guardada' }));
  }

  // Disponibilidad en vivo: otros participantes pueden tomar unidades mientras eliges.
  async function refresh() {
    if (document.hidden) return;
    try {
      const f = await api(withToken('/api/company'));
      if (f.status !== 'open') return init();
      let clipped = false;
      for (const r of rows) {
        const now = f.items.find((i) => i.id === r.it.id);
        if (!now) continue;
        r.it.available = now.available;
        r.paint(now.available);
        if (r.st.setMax(now.available)) clipped = true;
      }
      if (clipped) {
        quoted = true;
        invalidate();
        toast('Otra persona tomó unidades: ajustamos tu selección.', true);
      }
    } catch { /* un fallo de red puntual no debe interrumpir la pantalla */ }
  }

  const intro = s.rulesVersion === 2
    ? 'Tu total es tu consumo más una parte igual de la propina y del consumo de exentos e invitados, redondeado a la siguiente centena.'
    : `Se suma la propina (${pct(s.tipPercent)}) y la parte del consumo del cumplimentado, que no paga.`;

  clear(root);
  root.append(
    h('h1', {}, s.eventName),
    h('p', { class: 'lead' }, 'Marca lo que consumiste y pulsa “Ver total”.'),
    h('div', { class: 'panel' }, h('ul', { class: 'list' }, rows.map((r) => r.row))),
    h('p', { class: 'muted small' }, intro),
    h('div', { class: 'actions' }, quoteBtn),
    ticketBox, saveBox);
  pollTimer = setInterval(refresh, POLL_MS);
}


/* ------------------------------------------------- Cuentas cruzadas */

const regKey = `ca-reg-${token}`;
const getReg = () => { try { return localStorage.getItem(regKey); } catch { return null; } };
const setReg = (name) => { try { localStorage.setItem(regKey, name); } catch { /* sin almacenamiento: no pasa nada */ } };

function renderCross(s) {
  stopPolling();
  if (s.status === 'setup') return notice(s.eventName, 'Aún no está habilitada. Vuelve a abrir este enlace en unos minutos.');
  const closed = s.status === 'closed';
  const formBox = h('div');
  const resultsBox = h('div', { 'aria-live': 'polite' });
  const paint = (r) => {
    clear(resultsBox);
    resultsBox.append(
      h('h2', {}, 'Cómo va la cuenta'),
      h('div', { class: 'panel' }, h('dl', { class: 'kv' },
        h('dt', {}, 'Total gastado'), h('dd', {}, money(r.total)),
        h('dt', {}, 'Participantes registrados'), h('dd', {}, `${r.registered} de ${r.participants}`),
        h('dt', {}, 'Parte por persona'), h('dd', {}, money(Math.round(r.sharePerPerson))))),
      r.members.length ? crossMembers(r) : null,
      transfersTicket(r));
  };

  clear(root);
  root.append(
    h('h1', {}, s.eventName),
    h('p', { class: 'lead' }, closed
      ? 'La cuenta está cerrada. Este es el resultado final.'
      : 'Registra lo que pagaste de tu bolsillo. Todo se suma y se divide en partes iguales entre los participantes.'),
    formBox, resultsBox);
  paint(s);

  if (!closed) {
    const mine = getReg();
    if (mine) {
      formBox.append(h('div', { class: 'notice done' },
        `Ya te registraste como ${mine}. Aquí abajo ves cómo va la cuenta.`,
        s.pending > 0
          ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn ghost small', onClick: () => { setReg(''); renderCross(s); } }, 'Registrar a otra persona'))
          : null));
    } else if (s.pending > 0) formBox.append(crossForm((r) => { toast('Gastos guardados.'); renderCross(r); }));
    else formBox.append(h('div', { class: 'notice' }, 'Ya se registraron todos los participantes.'));
    pollTimer = setInterval(async () => {
      if (document.hidden) return;
      try {
        const f = await api(withToken('/api/company'));
        if (f.status !== 'open') return init();
        paint(f);
      } catch { /* un fallo puntual de red no interrumpe la pantalla */ }
    }, POLL_MS);
  }
}

function crossForm(onSaved) {
  const nameIn = h('input', { type: 'text', id: 'cx-name', maxLength: 60, autocomplete: 'name', placeholder: 'Nombre y apellido' });
  const rowsEl = h('div', { class: 'xrows' });
  const totalEl = h('p', { class: 'muted' });
  const rows = [];

  const read = () => rows.map((r) => ({ description: r.desc.value.trim(), amount: Number(r.amount.value) }))
    .filter((x) => x.description || x.amount);
  const update = () => {
    const sum = read().reduce((a, x) => a + (Number.isFinite(x.amount) ? x.amount : 0), 0);
    totalEl.textContent = `Total que pagaste: ${money(sum)}`;
  };
  function addRow() {
    const r = {
      desc: h('input', { type: 'text', maxLength: 80, placeholder: 'Qué pagaste (ej. Almuerzo)', 'aria-label': 'Qué pagaste' }),
      amount: h('input', { type: 'number', min: 1, step: 1, inputMode: 'numeric', placeholder: '0', 'aria-label': 'Importe' }),
    };
    r.el = h('div', { class: 'xrow' }, r.desc, r.amount, h('button', {
      type: 'button', class: 'x', 'aria-label': 'Quitar gasto',
      onClick: () => { rows.splice(rows.indexOf(r), 1); r.el.remove(); update(); },
    }, '×'));
    [r.desc, r.amount].forEach((i) => i.addEventListener('input', update));
    rows.push(r);
    rowsEl.append(r.el);
  }
  addRow();
  update();

  const saveBtn = h('button', { type: 'button', class: 'btn grow' }, 'Guardar mis gastos');
  saveBtn.addEventListener('click', async () => {
    const name = nameIn.value.trim();
    if (!name) return toast('Escribe tu nombre.', true);
    const expenses = read();
    for (const x of expenses) {
      if (!x.description) return toast('Cada gasto necesita una descripción.', true);
      if (!Number.isInteger(x.amount) || x.amount < 1) return toast(`"${x.description}": el importe debe ser un entero mayor que 0.`, true);
    }
    if (!expenses.length && !window.confirm('No registraste ningún gasto: solo pagarás tu parte. ¿Continuar?')) return;
    saveBtn.disabled = true;
    try {
      const r = await api(withToken('/api/company/members'), { method: 'POST', body: { name, expenses } });
      setReg(name);
      onSaved(r);
    } catch (err) {
      toast(err.message, true);
      saveBtn.disabled = false;
      if (err.status === 409 && !/nombre/i.test(err.message)) init();
    }
  });

  return h('div', { class: 'panel' },
    h('div', { class: 'field' }, h('label', { for: 'cx-name' }, 'Tu nombre'), nameIn),
    h('h3', {}, 'Lo que pagaste'),
    h('p', { class: 'muted small' }, 'Agrega cada gasto que pagaste tú. Si no pagaste nada, déjalo vacío y guarda.'),
    rowsEl,
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn ghost small', onClick: () => addRow() }, 'Agregar otro gasto')),
    totalEl,
    h('div', { class: 'actions' }, saveBtn));
}

init().catch((err) => notice('No se pudo cargar', err.message));
