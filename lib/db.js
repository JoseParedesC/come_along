'use strict';
const crypto = require('node:crypto');
const { Pool, types } = require('pg');

// int8 (BIGINT, COUNT) y numeric (SUM de enteros) llegan como número, no como texto.
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id            SERIAL PRIMARY KEY,
  name          TEXT             NOT NULL,
  tip_percent   DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (tip_percent >= 0 AND tip_percent <= 100),
  status        TEXT             NOT NULL DEFAULT 'setup' CHECK (status IN ('setup','honoree','open','closed')),
  rules_version INTEGER          NOT NULL DEFAULT 2,
  payers_count  INTEGER          NOT NULL DEFAULT 0,
  honoree_token TEXT             NOT NULL UNIQUE,
  company_token TEXT             NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS items (
  id         SERIAL PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  unit_price BIGINT  NOT NULL CHECK (unit_price >= 0),
  qty        INTEGER NOT NULL CHECK (qty > 0),
  is_tip     BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS people (
  id            SERIAL PRIMARY KEY,
  event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN ('exempt','guest')),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  registered_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS person_items (
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  item_id   INTEGER NOT NULL REFERENCES items(id)  ON DELETE CASCADE,
  qty       INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (person_id, item_id)
);
CREATE TABLE IF NOT EXISTS guests (
  id            SERIAL PRIMARY KEY,
  event_id      INTEGER          NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name          TEXT             NOT NULL,
  subtotal      BIGINT           NOT NULL,
  tip_share     BIGINT           NOT NULL,
  honoree_share BIGINT           NOT NULL,
  total         BIGINT           NOT NULL,
  calc_exact    DOUBLE PRECISION,
  rounding_diff DOUBLE PRECISION,
  paid_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guest_items (
  guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  item_id  INTEGER NOT NULL REFERENCES items(id)  ON DELETE CASCADE,
  qty      INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (guest_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_items_event       ON items(event_id);
CREATE INDEX IF NOT EXISTS idx_people_event      ON people(event_id);
CREATE INDEX IF NOT EXISTS idx_guests_event      ON guests(event_id);
CREATE INDEX IF NOT EXISTS idx_person_items_item ON person_items(item_id);
CREATE INDEX IF NOT EXISTS idx_guest_items_item  ON guest_items(item_id);
`;

const newToken = () => crypto.randomBytes(18).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ejecutor mínimo sobre un Pool o un Client: all (filas), get (primera fila), run (filas afectadas). */
const executor = (target) => ({
  all: async (text, params = []) => (await target.query(text, params)).rows,
  get: async (text, params = []) => (await target.query(text, params)).rows[0],
  run: async (text, params = []) => (await target.query(text, params)).rowCount,
});

/**
 * Conexión a PostgreSQL (DATABASE_URL). Railway la inyecta al referenciar el servicio Postgres.
 * DATABASE_SSL=true activa TLS (solo necesario con la URL pública; la interna *.railway.internal no lo requiere).
 */
function createDb(log = console) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL (cadena de conexión de PostgreSQL).');
  const pool = new Pool({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (err) => log.error('Error en una conexión inactiva de PostgreSQL:', err.message));

  /** Transacción: `fn` recibe un ejecutor ligado a una única conexión. */
  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(executor(client));
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* la conexión ya estaba rota */ }
      throw err;
    } finally {
      client.release();
    }
  }

  /** Crea el esquema (idempotente). Reintenta mientras la base de datos termina de arrancar. */
  async function init({ retries = 10, delayMs = 3000 } = {}) {
    for (let attempt = 1; ; attempt++) {
      try {
        await tx(async (q) => {
          await q.run('SELECT pg_advisory_xact_lock(6242001)'); // evita carreras si arrancan dos instancias a la vez
          await q.run(SCHEMA);
        });
        return;
      } catch (err) {
        if (attempt >= retries) throw err;
        log.error(`PostgreSQL no disponible (intento ${attempt}/${retries}): ${err.message}`);
        await sleep(delayMs);
      }
    }
  }

  return { ...executor(pool), tx, init, close: () => pool.end() };
}

module.exports = { createDb, newToken };
