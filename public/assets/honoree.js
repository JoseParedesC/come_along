import { api, h, clear, stepper, toast, token, withToken } from '/assets/common.js';

const root = document.getElementById('app');

function notice(title, text, done = false) {
  clear(root);
  root.append(h('h1', {}, title), h('div', { class: `notice${done ? ' done' : ''}` }, text));
}

async function init() {
  if (!token) return notice('Falta el enlace', 'Abre el enlace completo que te compartió el organizador.');
  const s = await api(withToken('/api/honoree'));
  if (s.status === 'invalid') return notice('Enlace no válido', 'Este enlace no existe o fue reemplazado. Pide uno nuevo al organizador.');
  if (s.status === 'setup') return notice(s.eventName, 'El organizador está terminando de registrar la cuenta. Vuelve a abrir este enlace en unos minutos.');
  const pending = s.people.filter((p) => !p.registered);
  if (s.status !== 'honoree' || !pending.length) return renderDone(s);
  renderForm(s, pending);
}

function renderForm(s, pending) {
  const kindLabel = { exempt: 'exento', guest: 'invitado' };
  let who = pending.length === 1 ? pending[0] : null;
  const box = h('div');

  const picker = pending.length > 1
    ? h('div', { class: 'panel' },
        h('div', { class: 'field' }, h('label', { for: 'who' }, '¿Quién eres?'),
          h('select', { id: 'who', onChange: (e) => { who = pending.find((p) => p.id === Number(e.target.value)) || null; draw(); } },
            h('option', { value: '' }, 'Elige tu nombre…'),
            pending.map((p) => h('option', { value: p.id }, `${p.name} (${kindLabel[p.kind]})`)))))
    : null;

  function draw() {
    clear(box);
    if (!who) return;
    const pickers = s.items.map((it) => ({ it, st: stepper({ max: it.remaining, label: it.name }) }));
    const submit = h('button', { type: 'button', class: 'btn grow' }, 'Confirmar mi consumo');
    submit.addEventListener('click', async () => {
      const selection = pickers.filter((p) => p.st.value > 0).map((p) => ({ itemId: p.it.id, qty: p.st.value }));
      const msg = selection.length
        ? `Vas a confirmar el consumo de ${who.name}. Después no podrá cambiarse desde aquí. ¿Continuar?`
        : 'No marcaste ningún ítem. ¿Confirmas que no consumió nada?';
      if (!window.confirm(msg)) return;
      submit.disabled = true;
      try {
        await api(withToken('/api/honoree'), { method: 'POST', body: { personId: who.id, selection } });
        toast('Consumo registrado.');
        init();
      } catch (err) {
        toast(err.message, true);
        submit.disabled = false;
        if (err.status === 409) init();
      }
    });
    box.append(
      h('h2', {}, who.name),
      h('div', { class: 'panel' },
        h('ul', { class: 'list' }, pickers.map(({ it, st }) =>
          h('li', { class: `item${it.remaining <= 0 ? ' out' : ''}` },
            h('div', {}, h('div', { class: 'name' }, it.name), h('div', { class: 'meta' }, `En la mesa: ${it.qty}`)),
            st.el)))),
      h('div', { class: 'actions' }, submit));
  }

  clear(root);
  root.append(
    h('h1', {}, s.eventName),
    h('p', { class: 'lead' }, 'Marca cuántas unidades de cada ítem consumió esta persona.'),
    picker, box);
  draw();
}

function renderDone(s) {
  clear(root);
  root.append(
    h('h1', {}, 'Consumos registrados'),
    h('div', { class: 'notice done' }, 'Ya quedó todo guardado. Puedes cerrar esta página.'),
    h('div', { class: 'panel' }, h('ul', { class: 'list' }, s.people.map((p) =>
      h('li', { class: 'item' }, h('span', { class: 'name' }, p.name), h('span', { class: 'badge ok' }, 'Registrado'))))));
}

init().catch((err) => notice('No se pudo cargar', err.message));
