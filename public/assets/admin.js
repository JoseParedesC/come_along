import { api, h, clear, money, pct, toast } from '/assets/common.js';

const root = document.getElementById('app');
let creatingNew = false;

const STEPS = [
  ['setup', 'Registrar la cuenta'],
  ['honoree', 'Consumo del cumplimentado'],
  ['open', 'Cobro a invitados'],
  ['closed', 'Cerrada'],
];

async function load() {
  render(await api('/api/admin/state'));
}

async function act(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
    await load();
  } catch (err) {
    toast(err.message, true);
  }
}

function render(s) {
  clear(root);
  if (!s.event || creatingNew) {
    root.append(stepsBar('setup'), h('h1', {}, 'Nueva cuenta'), formView(null));
    return;
  }
  root.append(stepsBar(s.event.status));
  if (s.event.status === 'setup') {
    root.append(h('h1', {}, 'Registrar la cuenta'), formView(s));
  } else {
    root.append(summaryView(s));
  }
}

function stepsBar(status) {
  const idx = STEPS.findIndex(([k]) => k === status);
  return h('ol', { class: 'steps', 'aria-label': 'Estado de la cuenta' },
    STEPS.map(([k, label], i) =>
      h('li', { class: i < idx ? 'done' : i === idx ? 'now' : '', 'aria-current': i === idx ? 'step' : null }, label)));
}

/* ---------------------------------------------------------- Formulario */

function formView(s) {
  const ev = s && s.event;
  const editing = !!ev && ev.status === 'setup';
  const rows = [];

  const nameIn = h('input', { type: 'text', id: 'ev-name', maxLength: 80, value: ev ? ev.name : '', placeholder: 'Ej. Cena de cumpleaños' });
  const tipIn = h('input', { type: 'number', id: 'ev-tip', min: 0, max: 100, step: '0.5', value: String(ev ? ev.tipPercent : 10) });
  const rowsEl = h('div', { class: 'rows' });
  const previewEl = h('dl', { class: 'kv' });

  function readItems() {
    return rows.map((r) => ({ name: r.name.value.trim(), price: Number(r.price.value), qty: Number(r.qty.value) }));
  }

  function update() {
    const S = readItems().reduce((a, i) => a + (Number.isFinite(i.price * i.qty) ? i.price * i.qty : 0), 0);
    const tip = Number(tipIn.value) || 0;
    const T = Math.round((S * tip) / 100);
    clear(previewEl);
    previewEl.append(
      h('dt', {}, 'Subtotal de ítems'), h('dd', {}, money(S)),
      h('dt', {}, `Propina (${pct(tip)})`), h('dd', {}, money(T)),
      h('dt', { class: 'strong' }, 'Total de la cuenta'), h('dd', { class: 'strong' }, money(S + T))
    );
  }

  function addRow(item = { name: '', price: '', qty: 1 }) {
    const r = {
      name: h('input', { type: 'text', maxLength: 80, value: item.name, placeholder: 'Ej. Pizza', 'aria-label': 'Nombre del ítem' }),
      price: h('input', { type: 'number', min: 0, step: 1, inputMode: 'numeric', value: String(item.price), placeholder: '0', 'aria-label': 'Valor unitario' }),
      qty: h('input', { type: 'number', min: 1, step: 1, inputMode: 'numeric', value: String(item.qty), 'aria-label': 'Cantidad' }),
    };
    r.el = h('div', { class: 'row' },
      h('div', { class: 'nm' }, r.name), r.price, r.qty,
      h('button', {
        type: 'button', class: 'x', 'aria-label': 'Quitar ítem',
        onClick: () => {
          rows.splice(rows.indexOf(r), 1);
          r.el.remove();
          if (!rows.length) addRow();
          update();
        },
      }, '×'));
    [r.name, r.price, r.qty].forEach((i) => i.addEventListener('input', update));
    rows.push(r);
    rowsEl.append(r.el);
  }

  async function save(publish) {
    const items = readItems().filter((i) => i.name || Number.isFinite(i.price) && i.price > 0);
    const payload = { name: nameIn.value.trim() || 'Cuenta', tipPercent: Number(tipIn.value), items };
    if (!items.length) return toast('Agrega al menos un ítem.', true);
    for (const i of items) {
      if (!i.name) return toast('Todos los ítems necesitan un nombre.', true);
      if (!Number.isInteger(i.price) || i.price < 0) return toast(`"${i.name}": el valor debe ser un número entero.`, true);
      if (!Number.isInteger(i.qty) || i.qty < 1) return toast(`"${i.name}": la cantidad debe ser al menos 1.`, true);
    }
    if (!(payload.tipPercent >= 0 && payload.tipPercent <= 100)) return toast('La propina debe estar entre 0 y 100 %.', true);
    if (publish && !window.confirm('Al habilitar, la cuenta ya no se podrá editar y el cumplimentado podrá registrar su consumo. ¿Continuar?')) return;

    await act(async () => {
      await api('/api/admin/event', { method: editing ? 'PUT' : 'POST', body: payload });
      creatingNew = false;
      if (publish) await api('/api/admin/event/publish', { method: 'POST', body: {} });
    }, publish ? 'Cuenta habilitada para el cumplimentado.' : 'Borrador guardado.');
  }

  tipIn.addEventListener('input', update);
  const initial = s && s.items && s.items.length ? s.items : [{ name: '', price: '', qty: 1 }];
  initial.forEach((i) => addRow({ name: i.name, price: i.price, qty: i.qty }));
  update();

  const cancel = creatingNew
    ? h('button', { type: 'button', class: 'btn ghost', onClick: () => { creatingNew = false; load(); } }, 'Cancelar')
    : null;

  return h('div', {},
    h('div', { class: 'panel' },
      h('div', { class: 'two' },
        h('div', { class: 'field' }, h('label', { for: 'ev-name' }, 'Nombre de la cuenta'), nameIn),
        h('div', { class: 'field' }, h('label', { for: 'ev-tip' }, 'Propina (%)'), tipIn))),
    h('h2', {}, 'Ítems de la factura'),
    h('div', { class: 'panel' },
      h('div', { class: 'row head', 'aria-hidden': 'true' }, h('span', {}, 'Ítem'), h('span', {}, 'Valor unitario'), h('span', {}, 'Cant.'), h('span')),
      rowsEl,
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn ghost small', onClick: () => addRow() }, 'Agregar ítem'))),
    h('h2', {}, 'Resumen'),
    h('div', { class: 'panel' }, previewEl),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn grow', onClick: () => save(true) }, 'Guardar y habilitar al cumplimentado'),
      h('button', { type: 'button', class: 'btn ghost', onClick: () => save(false) }, 'Guardar borrador'),
      cancel)
  );
}

/* -------------------------------------------------------------- Resumen */

function summaryView(s) {
  const { event: ev, items, guests, summary: m } = s;
  const nodes = [h('h1', {}, ev.name)];

  const statusText = {
    honoree: 'Esperando que el cumplimentado registre su consumo. Los invitados aún no pueden entrar.',
    open: 'Los invitados ya pueden registrar su consumo.',
    closed: 'Cobro cerrado: no se aceptan más registros.',
  }[ev.status];
  nodes.push(h('p', { class: 'lead' }, statusText));

  nodes.push(
    h('div', { class: 'cards' },
      card('Subtotal de ítems', money(m.subtotal)),
      card(`Propina (${pct(ev.tipPercent)})`, money(m.tip)),
      card('Total de la cuenta', money(m.invoiceTotal)),
      card('Consumo del cumplimentado', money(m.honoreeConsumption)),
      card('Recaudado (registrado)', money(m.collected)),
      card('Por recaudar', money(m.pending), m.pending !== 0 && ev.status === 'open'))
  );

  if (ev.status !== 'closed') {
    nodes.push(
      h('h2', {}, 'Enlaces para compartir'),
      h('div', { class: 'links' },
        linkRow('Cumplimentado', '/cumplimentado', ev.status !== 'honoree'),
        linkRow('Invitados', '/company', ev.status !== 'open'))
    );
  }

  nodes.push(
    h('h2', {}, 'Ítems'),
    h('div', { class: 'tablewrap' },
      h('table', {},
        h('thead', {}, h('tr', {}, ['Ítem', 'Valor', 'Total', 'Cumplimentado', 'Invitados', 'Disponibles'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
        h('tbody', {}, items.map((i) =>
          h('tr', {},
            h('td', {}, i.name),
            h('td', { class: 'num' }, money(i.price)),
            h('td', { class: 'num' }, i.qty),
            h('td', { class: 'num' }, i.honoreeQty),
            h('td', { class: 'num' }, i.guestsQty),
            h('td', { class: 'num' }, i.available)))))),
  );

  nodes.push(
    h('h2', {}, `Invitados registrados (${guests.length})`),
    guests.length
      ? h('div', { class: 'tablewrap' },
          h('table', {},
            h('thead', {}, h('tr', {}, ['Nombre', 'Consumo', 'Propina', 'Cumplimentado', 'Total', ''].map((t, i) => h('th', { class: i > 0 && i < 5 ? 'num' : '' }, t)))),
            h('tbody', {}, guests.map((g) =>
              h('tr', {},
                h('td', {}, g.name),
                h('td', { class: 'num' }, money(g.subtotal)),
                h('td', { class: 'num' }, money(g.tipShare)),
                h('td', { class: 'num' }, money(g.honoreeShare)),
                h('td', { class: 'num' }, h('strong', {}, money(g.total))),
                h('td', {}, ev.status === 'closed' ? null : h('button', {
                  type: 'button', class: 'btn danger small',
                  onClick: () => {
                    if (window.confirm(`¿Eliminar el registro de ${g.name}? Sus ítems quedarán disponibles de nuevo.`)) {
                      act(() => api(`/api/admin/guests/${g.id}`, { method: 'DELETE' }), 'Registro eliminado.');
                    }
                  },
                }, 'Eliminar')))))))
      : h('p', { class: 'muted' }, 'Todavía no hay invitados registrados.')
  );

  const actions = [];
  if (ev.status === 'honoree') {
    actions.push(h('button', {
      type: 'button', class: 'btn ghost',
      onClick: () => act(() => api('/api/admin/event/unpublish', { method: 'POST', body: {} }), 'Volviste a edición.'),
    }, 'Volver a editar la cuenta'));
  }
  if (ev.status === 'honoree' || ev.status === 'open') {
    actions.push(h('button', {
      type: 'button', class: 'btn danger',
      onClick: () => {
        if (window.confirm('Al cerrar el cobro nadie podrá registrar más consumos. ¿Cerrar?')) {
          act(() => api('/api/admin/event/close', { method: 'POST', body: {} }), 'Cobro cerrado.');
        }
      },
    }, 'Cerrar cobro'));
  }
  if (ev.status === 'closed') {
    actions.push(h('button', { type: 'button', class: 'btn', onClick: () => { creatingNew = true; load(); } }, 'Nueva cuenta'));
  }
  nodes.push(h('div', { class: 'actions' }, actions));
  return h('div', {}, nodes);
}

function card(k, v, alert = false) {
  return h('div', { class: `card${alert ? ' alert' : ''}` }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
}

function linkRow(label, path, dimmed) {
  const url = `${location.origin}${path}`;
  return h('div', { class: 'linkrow' },
    h('span', {}, h('strong', {}, label), dimmed ? h('span', { class: 'muted small' }, ' (aún no habilitado)') : null),
    h('code', {}, url),
    h('button', {
      type: 'button', class: 'btn ghost small',
      onClick: async () => {
        try { await navigator.clipboard.writeText(url); toast('Enlace copiado.'); }
        catch { toast('No se pudo copiar; selecciónalo manualmente.', true); }
      },
    }, 'Copiar'));
}

load().catch((err) => {
  clear(root);
  root.append(h('h1', {}, 'No se pudo cargar'), h('div', { class: 'notice' }, err.message));
});
