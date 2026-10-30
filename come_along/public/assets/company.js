import { api, h, clear, money, pct, stepper, ticket, toast } from '/assets/common.js';

const root = document.getElementById('app');

function notice(title, text, done = false) {
  clear(root);
  root.append(h('h1', {}, title), h('div', { class: `notice${done ? ' done' : ''}` }, text));
}

async function init() {
  const s = await api('/api/company');
  if (s.status === 'none') return notice('Todavía no hay cuenta', 'El organizador aún no ha creado la cuenta.');
  if (s.status === 'setup' || s.status === 'honoree') return notice(s.eventName, 'Aún no está habilitado. Falta que el cumplimentado registre su consumo; vuelve a abrir este enlace en unos minutos.');
  if (s.status === 'closed') return notice(s.eventName, 'El cobro ya fue cerrado. Si necesitas algo, habla con el organizador.');
  renderForm(s);
}

function renderForm(s) {
  let quoted = false;
  const ticketBox = h('div', { 'aria-live': 'polite' });
  const saveBox = h('div');
  const quoteBtn = h('button', { type: 'button', class: 'btn grow', onClick: onQuote }, 'Ver total');

  const pickers = s.items.map((it) => ({
    it,
    st: stepper({ max: it.available, label: it.name, onChange: invalidate }),
  }));

  const selection = () => pickers.filter((p) => p.st.value > 0).map((p) => ({ itemId: p.it.id, qty: p.st.value }));

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
      const { breakdown } = await api('/api/company/quote', { method: 'POST', body: { selection: sel } });
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
        const r = await api('/api/company/guests', { method: 'POST', body: { name, selection: selection() } });
        renderSaved(r);
      } catch (err) {
        toast(err.message, true);
        saveBtn.disabled = false;
        if (err.status === 409 && !/nombre/i.test(err.message)) init();
      }
    });
    clear(saveBox);
    saveBox.append(
      h('div', { class: 'panel save' },
        h('div', { class: 'field' }, h('label', { for: 'guest-name' }, 'Tu nombre'), nameIn),
        h('div', { class: 'actions' }, saveBtn))
    );
  }

  function renderSaved({ guest, breakdown }) {
    clear(root);
    root.append(
      h('h1', {}, `Gracias, ${guest.name}`),
      h('div', { class: 'notice done' }, 'Tu cuenta quedó guardada. Este es el valor que debes pagar.'),
      ticket(breakdown, { title: 'Tu cuenta guardada' })
    );
  }

  clear(root);
  root.append(
    h('h1', {}, s.eventName),
    h('p', { class: 'lead' }, 'Marca lo que consumiste y pulsa “Ver total”.'),
    h('div', { class: 'panel' },
      h('ul', { class: 'list' }, pickers.map(({ it, st }) =>
        h('li', { class: `item${it.available <= 0 ? ' out' : ''}` },
          h('div', {},
            h('div', { class: 'name' }, it.name),
            h('div', { class: 'meta' }, `${money(it.price)} c/u`),
            h('div', { class: 'meta' }, it.available > 0 ? `Quedan ${it.available}` : 'Agotado')),
          st.el)))),
    h('p', { class: 'muted small' }, `Se suma la propina (${pct(s.tipPercent)}) y la parte del consumo del cumplimentado, que no paga.`),
    h('div', { class: 'actions' }, quoteBtn),
    ticketBox,
    saveBox
  );
}

init().catch((err) => notice('No se pudo cargar', err.message));
