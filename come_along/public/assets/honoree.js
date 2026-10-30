import { api, h, clear, stepper, toast } from '/assets/common.js';

const root = document.getElementById('app');

function notice(title, text, done = false) {
  clear(root);
  root.append(h('h1', {}, title), h('div', { class: `notice${done ? ' done' : ''}` }, text));
}

async function init() {
  const s = await api('/api/honoree');
  if (s.status === 'none') return notice('Todavía no hay cuenta', 'El organizador aún no ha creado la cuenta. Vuelve a abrir este enlace más tarde.');
  if (s.status === 'setup') return notice(s.eventName, 'El organizador está terminando de registrar la cuenta. Vuelve a abrir este enlace en unos minutos.');
  if (s.status !== 'honoree') return renderDone(s);
  renderForm(s);
}

function renderForm(s) {
  const pickers = s.items.map((it) => ({ it, st: stepper({ max: it.qty, label: it.name }) }));
  const submit = h('button', { type: 'button', class: 'btn grow', onClick: onSubmit }, 'Confirmar mi consumo');

  async function onSubmit() {
    const selection = pickers.filter((p) => p.st.value > 0).map((p) => ({ itemId: p.it.id, qty: p.st.value }));
    const msg = selection.length
      ? 'Vas a confirmar tu consumo. Después no podrás cambiarlo desde aquí. ¿Continuar?'
      : 'No marcaste ningún ítem. ¿Confirmas que no consumiste nada?';
    if (!window.confirm(msg)) return;
    submit.disabled = true;
    try {
      await api('/api/honoree', { method: 'POST', body: { selection } });
      init();
    } catch (err) {
      toast(err.message, true);
      submit.disabled = false;
      if (err.status === 409) init();
    }
  }

  clear(root);
  root.append(
    h('h1', {}, s.eventName),
    h('p', { class: 'lead' }, 'Marca cuántas unidades de cada ítem consumiste.'),
    h('div', { class: 'panel' },
      h('ul', { class: 'list' }, pickers.map(({ it, st }) =>
        h('li', { class: 'item' },
          h('div', {}, h('div', { class: 'name' }, it.name), h('div', { class: 'meta' }, `En la mesa: ${it.qty}`)),
          st.el)))),
    h('div', { class: 'actions' }, submit)
  );
}

function renderDone(s) {
  const mine = s.items.filter((i) => i.selected > 0);
  clear(root);
  root.append(
    h('h1', {}, 'Consumo registrado'),
    h('div', { class: 'notice done' }, 'Listo, ya quedó guardado. Ya puedes cerrar esta página.'),
    mine.length
      ? h('div', { class: 'panel' }, h('ul', { class: 'list' }, mine.map((i) =>
          h('li', { class: 'item' }, h('span', { class: 'name' }, i.name), h('span', {}, `× ${i.selected}`)))))
      : h('p', { class: 'muted' }, 'Registraste que no consumiste ningún ítem.')
  );
}

init().catch((err) => notice('No se pudo cargar', err.message));
