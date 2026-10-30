// Migración no destructiva: una BD creada con la versión anterior (v1) debe sobrevivir intacta.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const { openDb } = require('../lib/db.js');

const V1 = `
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  tip_percent REAL NOT NULL DEFAULT 10, status TEXT NOT NULL DEFAULT 'setup', created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL, unit_price INTEGER NOT NULL, qty INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE honoree_items (item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE, qty INTEGER NOT NULL);
CREATE TABLE guests (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL, subtotal INTEGER NOT NULL, tip_share INTEGER NOT NULL, honoree_share INTEGER NOT NULL, total INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE guest_items (guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, qty INTEGER NOT NULL, PRIMARY KEY (guest_id, item_id));
`;

test('BD v1 -> v2 conserva datos, crea persona exenta, tokens y copia previa; es idempotente', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  const file = join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(V1);
  old.exec(`
    INSERT INTO events (name, tip_percent, status) VALUES ('Cena vieja', 10, 'open'), ('Borrador viejo', 10, 'honoree');
    INSERT INTO items (event_id, name, unit_price, qty) VALUES (1,'Pizza',20000,3),(1,'Cerveza',5000,6),(2,'Torta',30000,1);
    INSERT INTO honoree_items VALUES (1,1),(2,2);
    INSERT INTO guests (event_id,name,subtotal,tip_share,honoree_share,total) VALUES (1,'Ana',50000,6875,18750,75625);
    INSERT INTO guest_items VALUES (1,1,2),(1,2,2);
  `);
  old.close();

  const quiet = { log() {}, error() {} };
  const db = openDb(file, quiet);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.ok(readdirSync(dir).some((f) => f.includes('pre-v2') && f.endsWith('.bak')), 'copia previa');

  const ev = db.prepare('SELECT * FROM events ORDER BY id').all();
  assert.deepEqual(ev.map((e) => e.rules_version), [1, 1]);
  assert.ok(ev.every((e) => e.company_token && e.honoree_token && e.company_token !== e.honoree_token));

  assert.deepEqual(db.prepare('SELECT name,total FROM guests').all().map((g) => ({ ...g })), [{ name: 'Ana', total: 75625 }]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM honoree_items').get().n, 2, 'honoree_items intacta');

  const people = db.prepare('SELECT event_id, name, kind, registered_at FROM people ORDER BY event_id').all();
  assert.equal(people.length, 2);
  assert.ok(people[0].registered_at, 'cuenta abierta: cumplimentado ya registrado');
  assert.equal(people[1].registered_at, null, 'cuenta en honoree: aún pendiente');
  const pi = db.prepare('SELECT item_id, qty FROM person_items ORDER BY item_id').all().map((r) => ({ ...r }));
  assert.deepEqual(pi, [{ item_id: 1, qty: 1 }, { item_id: 2, qty: 2 }]);
  assert.equal(db.prepare('SELECT is_tip FROM items LIMIT 1').get().is_tip, 0);
  db.close();

  // Segunda apertura: no duplica ni cambia tokens
  const tokens = ev.map((e) => e.company_token);
  const db2 = openDb(file, quiet);
  assert.equal(db2.prepare('SELECT COUNT(*) n FROM people').get().n, 2);
  assert.deepEqual(db2.prepare('SELECT company_token t FROM events ORDER BY id').all().map((r) => r.t), tokens);
  db2.close();
  rmSync(dir, { recursive: true, force: true });
});

test('BD nueva: queda en versión 1 sin copia previa', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  const db = openDb(join(dir, 'new.db'), { log() {}, error() {} });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.ok(!readdirSync(dir).some((f) => f.endsWith('.bak')));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
