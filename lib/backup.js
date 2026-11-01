'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { quote } = require('./db');

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** Copia consistente de SQLite (VACUUM INTO) y poda de las más antiguas. */
function snapshot(db, dir, keep = 14) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `cuenta-${stamp()}.db`);
  db.exec(`VACUUM INTO ${quote(file)}`);
  const all = fs.readdirSync(dir).filter((f) => /^cuenta-.*\.db$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(dir, old), { force: true });
  return file;
}

function schedule(db, { dir, hours, keep }, log = console) {
  if (!hours || hours <= 0) return null;
  const run = () => {
    try {
      log.log(`Respaldo automático: ${snapshot(db, dir, keep)}`);
    } catch (err) {
      log.error('Falló el respaldo automático:', err.message);
    }
  };
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, hours * 3_600_000);
  first.unref();
  timer.unref();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}

module.exports = { snapshot, schedule };
