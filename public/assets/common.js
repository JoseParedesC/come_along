// Utilidades compartidas por las pantallas (sin dependencias).

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Token del enlace (?t=…) que identifica la cuenta en /cumplimentado y /company. */
export const token = new URLSearchParams(location.search).get('t') || '';
export const withToken = (path) => `${path}?t=${encodeURIComponent(token)}`;

export const config = await api('/api/config');

// Secuencia de entrada: solo durante la carga inicial; los re-renders posteriores no se animan.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (!reducedMotion) {
  document.documentElement.classList.add('is-entering');
  setTimeout(() => document.documentElement.classList.remove('is-entering'), 1400);
}
const moneyFmt = new Intl.NumberFormat(config.locale, { style: 'currency', currency: config.currency, maximumFractionDigits: 0 });
const pctFmt = new Intl.NumberFormat(config.locale, { maximumFractionDigits: 2 });
export const money = (n) => moneyFmt.format(n);
export const pct = (n) => `${pctFmt.format(n)} %`;

/** Constructor de nodos DOM; el texto siempre entra como texto (sin innerHTML). */
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const clear = (el) => el.replaceChildren();

let toastTimer;
export function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), isError ? 5000 : 2600);
}

/** Selector de cantidad con − / + y entrada numérica. `setMax` permite actualizar el tope en vivo. */
export function stepper({ max, value = 0, label = 'Cantidad', onChange = () => {} }) {
  let v = 0;
  let cap = max;
  const input = h('input', { type: 'number', min: 0, max, inputMode: 'numeric', 'aria-label': label });
  const minus = h('button', { type: 'button', class: 'step', 'aria-label': `Quitar uno: ${label}`, onClick: () => set(v - 1) }, '−');
  const plus = h('button', { type: 'button', class: 'step', 'aria-label': `Agregar uno: ${label}`, onClick: () => set(v + 1) }, '+');
  function set(n, silent = false) {
    const prev = v;
    n = Number.isFinite(n) ? Math.trunc(n) : 0;
    v = Math.max(0, Math.min(cap, n));
    if (!silent && v !== prev) {
      input.classList.remove('bump');
      void input.offsetWidth; // reinicia la animación
      input.classList.add('bump');
    }
    input.value = String(v);
    input.max = String(cap);
    minus.disabled = v <= 0;
    plus.disabled = v >= cap;
    if (!silent) onChange(v);
  }
  input.addEventListener('change', () => set(Number(input.value)));
  set(value, true);
  return {
    el: h('div', { class: 'stepper' }, minus, input, plus),
    get value() { return v; },
    get max() { return cap; },
    set,
    /** Devuelve true si tuvo que recortar la selección actual. */
    setMax(newMax) {
      cap = newMax;
      const clipped = v > cap;
      set(v, !clipped);
      return clipped;
    },
  };
}

const part = (label, amount, why) =>
  h('div', { class: 'part' },
    h('div', { class: 'row2' }, h('span', {}, label), h('span', {}, money(amount))),
    why ? h('p', { class: 'why' }, why) : null);

/** Ticket con el desglose de lo que paga un participante (reglas v2 y v1 históricas). */
export function ticket(b, { title = 'Tu total' } = {}) {
  const lines = h('ul', { class: 'lines' }, b.lines.map((l) =>
    h('li', {}, h('span', {}, `${l.qty} × ${l.name}`), h('span', {}, money(l.amount)))));
  const total = h('div', { class: 'total' },
    h('span', { class: 'label' }, 'Total a pagar'), h('span', { class: 'amount' }, money(b.total)));

  if (b.kind === 'v2') {
    return h('section', { class: 'ticket', 'aria-label': title },
      h('h2', {}, title), lines,
      part('Tu consumo', b.subtotal),
      b.tipShare > 0 ? part('Tu parte de la propina', b.tipShare, `Se divide en partes iguales entre los ${b.payers} participantes que pagan.`) : null,
      b.othersShare > 0 ? part('Tu parte del consumo de exentos e invitados', b.othersShare, `También en partes iguales entre los ${b.payers} que pagan.`) : null,
      b.adjustment > 0 ? part('Ajuste de fracciones y redondeo', b.adjustment, 'Tu total se redondea una sola vez a la siguiente centena.') : null,
      total);
  }
  return h('section', { class: 'ticket', 'aria-label': title },
    h('h2', {}, title), lines,
    part('Tu consumo', b.subtotal),
    part('Tu parte de la propina', b.tipShare, `Propina del ${pct(b.tipPercent)} sobre la cuenta; te corresponde el ${pct(b.sharePercent)}.`),
    part('Tu parte de lo que consumió el cumplimentado', b.honoreeShare, `Su consumo se reparte y te corresponde el ${pct(b.sharePercent)}.`),
    total);
}

/* ------------------------------------------------ Cuentas cruzadas */

/** «A le debe $5.000 a B» (solo cuando ya se registraron todos los participantes). */
export function transfersTicket(c) {
  const items = c.complete
    ? c.transfers.length
      ? c.transfers.map((t) =>
          h('li', {}, h('strong', {}, t.from.name), ' le debe ', h('span', { class: 'amt' }, money(t.amount)), ' a ', h('strong', {}, t.to.name)))
      : [h('li', {}, 'Las cuentas están al día: nadie le debe nada a nadie.')]
    : [h('li', { class: 'wait' }, `Los pagos se calculan cuando se registren los ${c.participants} participantes (faltan ${c.pending}).`)];
  return h('section', { class: 'ticket', 'aria-label': 'Quién le paga a quién' },
    h('h2', {}, 'Quién le paga a quién'), h('ul', { class: 'xfers' }, items));
}

export function balanceBadge(balance, provisional) {
  if (balance === 0) return h('span', { class: 'badge ok' }, 'Al día');
  const txt = balance > 0 ? `Le deben ${money(balance)}` : `Debe ${money(-balance)}`;
  return h('span', { class: `badge ${balance > 0 ? 'ok' : 'warn'}`, title: provisional ? 'Provisional: faltan participantes por registrar' : null }, provisional ? `${txt} *` : txt);
}

/** Lista de participantes con lo que pagó, su cuota y su saldo. */
export function crossMembers(c) {
  return h('div', { class: 'panel' },
    h('ul', { class: 'list' }, c.members.map((m) =>
      h('li', { class: 'item' },
        h('div', {},
          h('div', { class: 'name' }, m.name),
          h('div', { class: 'meta' }, `Pagó ${money(m.paid)} · Su parte ${money(m.share)}`),
          m.expenses.length ? h('div', { class: 'meta' }, m.expenses.map((x) => `${x.description} ${money(x.amount)}`).join(' · ')) : null),
        balanceBadge(m.balance, !c.complete)))),
    c.complete ? null : h('p', { class: 'muted small' }, '* Saldo provisional: cambia cuando se registren todos los participantes.'));
}
