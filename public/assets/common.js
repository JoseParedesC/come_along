// Utilidades compartidas por las tres pantallas (sin dependencias).

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

export const config = await api('/api/config');
const moneyFmt = new Intl.NumberFormat(config.locale, {
  style: 'currency',
  currency: config.currency,
  maximumFractionDigits: 0,
});
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

/** Selector de cantidad con − / + y entrada numérica. */
export function stepper({ max, value = 0, label = 'Cantidad', onChange = () => {} }) {
  let v = 0;
  const input = h('input', { type: 'number', min: 0, max, inputMode: 'numeric', 'aria-label': label });
  const minus = h('button', { type: 'button', class: 'step', 'aria-label': `Quitar uno: ${label}`, onClick: () => set(v - 1) }, '−');
  const plus = h('button', { type: 'button', class: 'step', 'aria-label': `Agregar uno: ${label}`, onClick: () => set(v + 1) }, '+');
  function set(n, silent = false) {
    n = Number.isFinite(n) ? Math.trunc(n) : 0;
    v = Math.max(0, Math.min(max, n));
    input.value = String(v);
    minus.disabled = v <= 0;
    plus.disabled = v >= max;
    if (!silent) onChange(v);
  }
  input.addEventListener('change', () => set(Number(input.value)));
  set(value, true);
  return { el: h('div', { class: 'stepper' }, minus, input, plus), get value() { return v; }, set };
}

/** Ticket con el desglose de lo que paga un invitado. */
export function ticket(b, { title = 'Tu total' } = {}) {
  return h(
    'section',
    { class: 'ticket', 'aria-label': title },
    h('h2', {}, title),
    h('ul', { class: 'lines' }, b.lines.map((l) =>
      h('li', {}, h('span', {}, `${l.qty} × ${l.name}`), h('span', {}, money(l.amount))))),
    h('div', { class: 'part' },
      h('div', { class: 'row2' }, h('span', {}, 'Tu consumo'), h('span', {}, money(b.subtotal)))),
    h('div', { class: 'part' },
      h('div', { class: 'row2' }, h('span', {}, 'Tu parte de la propina'), h('span', {}, money(b.tipShare))),
      h('p', { class: 'why' }, `Propina del ${pct(b.tipPercent)} sobre la cuenta; te corresponde el ${pct(b.sharePercent)}.`)),
    h('div', { class: 'part' },
      h('div', { class: 'row2' }, h('span', {}, 'Tu parte de lo que consumió el cumplimentado'), h('span', {}, money(b.honoreeShare))),
      h('p', { class: 'why' }, `El cumplimentado no paga; su consumo se reparte y te corresponde el ${pct(b.sharePercent)}.`)),
    h('div', { class: 'total' },
      h('span', { class: 'label' }, 'Total a pagar'),
      h('span', { class: 'amount' }, money(b.total)))
  );
}
