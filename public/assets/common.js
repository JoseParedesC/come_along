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
    n = Number.isFinite(n) ? Math.trunc(n) : 0;
    v = Math.max(0, Math.min(cap, n));
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
