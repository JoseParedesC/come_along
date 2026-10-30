import { api, h, clear, money, pct, stepper, ticket, toast, token, withToken } from '/assets/common.js';

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

init().catch((err) => notice('No se pudo cargar', err.message));
