import { api, h, clear, money, pct, toast } from '/assets/common.js';

const root = document.getElementById('app');
let events = [];
let currentId = Number(new URLSearchParams(location.search).get('e')) || null;
let creatingNew = false;
let editing = false;

const STEPS = [
  ['setup', 'Registrar la cuenta'],
  ['honoree', 'Consumo de exentos e invitados'],
  ['open', 'Cobro a participantes'],
  ['closed', 'Cerrada'],
];
const STATUS_LABEL = { setup: 'Borrador', honoree: 'Esperando consumos', open: 'Cobrando', closed: 'Cerrada' };

/* ----------------------------------------------------------- Carga */

async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.status === 401) return void (location.href = '/admin/login');
    throw err;
  }
}

async function load(id = currentId) {
  await guard(async () => {
    events = (await api('/api/admin/events')).events;
    if (!events.length) {
      currentId = null;
      return render(null);
    }
    if (!events.some((e) => e.id === id)) id = events[0].id;
    currentId = id;
    history.replaceState(null, '', `/admin?e=${id}`);
    render(await api(`/api/admin/events/${id}`));
  });
}

async function act(fn, okMsg) {
  try {
    const out = await guard(fn);
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(out) : okMsg);
    await load();
  } catch (err) {
    toast(err.message, true);
  }
}

/* --------------------------------------------------------- Estructura */

function render(s) {
  clear(root);
  root.append(toolbar());
  if (!s || creatingNew) {
    root.append(stepsBar('setup'), h('h1', {}, 'Nueva cuenta'), formView(null, 'new'));
    return;
  }
  const st = s.event.status;
  root.append(stepsBar(st));
  if (st === 'setup') root.append(h('h1', {}, 'Registrar la cuenta'), formView(s, 'setup'));
  else if (editing && st !== 'closed') root.append(h('h1', {}, `Editar: ${s.event.name}`), formView(s, 'live'));
  else root.append(summaryView(s));
}

function toolbar() {
  const select = h('select', {
    id: 'ev-select',
    onChange: (e) => { creatingNew = false; editing = false; load(Number(e.target.value)); },
  }, events.map((e) =>
    h('option', { value: e.id, selected: e.id === currentId },
      `${e.name} · ${STATUS_LABEL[e.status]} · ${String(e.createdAt).slice(0, 10)}`)));
  return h('div', { class: 'toolbar noprint' },
    events.length ? h('div', { class: 'field' }, h('label', { for: 'ev-select' }, 'Cuenta'), select) : null,
    h('button', { type: 'button', class: 'btn ghost small', onClick: () => { creatingNew = true; editing = false; load(); } }, 'Nueva cuenta'),
    h('a', { class: 'btn ghost small', href: '/api/admin/backup', download: '' }, 'Descargar respaldo'),
    h('button', {
      type: 'button', class: 'btn ghost small',
      onClick: async () => { await api('/api/admin/logout', { method: 'POST', body: {} }); location.href = '/admin/login'; },
    }, 'Salir'));
}

function stepsBar(status) {
  const idx = STEPS.findIndex(([k]) => k === status);
  return h('ol', { class: 'steps', 'aria-label': 'Estado de la cuenta' },
    STEPS.map(([k, label], i) =>
      h('li', { class: i < idx ? 'done' : i === idx ? 'now' : '', 'aria-current': i === idx ? 'step' : null }, label)));
}

/* ------------------------------------------------------- Formulario */

function nameList(title, initial, onChange, readOnly) {
  const box = h('div', { class: 'namelist' });
  const inputs = [];
  const add = (value = '') => {
    const input = h('input', { type: 'text', maxLength: 60, value, placeholder: 'Nombre', 'aria-label': title, disabled: readOnly });
    input.addEventListener('input', onChange);
    const row = h('div', { class: 'namerow' }, input, readOnly ? null : h('button', {
      type: 'button', class: 'x', 'aria-label': `Quitar de ${title}`,
      onClick: () => { inputs.splice(inputs.indexOf(input), 1); row.remove(); onChange(); },
    }, '×'));
    inputs.push(input);
    box.append(row);
  };
  initial.forEach(add);
  return {
    el: h('div', {}, h('label', {}, title), box,
      readOnly ? null : h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn ghost small', onClick: () => { add(); onChange(); } }, 'Agregar'))),
    values: () => inputs.map((i) => i.value.trim()).filter(Boolean),
  };
}

function formView(s, mode) {
  const ev = s && s.event;
  const live = mode === 'live';
  const rows = [];

  const nameIn = h('input', { type: 'text', id: 'ev-name', maxLength: 80, value: ev ? ev.name : '', placeholder: 'Ej. Cena de cumpleaños' });
  const payersIn = h('input', { type: 'number', id: 'ev-payers', min: 0, max: 500, step: 1, inputMode: 'numeric', value: String(ev ? ev.payersCount : '') });
  const rowsEl = h('div', { class: 'rows' });
  const peopleSummary = h('dl', { class: 'kv' });
  const previewEl = h('dl', { class: 'kv' });

  const exempt = nameList('Exentos (no pagan)', s ? s.people.filter((p) => p.kind === 'exempt').map((p) => p.name) : [], update, live);
  const guests = nameList('Invitados (no pagan; no cuentan como pagadores)', s ? s.people.filter((p) => p.kind === 'guest').map((p) => p.name) : [], update, live);

  const readItems = () => rows.map((r) => ({
    id: r.id, name: r.name.value.trim(), price: Number(r.price.value), qty: Number(r.qty.value), isTip: r.tip.checked,
  }));

  function update() {
    const items = readItems();
    const sum = (arr) => arr.reduce((a, i) => a + (Number.isFinite(i.price * i.qty) ? i.price * i.qty : 0), 0);
    const consumo = sum(items.filter((i) => !i.isTip));
    const tip = sum(items.filter((i) => i.isTip));
    const payers = Number(payersIn.value) || 0;
    const ne = exempt.values().length;
    const ng = guests.values().length;
    clear(peopleSummary);
    peopleSummary.append(
      h('dt', {}, 'Participantes que pagan'), h('dd', {}, payers),
      h('dt', {}, 'Exentos'), h('dd', {}, ne),
      h('dt', {}, 'Invitados'), h('dd', {}, ng),
      h('dt', { class: 'strong' }, 'Total de personas'), h('dd', { class: 'strong' }, payers + ne + ng));
    clear(previewEl);
    previewEl.append(
      h('dt', {}, 'Consumos (sin propina)'), h('dd', {}, money(consumo)),
      h('dt', {}, 'Propina (ítems marcados)'), h('dd', {}, money(tip)),
      h('dt', { class: 'strong' }, 'Total de la cuenta'), h('dd', { class: 'strong' }, money(consumo + tip)));
  }

  function addRow(item = { id: null, name: '', price: '', qty: 1, isTip: false }) {
    const r = {
      id: item.id,
      name: h('input', { type: 'text', maxLength: 80, value: item.name, placeholder: 'Ej. Pizza', 'aria-label': 'Nombre del ítem' }),
      price: h('input', { type: 'number', min: 0, step: 1, inputMode: 'numeric', value: String(item.price), placeholder: '0', 'aria-label': 'Valor unitario' }),
      qty: h('input', { type: 'number', min: 1, step: 1, inputMode: 'numeric', value: String(item.qty), 'aria-label': 'Cantidad' }),
      tip: h('input', { type: 'checkbox', checked: !!item.isTip }),
    };
    r.el = h('div', { class: 'row' },
      h('div', { class: 'nm' }, r.name), r.price, r.qty,
      h('label', { class: 'tipbox' }, r.tip, 'Propina'),
      h('button', {
        type: 'button', class: 'x', 'aria-label': 'Quitar ítem',
        onClick: () => { rows.splice(rows.indexOf(r), 1); r.el.remove(); if (!rows.length) addRow(); update(); },
      }, '×'));
    [r.name, r.price, r.qty].forEach((i) => i.addEventListener('input', update));
    r.tip.addEventListener('change', update);
    rows.push(r);
    rowsEl.append(r.el);
  }

  async function save(publish) {
    const items = readItems().filter((i) => i.name || (Number.isFinite(i.price) && i.price > 0));
    const payersCount = Number(payersIn.value);
    if (!items.length) return toast('Agrega al menos un ítem.', true);
    for (const i of items) {
      if (!i.name) return toast('Todos los ítems necesitan un nombre.', true);
      if (!Number.isInteger(i.price) || i.price < 0) return toast(`"${i.name}": el valor debe ser un número entero.`, true);
      if (!Number.isInteger(i.qty) || i.qty < 1) return toast(`"${i.name}": la cantidad debe ser al menos 1.`, true);
    }
    if (!items.some((i) => !i.isTip)) return toast('Debe haber al menos un ítem de consumo (no propina).', true);
    if (!Number.isInteger(payersCount) || payersCount < 0) return toast('Indica cuántos participantes pagan.', true);
    if (publish && payersCount < 1) return toast('Para habilitar, indica al menos 1 participante que paga.', true);
    if (live && !window.confirm('Se recalcularán las cuotas ya registradas. ¿Guardar los cambios?')) return;
    if (publish && !window.confirm('Al habilitar, la cuenta ya no se podrá editar libremente y se abrirá el registro de consumos. ¿Continuar?')) return;

    const payload = { name: nameIn.value.trim() || 'Cuenta', payersCount, exempt: exempt.values(), guests: guests.values(), items };
    await act(async () => {
      let id = ev && ev.id;
      if (mode === 'new') id = (await api('/api/admin/events', { method: 'POST', body: payload })).event.id;
      else await api(`/api/admin/events/${id}`, { method: 'PUT', body: payload });
      if (publish) await api(`/api/admin/events/${id}/publish`, { method: 'POST', body: {} });
      creatingNew = false;
      editing = false;
      currentId = id;
    }, publish ? 'Cuenta habilitada.' : live ? 'Cambios guardados y cuotas recalculadas.' : 'Borrador guardado.');
  }

  payersIn.addEventListener('input', update);
  const initial = s && s.items.length
    ? s.items.map((i) => ({ id: i.id, name: i.name, price: i.price, qty: i.qty, isTip: i.isTip }))
    : [{ id: null, name: '', price: '', qty: 1, isTip: false }];
  initial.forEach(addRow);
  update();

  const cancel = creatingNew || live
    ? h('button', { type: 'button', class: 'btn ghost', onClick: () => { creatingNew = false; editing = false; load(); } }, 'Cancelar')
    : null;

  return h('div', {},
    h('div', { class: 'panel' },
      h('div', { class: 'two' },
        h('div', { class: 'field' }, h('label', { for: 'ev-name' }, 'Nombre de la cuenta'), nameIn),
        h('div', { class: 'field' }, h('label', { for: 'ev-payers' }, 'Participantes que pagan'), payersIn)),
      h('p', { class: 'muted small' }, 'Cuenta solo a quienes pagan; exentos e invitados no se incluyen en este número.')),
    h('h2', {}, 'Personas que no pagan'),
    live ? h('p', { class: 'muted small' }, 'Las listas de exentos e invitados solo se editan antes de habilitar la cuenta.') : null,
    h('div', { class: 'panel' }, h('div', { class: 'three' }, exempt.el, guests.el)),
    h('h2', {}, 'Ítems de la factura'),
    h('div', { class: 'panel' },
      h('p', { class: 'muted small' }, 'Marca como “Propina” la línea de propina o servicio. No hay porcentaje automático: escribe su valor.'),
      h('div', { class: 'row head', 'aria-hidden': 'true' }, h('span', {}, 'Ítem'), h('span', {}, 'Valor unitario'), h('span', {}, 'Cant.'), h('span', {}, 'Tipo'), h('span')),
      rowsEl,
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn ghost small', onClick: () => addRow() }, 'Agregar ítem'))),
    h('h2', {}, 'Resumen'),
    h('div', { class: 'panel' }, peopleSummary, h('hr'), previewEl),
    h('div', { class: 'actions' },
      live
        ? h('button', { type: 'button', class: 'btn grow', onClick: () => save(false) }, 'Guardar cambios y recalcular')
        : h('button', { type: 'button', class: 'btn grow', onClick: () => save(true) }, 'Guardar y habilitar'),
      live ? null : h('button', { type: 'button', class: 'btn ghost', onClick: () => save(false) }, 'Guardar borrador'),
      cancel));
}

/* ------------------------------------------------------------ Resumen */

const card = (k, v, alert = false) =>
  h('div', { class: `card${alert ? ' alert' : ''}` }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));

function summaryView(s) {
  const { event: ev, items, people, guests, summary: m } = s;
  const v2 = ev.rulesVersion === 2;
  const nodes = [h('h1', {}, ev.name)];
  nodes.push(h('p', { class: 'print-only' }, `Cuenta del ${new Date().toLocaleDateString()} · ${STATUS_LABEL[ev.status]}`));
  nodes.push(h('p', { class: 'lead' }, {
    honoree: 'Esperando que exentos e invitados registren su consumo. Los participantes aún no pueden entrar.',
    open: 'Los participantes ya pueden registrar su consumo.',
    closed: 'Cobro cerrado: no se aceptan más registros.',
  }[ev.status]));
  if (!v2) nodes.push(h('div', { class: 'pill-note' }, `Cuenta histórica con propina del ${pct(ev.tipPercent)} y reparto proporcional (reglas anteriores). No es editable.`));

  const allIn = m.payersRegistered === m.payersCount;
  nodes.push(h('div', { class: 'cards' },
    card('Total de la cuenta', money(m.invoiceTotal)),
    card(v2 ? 'Propina (ítems marcados)' : `Propina (${pct(ev.tipPercent)})`, money(m.tipTotal)),
    card('Consumo de exentos', money(m.exemptConsumption)),
    card(v2 ? 'Consumo de invitados' : 'Consumo del cumplimentado', money(m.guestConsumption)),
    v2 ? card('Parte igual por pagador', money(Math.round(m.sharePerPayer))) : null,
    v2 ? card('Participantes registrados', `${m.payersRegistered} / ${m.payersCount}`, ev.status === 'open' && !allIn) : null,
    card('Recaudo registrado', money(m.collected)),
    card('Pagado', money(m.paid)),
    card('Por conciliar', money(m.awaitingPayment), m.awaitingPayment > 0),
    v2 ? card('Diferencia por redondeo', money(Math.round(m.roundingDiff))) : null,
    card('Recaudo − factura', money(m.difference))));

  if (ev.status !== 'closed' && m.unclaimedUnits > 0) {
    nodes.push(h('div', { class: 'pill-note' }, `Hay ${m.unclaimedUnits} unidad(es) sin asignar a nadie (${money(m.unclaimedValue)}). El recaudo no igualará la factura hasta que se asignen.`));
  }

  if (ev.status !== 'closed') {
    const rotate = h('button', {
      type: 'button', class: 'btn danger small',
      onClick: () => {
        if (window.confirm('Los enlaces actuales dejarán de funcionar. ¿Generar enlaces nuevos?')) {
          act(() => api(`/api/admin/events/${ev.id}/tokens/rotate`, { method: 'POST', body: {} }), 'Enlaces nuevos generados.');
        }
      },
    }, 'Regenerar enlaces');
    nodes.push(
      h('h2', { class: 'noprint' }, 'Enlaces para compartir'),
      h('div', { class: 'links noprint' },
        people.length ? linkRow('Exentos e invitados', ev.links.honoree, ev.status === 'open' ? 'ya registraron todos' : null) : null,
        linkRow('Participantes que pagan', ev.links.company, ev.status === 'honoree' ? 'aún no habilitado' : null),
        h('div', {}, rotate)));
  }

  if (people.length) {
    nodes.push(h('h2', {}, 'Exentos e invitados'),
      h('div', { class: 'tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Nombre', 'Tipo', 'Estado', 'Consumo'].map((t, i) => h('th', { class: i === 3 ? 'num' : '' }, t)))),
        h('tbody', {}, people.map((p) => h('tr', {},
          h('td', {}, p.name),
          h('td', {}, p.kind === 'exempt' ? 'Exento' : 'Invitado'),
          h('td', {}, h('span', { class: `badge ${p.registered ? 'ok' : 'warn'}` }, p.registered ? 'Registrado' : 'Pendiente')),
          h('td', { class: 'num' }, money(p.consumption))))))));
  }

  nodes.push(
    h('h2', {}, 'Ítems'),
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Ítem', 'Valor', 'Total', 'Exentos/inv.', 'Participantes', 'Disponibles'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
      h('tbody', {}, items.map((i) => h('tr', {},
        h('td', {}, i.name, i.isTip ? h('span', { class: 'badge' }, 'Propina') : null),
        h('td', { class: 'num' }, money(i.price)),
        h('td', { class: 'num' }, i.qty),
        h('td', { class: 'num' }, i.isTip ? '—' : i.peopleQty),
        h('td', { class: 'num' }, i.isTip ? '—' : i.guestsQty),
        h('td', { class: 'num' }, i.isTip ? '—' : i.available)))))));

  nodes.push(
    h('h2', {}, `Participantes registrados (${guests.length}${v2 ? ` de ${m.payersCount}` : ''})`),
    guests.length ? guestsTable(ev, guests, v2) : h('p', { class: 'muted' }, 'Todavía no hay participantes registrados.'));

  const actions = [];
  if (v2 && ev.status === 'honoree' && !people.some((p) => p.registered)) {
    actions.push(h('button', { type: 'button', class: 'btn ghost', onClick: () => act(() => api(`/api/admin/events/${ev.id}/unpublish`, { method: 'POST', body: {} }), 'Volviste a borrador.') }, 'Volver a borrador'));
  }
  if (v2 && (ev.status === 'honoree' || ev.status === 'open')) {
    actions.push(h('button', { type: 'button', class: 'btn ghost', onClick: () => { editing = true; load(); } }, 'Editar ítems y pagadores'));
  }
  actions.push(h('a', { class: 'btn ghost', href: `/api/admin/events/${ev.id}/export.csv`, download: '' }, 'Exportar CSV'));
  actions.push(h('button', { type: 'button', class: 'btn ghost', onClick: () => window.print() }, 'Imprimir / guardar PDF'));
  if (ev.status === 'honoree' || ev.status === 'open') {
    actions.push(h('button', {
      type: 'button', class: 'btn danger',
      onClick: () => {
        if (window.confirm('Al cerrar el cobro nadie podrá registrar más consumos. ¿Cerrar?')) {
          act(() => api(`/api/admin/events/${ev.id}/close`, { method: 'POST', body: {} }), 'Cobro cerrado.');
        }
      },
    }, 'Cerrar cobro'));
  }
  nodes.push(h('div', { class: 'actions' }, actions));
  return h('div', {}, nodes);
}

function guestsTable(ev, guests, v2) {
  const heads = ['Nombre', 'Consumo', 'Propina', v2 ? 'Exentos/inv.' : 'Cumplimentado', 'Total', 'Pagado', ''];
  return h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, heads.map((t, i) => h('th', { class: i > 0 && i < 5 ? 'num' : '' }, t)))),
    h('tbody', {}, guests.map((g) => h('tr', {},
      h('td', {}, g.name, h('div', { class: 'muted small' }, g.items.map((i) => `${i.qty}× ${i.name}`).join(', '))),
      h('td', { class: 'num' }, money(g.subtotal)),
      h('td', { class: 'num' }, money(g.tipShare)),
      h('td', { class: 'num' }, money(g.othersShare)),
      h('td', { class: 'num' }, h('strong', {}, money(g.total))),
      h('td', {}, ev.status === 'closed' && !g.paidAt ? '—' : h('label', { class: 'tipbox' },
        h('input', {
          type: 'checkbox', checked: !!g.paidAt, 'aria-label': `Pagado: ${g.name}`,
          onChange: (e) => act(() => api(`/api/admin/events/${ev.id}/guests/${g.id}/paid`, { method: 'POST', body: { paid: e.target.checked } })),
        }))),
      h('td', {}, ev.status === 'closed' ? null : h('button', {
        type: 'button', class: 'btn danger small noprint',
        onClick: () => {
          if (window.confirm(`¿Eliminar el registro de ${g.name}? Sus ítems quedarán disponibles de nuevo.`)) {
            act(() => api(`/api/admin/events/${ev.id}/guests/${g.id}`, { method: 'DELETE' }), 'Registro eliminado.');
          }
        },
      }, 'Eliminar')))))));
}

function linkRow(label, path, note) {
  const url = `${location.origin}${path}`;
  return h('div', { class: 'linkrow' },
    h('span', {}, h('strong', {}, label), note ? h('span', { class: 'muted small' }, ` (${note})`) : null),
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
