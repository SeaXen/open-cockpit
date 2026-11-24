import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeDb(dir) {
  const dataDir = dir;
  const dbDir = path.join(dir, 'opencode');
  fs.mkdirSync(dbDir, { recursive: true });
  const file = path.join(dbDir, 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session_v2(id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
    CREATE TABLE session_part(message_id TEXT, session_id TEXT, ordinal INTEGER, type TEXT, call_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?)').run('ses_test', 'Test', '/tmp', 1000, 3000);
  const assistant = {
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 0 } },
    time: { firstToken: 2000, streamed: 2200 },
    model: { id: 'test-model' },
    content: [{ type: 'tool', name: 'shell', state: { status: 'completed', input: { cmd: 'x' } } }],
  };
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?)').run('msg_a', 'ses_test', 'assistant', 1, 2000, JSON.stringify(assistant));
  const part = { type: 'tool', name: 'read', state: { status: 'completed', input: {} } };
  db.prepare('INSERT INTO session_part VALUES (?,?,?,?,?,?,?,?)').run('msg_a', 'ses_test', 0, 'tool', 'c1', 2000, 2200, JSON.stringify(part));
  return { db, dataDir, file };
}

async function startService(dir, dataDir, port) {
  const env = { ...process.env, HOME: dir, XDG_DATA_HOME: dataDir,
    OPENCHAMBER_SERVICE_TOKEN: 'test-token', OPENCHAMBER_SERVICE_PORT: String(port) };
  delete env.OPENCHAMBER_OPENCODE_URL;
  const child = spawn(process.execPath, [path.join(process.cwd(), 'service', 'main.js')], { env, stdio: 'ignore' });
  const headers = { authorization: 'Bearer test-token' };
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { headers });
      if (r.ok) return { child, headers, base: `http://127.0.0.1:${port}` };
    } catch { /* starting */ }
    await sleep(100);
  }
  child.kill();
  throw new Error('service did not start');
}

async function get(base, headers, route) {
  const r = await fetch(`${base}${route}`, { headers });
  assert.equal(r.status, 200, `${route} answered ${r.status}`);
  return r.json();
}

test('incremental cache keeps token totals and counts late tool parts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-test-'));
  const port = 47000 + Math.floor(Math.random() * 1000);
  const { db, dataDir } = makeDb(dir);
  let service;
  try {
    service = await startService(dir, dataDir, port);
    const { headers, base } = service;
    const first = await get(base, headers, '/data?range=all');
    assert.equal(first.stats.tokens, 125);
    assert.equal(first.stats.cache, 50);
    assert.equal(first.stats.tools, 1, 'the part is used instead of the content tool');
    assert.equal(first.bySession.length, 1);
    assert.equal(first.byTool[0].name, 'read');

    const second = {
      tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      model: { id: 'test-model' }, content: [],
    };
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?)').run('msg_b', 'ses_test', 'assistant', 2, 3000, JSON.stringify(second));
    await fetch(`${base}/refresh`, { method: 'POST', headers, body: '{}' });
    const late = { type: 'tool', name: 'edit', state: { status: 'completed', input: { file: 'x' } } };
    db.prepare('INSERT INTO session_part VALUES (?,?,?,?,?,?,?,?)').run('msg_a', 'ses_test', 1, 'tool', 'c2', 2500, 2600, JSON.stringify(late));
    await fetch(`${base}/refresh`, { method: 'POST', headers, body: '{}' });
    const after = await get(base, headers, '/data?range=all');
    assert.equal(after.stats.tools, 2, 'a late part outside the lookback window still counts');
    assert.equal(after.stats.tokens, 137);
  } finally {
    service?.child.kill();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
