#!/usr/bin/env node
// Verifica un despliegue (p. ej. Railway):  node scripts/verify-deploy.mjs https://tu-app.up.railway.app [CONTRASEÑA_ADMIN]
// Comprueba HTTPS, /health, cabeceras de seguridad, rutas públicas, sesión de admin y cookie Secure.
const [, , rawUrl, password] = process.argv;
if (!rawUrl) { console.error('Uso: node scripts/verify-deploy.mjs <URL> [contraseña_admin]'); process.exit(2); }
const base = rawUrl.replace(/\/+$/, '');
const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)/.test(base);
let failed = 0;
const check = async (name, fn) => {
  try { const note = await fn(); console.log(`  ✓ ${name}${note ? ` — ${note}` : ''}`); }
  catch (e) { failed++; console.log(`  ✗ ${name} — ${e.message}`); }
};
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

console.log(`Verificando ${base}`);
await check('usa HTTPS', async () => { must(isLocal || base.startsWith('https://'), 'la URL pública debe ser https://'); return isLocal ? 'local (omitido)' : ''; });
await check('GET /health = 200 {status:"ok"}', async () => {
  const r = await fetch(`${base}/health`); must(r.status === 200, `status ${r.status}`);
  must((await r.json()).status === 'ok', 'cuerpo inesperado');
});
await check('cabeceras de seguridad', async () => {
  const r = await fetch(`${base}/health`);
  must(r.headers.get('x-content-type-options') === 'nosniff', 'falta X-Content-Type-Options');
  must(/default-src 'self'/.test(r.headers.get('content-security-policy') || ''), 'falta CSP');
  if (!isLocal) must(r.headers.get('strict-transport-security'), 'falta HSTS (¿NODE_ENV=production?)');
});
if (!isLocal) await check('http:// redirige a https:// (o no responde)', async () => {
  try {
    const r = await fetch(base.replace('https://', 'http://') + '/health', { redirect: 'manual' });
    must(r.status >= 300 && r.status < 400, `responde ${r.status} sin redirigir`);
  } catch { return 'puerto 80 cerrado'; }
});
await check('/company y /cumplimentado cargan; sin token no exponen datos', async () => {
  for (const p of ['/company', '/cumplimentado', '/admin/login']) must((await fetch(base + p)).status === 200, `${p} no responde 200`);
  must((await (await fetch(`${base}/api/company`)).json()).status === 'invalid', 'la API pública sin token debe responder "invalid"');
});
await check('/admin exige sesión y la API de admin responde 401', async () => {
  const r = await fetch(`${base}/admin`, { redirect: 'manual' });
  must(r.status === 302 && r.headers.get('location') === '/admin/login', `/admin respondió ${r.status} (¿falta ADMIN_PASSWORD?)`);
  must((await fetch(`${base}/api/admin/events`)).status === 401, 'la API de admin no exige sesión');
});
if (password) {
  await check('login de admin con cookie HttpOnly + SameSite' + (isLocal ? '' : ' + Secure'), async () => {
    const r = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    must(r.status === 200, `login respondió ${r.status}`);
    const c = r.headers.get('set-cookie') || '';
    must(/HttpOnly/.test(c) && /SameSite=Strict/.test(c), 'cookie sin HttpOnly/SameSite');
    if (!isLocal) must(/Secure/.test(c), 'cookie sin Secure');
    const ev = await fetch(`${base}/api/admin/events`, { headers: { Cookie: c.split(';')[0] } });
    must(ev.status === 200, `la sesión no funcionó (${ev.status})`);
    return `${(await ev.json()).events.length} cuenta(s) en la BD`;
  });
} else console.log('  (sin contraseña: se omite la prueba de sesión de admin)');
console.log(failed ? `\n${failed} comprobación(es) fallaron` : '\nTodo en orden');
console.log('Pendiente de verificar a mano: persistencia tras un redeploy (crea una cuenta, redespliega, confirma que sigue).');
process.exit(failed ? 1 : 0);
