import { api, h, clear, toast } from '/assets/common.js';

const root = document.getElementById('app');

async function init() {
  const s = await api('/api/admin/session');
  if (!s.required || s.authenticated) return void (location.href = '/admin');
  const pass = h('input', { type: 'password', id: 'pw', autocomplete: 'current-password', required: true });
  const btn = h('button', { type: 'submit', class: 'btn grow' }, 'Entrar');
  const form = h('form', { class: 'panel loginbox', onSubmit: async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      await api('/api/admin/login', { method: 'POST', body: { password: pass.value } });
      location.href = '/admin';
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
      pass.select();
    }
  } },
    h('h1', {}, 'Administrador'),
    h('div', { class: 'field' }, h('label', { for: 'pw' }, 'Contraseña'), pass),
    h('div', { class: 'actions' }, btn));
  clear(root);
  root.append(form);
  pass.focus();
}
init().catch((e) => { clear(root); root.append(h('div', { class: 'notice' }, e.message)); });
