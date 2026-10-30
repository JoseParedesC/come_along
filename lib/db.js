'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  tip_percent REAL    NOT NULL DEFAULT 10 CHECK (tip_percent >= 0 AND tip_percent <= 100),
  status      TEXT    NOT NULL DEFAULT 'setup' CHECK (status IN ('setup','honoree','open','closed')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  qty        INTEGER NOT NULL CHECK (qty > 0),
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS honoree_items (
  item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  qty     INTEGER NOT NULL CHECK (qty > 0)
);
CREATE TABLE IF NOT EXISTS guests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  subtotal      INTEGER NOT NULL,
  tip_share     INTEGER NOT NULL,
  honoree_share INTEGER NOT NULL,
  total         INTEGER NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS guest_items (
  guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  item_id  INTEGER NOT NULL REFERENCES items(id)  ON DELETE CASCADE,
  qty      INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (guest_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_items_event  ON items(event_id);
CREATE INDEX IF NOT EXISTS idx_guests_event ON guests(event_id);
`;

const newToken = () => crypto.randomBytes(18).toString('base64url');
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function hasColumn(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}
function addColumn(db, table, def) {
  const col = def.split(/\s+/)[0];
  if (!hasColumn(db, table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`);
}

/**
 * Migración 1 (idempotente, no destructiva):
 *  - rules_version: las cuentas existentes quedan en 1 (reglas históricas); las nuevas usan 2.
 *  - payers_count, tokens de enlace, is_tip, pagos y trazabilidad de redondeo.
 *  - people/person_items: el antiguo "cumplimentado" pasa a ser una persona exenta y su consumo se copia.
 *  - honoree_items se conserva sin tocar como respaldo.
 */
function migrate1(db) {
  addColumn(db, 'events', 'rules_version INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'events', 'payers_count INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'events', 'honoree_token TEXT');
  addColumn(db, 'events', 'company_token TEXT');
  addColumn(db, 'items', 'is_tip INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'guests', 'paid_at TEXT');
  addColumn(db, 'guests', 'calc_exact REAL');
  addColumn(db, 'guests', 'rounding_diff REAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS people (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name          TEXT    NOT NULL,
      kind          TEXT    NOT NULL CHECK (kind IN ('exempt','guest')),
      position      INTEGER NOT NULL DEFAULT 0,
      registered_at TEXT
    );
    CREATE TABLE IF NOT EXISTS person_items (
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      item_id   INTEGER NOT NULL REFERENCES items(id)  ON DELETE CASCADE,
      qty       INTEGER NOT NULL CHECK (qty > 0),
      PRIMARY KEY (person_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_people_event ON people(event_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_company_token ON events(company_token);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_honoree_token ON events(honoree_token);
  `);

  const events = db.prepare('SELECT id, status, rules_version, company_token, honoree_token FROM events').all();
  const hasPerson = db.prepare('SELECT 1 AS x FROM people WHERE event_id = ? LIMIT 1');
  const insPerson = db.prepare('INSERT INTO people (event_id, name, kind, registered_at) VALUES (?, ?, ?, ?)');
  const copyItems = db.prepare(
    `INSERT OR IGNORE INTO person_items (person_id, item_id, qty)
       SELECT ?, h.item_id, h.qty FROM honoree_items h JOIN items i ON i.id = h.item_id WHERE i.event_id = ?`
  );
  const setTokens = db.prepare('UPDATE events SET company_token = ?, honoree_token = ? WHERE id = ?');
  for (const e of events) {
    if (e.rules_version === 1 && !hasPerson.get(e.id)) {
      const registered = e.status === 'open' || e.status === 'closed' ? new Date().toISOString() : null;
      const r = insPerson.run(e.id, 'Cumplimentado', 'exempt', registered);
      copyItems.run(Number(r.lastInsertRowid), e.id);
    }
    if (!e.company_token || !e.honoree_token) setTokens.run(e.company_token || newToken(), e.honoree_token || newToken(), e.id);
  }
}

function openDb(dbPath, log = console) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  const version = () => db.prepare('PRAGMA user_version').get().user_version;
  const hasEvents = !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'events'").get();
  if (version() < 1 && hasEvents && db.prepare('SELECT COUNT(*) AS n FROM events').get().n > 0) {
    const bak = `${dbPath}.pre-v2-${Date.now()}.bak`;
    db.exec(`VACUUM INTO ${quote(bak)}`);
    log.log(`Copia de seguridad previa a la migración: ${bak}`);
  }

  db.exec(BASE_SCHEMA);
  if (version() < 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      migrate1(db);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    db.exec('PRAGMA user_version = 1');
  }
  return db;
}

module.exports = { openDb, newToken, quote };
