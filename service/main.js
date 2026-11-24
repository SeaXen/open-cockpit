import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let DatabaseSync = null;
try { DatabaseSync = (await import('node:sqlite')).DatabaseSync; } catch { /* reported in the response */ }

const token = process.env.OPENCHAMBER_SERVICE_TOKEN;
const ALL = '__all__';
const CACHE = path.join(os.homedir(), '.config', 'openchamber', 'guest-data', 'open-cockpit', 'cache.json');
const VERSION = 12;
const TTL = 60_000;
const LOOKBACK = 200;
let state = null;
let memo = new Map();
let lastCheck = 0;

function findDb() {
  const home = os.homedir();
  const candidates = [];
  if (process.env.XDG_DATA_HOME) candidates.push(path.join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db'));
  candidates.push(path.join(home, '.local', 'share', 'opencode', 'opencode.db'));
  candidates.push(path.join(home, 'Library', 'Application Support', 'opencode', 'opencode.db'));
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'opencode', 'opencode.db'));
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) ?? null;
}

const emptyAggs = () => ({ days: {}, sessionDays: {}, modelDays: {}, toolDays: {}, skillDays: {}, hours: {} });
function emptyState() {
  return { version: VERSION, watermark: 0, builtAt: Date.now(), recent: {}, partSeen: {}, sessions: {}, aggs: emptyAggs() };
}
function loadDisk() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (c.version === VERSION && c.aggs && c.recent && c.sessions && c.partSeen) return c;
  } catch { /* no cache yet */ }
  return null;
}
function saveDisk() {
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    const tmp = `${CACHE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, CACHE);
  } catch { /* a missing cache only costs one rebuild */ }
}
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveDisk(); }, 30_000);
  saveTimer.unref?.();
}

const MSG_SQL = `
SELECT rowid AS rid, session_id AS s, time_created AS t,
  COALESCE(json_extract(data, '$.tokens.input'), 0) AS i,
  COALESCE(json_extract(data, '$.tokens.output'), 0) AS o,
  COALESCE(json_extract(data, '$.tokens.reasoning'), 0) AS r,
  COALESCE(json_extract(data, '$.tokens.cache.read'), 0) AS cr,
  COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS cw,
  COALESCE(json_extract(data, '$.cost'), 0) AS cost,
  COALESCE(json_extract(data, '$.model.id'), '') AS model
FROM session_message
WHERE type = 'assistant' AND rowid > ?
ORDER BY rowid`;

const TOOL_SQL = `
SELECT sm.rowid AS rid, sm.session_id AS s, sm.time_created AS t,
  lower(json_extract(je.value, '$.name')) AS name,
  lower(json_extract(je.value, '$.state.status')) AS status
FROM session_message AS sm
JOIN json_each(json_extract(sm.data, '$.content')) AS je
  ON json_extract(je.value, '$.type') = 'tool'
WHERE sm.type = 'assistant' AND sm.rowid > ?`;

const SKILL_SQL = `
SELECT sm.rowid AS rid, sm.session_id AS s, sm.time_created AS t,
  json_extract(je.value, '$.id') AS sid
FROM session_message AS sm
JOIN json_each(json_extract(sm.data, '$.skills')) AS je
WHERE sm.type = 'user' AND sm.rowid > ?`;

// Newer OpenCode releases store tool calls as message parts instead of content.
const PART_SQL = `
SELECT sm.rowid AS rid, sp.session_id AS s, sp.time_created AS t,
  lower(json_extract(sp.data, '$.name')) AS name,
  lower(json_extract(sp.data, '$.state.status')) AS status,
  sp.ordinal AS ord
FROM session_part AS sp
JOIN session_message AS sm ON sm.id = sp.message_id
WHERE sp.type = 'tool'`;

const SESSION_SQL = 'SELECT id, title, directory AS d FROM session_v2';

const isMcp = (name) => /^mcp__/.test(name) || /^tools\./.test(name);
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const lastNDays = (n) => { const d = new Date(midnight()); d.setDate(d.getDate() - (n - 1)); return d.getTime(); };
const CUTOFFS = {
  today: midnight, week: () => lastNDays(7), month: () => lastNDays(30),
  year: () => new Date(new Date().getFullYear(), 0, 1).getTime(), all: () => 0,
};
const LABELS = { today: 'Today', week: 'Last 7 days', month: 'Last 30 days', year: 'This year', all: 'All time' };

function bump(map, key, init, tok, cache, cost, req) {
  let b = map[key];
  if (!b) {
    b = { name: init.name, id: init.id || '', d: init.d || '', day: init.day || '', t: 0,
      tokens: 0, cache: 0, cost: 0, requests: 0, tools: 0, skills: 0, mcp: 0, errors: 0, count: 0,
      tin: 0, tout: 0, treason: 0, cr: 0, cw: 0 };
    map[key] = b;
  }
  b.tokens += tok; b.cache += cache; b.cost += cost; b.requests += req;
  b.t = Math.max(b.t, init.t || 0);
  return b;
}

function apply(row, sign) {
  const a = state.aggs;
  const meta = state.sessions[row.s] ?? { d: '', title: row.s };
  const d = meta.d || '';
  const day = dayKey(row.t);
  const tok = ((row.i || 0) + (row.o || 0) + (row.r || 0)) * sign;
  const cache = ((row.cr || 0) + (row.cw || 0)) * sign;
  const cost = (row.cost || 0) * sign;
  bump(a.days, `${day}\u0000${d}`, { name: day, d, day, t: row.t }, tok, cache, cost, sign);
  const sessionInit = { id: row.s, name: meta.title || row.s, d, day, t: row.t };
  bump(a.sessionDays, `${row.s}\u0000${day}`, sessionInit, tok, cache, cost, sign);
  const modelInit = { name: row.model || '(none)', d, day, t: row.t };
  const mb = bump(a.modelDays, `${row.model}\u0000${day}`, modelInit, tok, cache, cost, sign);
  mb.tin += (row.i || 0) * sign;
  mb.tout += (row.o || 0) * sign;
  mb.treason += (row.r || 0) * sign;
  mb.cr += (row.cr || 0) * sign;
  mb.cw += (row.cw || 0) * sign;
  const db = a.days[`${day}\u0000${d}`];
  db.tin += (row.i || 0) * sign;
  db.tout += (row.o || 0) * sign;
  db.treason += (row.r || 0) * sign;
  db.cr += (row.cr || 0) * sign;
  db.cw += (row.cw || 0) * sign;
  const tools = row.tools || [];
  const skills = row.skills || [];
  const errors = row.errTools || [];
  db.tools += tools.length * sign;
  db.mcp += tools.filter(isMcp).length * sign;
  db.errors += errors.length * sign;
  db.skills += (skills.length + (tools.includes('skill') ? 1 : 0)) * sign;
  for (const name of tools) {
    const b = bump(a.toolDays, `${name}\u0000${day}`, { name, d, day, t: row.t }, 0, 0, 0, 0);
    b.count += sign;
  }
  for (const name of errors) {
    const b = bump(a.toolDays, `${name}\u0000${day}`, { name, d, day, t: row.t }, 0, 0, 0, 0);
    b.errors += sign;
  }
  for (const name of skills) {
    bump(a.skillDays, `${name}\u0000${day}`, { name, d, day, t: row.t }, 0, 0, 0, 0).count += sign;
  }
  const hour = new Date(row.t).getHours();
  bump(a.hours, String(hour), { name: String(hour), d: '', day, t: row.t }, tok, cache, 0, sign);
}

function refresh(force = false) {
  if (!force && state && Date.now() - lastCheck < TTL) return;
  lastCheck = Date.now();
  if (!DatabaseSync) return;
  const dbPath = findDb();
  if (!dbPath) return;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const firstBuild = !state;
    if (!state) state = loadDisk() ?? emptyState();
    const from = Math.max(0, (state.watermark || 0) - LOOKBACK);
    const msgs = db.prepare(MSG_SQL).all(from);
    const tools = db.prepare(TOOL_SQL).all(from);
    const skills = db.prepare(SKILL_SQL).all(from);
    const parts = db.prepare(PART_SQL).all();
    const sessions = db.prepare(SESSION_SQL).all();

    const maxRid = Math.max(0, ...msgs.map((m) => m.rid), ...tools.map((t) => t.rid), ...skills.map((s) => s.rid), ...parts.map((p) => p.rid));
    if (maxRid > 0 && maxRid < (state.watermark || 0) - LOOKBACK) state = emptyState();

    let changed = msgs.length > 0 || tools.length > 0 || skills.length > 0;
    for (const s of sessions) if (s.id) state.sessions[s.id] = { title: s.title || '', d: s.d || '' };

    const rows = new Map();
    for (const m of msgs) rows.set(m.rid, {
      s: m.s, t: m.t, i: m.i, o: m.o, r: m.r, cr: m.cr, cw: m.cw,
      cost: m.cost, model: m.model, tools: [], skills: [], errTools: [],
    });
    const add = (rid, s, t, key, value, dedupe = false) => {
      let row = rows.get(rid);
      if (!row) {
        const old = state.recent?.[rid];
        row = old ? { ...old, tools: [...(old.tools ?? [])], skills: [...(old.skills ?? [])], errTools: [...(old.errTools ?? [])] }
          : { s, t, i: 0, o: 0, r: 0, cr: 0, cw: 0, cost: 0, model: '', tools: [], skills: [], errTools: [] };
        rows.set(rid, row);
      }
      if (!dedupe || !row[key].includes(value)) row[key].push(value);
    };
    const partRids = new Set(parts.map((p) => p.rid));
    const msgRids = new Set(msgs.map((m) => m.rid));
    for (const t of tools) {
      if (partRids.has(t.rid)) continue; // parts are the accurate source when present
      if (t.name) add(t.rid, t.s, t.t, 'tools', t.name);
      if (t.status && t.status !== 'completed' && t.name) add(t.rid, t.s, t.t, 'errTools', t.name, true);
    }
    for (const p of parts) {
      if (!p.name) continue;
      const key = `${p.rid}:${p.ord}`;
      if (!msgRids.has(p.rid) && state.partSeen[key]) continue; // late part already counted
      state.partSeen[key] = p.rid;
      add(p.rid, p.s, p.t, 'tools', p.name);
      if (p.status && p.status !== 'completed') add(p.rid, p.s, p.t, 'errTools', p.name, true);
    }
    const partFloor = Math.max(0, (state.watermark || 0) - 10_000);
    for (const key of Object.keys(state.partSeen)) if (state.partSeen[key] <= partFloor) delete state.partSeen[key];
    for (const s of skills) if (s.sid) add(s.rid, s.s, s.t, 'skills', s.sid, true);

    for (const [rid, row] of rows) {
      const old = state.recent[rid];
      if (old) apply(old, -1);
      apply(row, 1);
      state.recent[rid] = row;
    }
    if (maxRid > (state.watermark || 0)) { state.watermark = maxRid; changed = true; }
    const keepFrom = Math.max(0, (state.watermark || 0) - LOOKBACK);
    for (const rid of Object.keys(state.recent)) if (Number(rid) <= keepFrom) delete state.recent[rid];
    if (changed) {
      state.builtAt = Date.now();
      memo = new Map();
      if (firstBuild) saveDisk(); else scheduleSave();
    }
  } catch {
    /* keep the last good state */
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

function boundsFor(range) {
  const today = new Date(midnight());
  const dayStr = (d) => dayKey(d.getTime());
  if (range === 'today') {
    const prev = new Date(today); prev.setDate(prev.getDate() - 1);
    return { start: dayStr(today), end: null, prevStart: dayStr(prev), prevEnd: dayStr(today) };
  }
  const n = range === 'week' ? 7 : range === 'month' ? 30 : null;
  if (n) {
    const start = new Date(today); start.setDate(start.getDate() - (n - 1));
    const prevEnd = new Date(start);
    const prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - n);
    return { start: dayStr(start), end: null, prevStart: dayStr(prevStart), prevEnd: dayStr(prevEnd) };
  }
  if (range === 'year') {
    const start = new Date(today.getFullYear(), 0, 1);
    const prevStart = new Date(today.getFullYear() - 1, 0, 1);
    const prevEnd = new Date(today.getFullYear(), 0, 1);
    return { start: dayStr(start), end: null, prevStart: dayStr(prevStart), prevEnd: dayStr(prevEnd) };
  }
  return null;
}

function summarize(range, project) {
  const key = `${range}\u0000${project}`;
  if (memo.has(key)) return memo.get(key);
  const a = state?.aggs ?? emptyAggs();
  const cutoffDay = dayKey((CUTOFFS[range] ?? CUTOFFS.all)());
  const inProject = (b) => project === ALL || b.d === project;
  const inRange = (b) => (b.day || dayKey(b.t || 0)) >= cutoffDay;
  const sum = (map, field) => {
    let n = 0;
    for (const b of Object.values(map)) if (inRange(b) && inProject(b)) n += b[field] || 0;
    return n;
  };
  const stats = {
    tokens: sum(a.days, 'tokens'), cache: sum(a.days, 'cache'), cost: sum(a.days, 'cost'),
    requests: sum(a.days, 'requests'), tools: sum(a.days, 'tools'), mcp: sum(a.days, 'mcp'),
    skills: sum(a.days, 'skills'), errors: sum(a.days, 'errors'),
    sessions: new Set(Object.values(a.sessionDays).filter((b) => inRange(b) && inProject(b)).map((b) => b.id)).size,
    projects: new Set(Object.values(a.days).filter((b) => inRange(b) && inProject(b)).map((b) => b.d)).size,
  };
  stats.totalTokens = stats.tokens + stats.cache;
  stats.input = sum(a.days, 'tin');
  stats.output = sum(a.days, 'tout');
  stats.reasoning = sum(a.days, 'treason');
  stats.cacheRead = sum(a.days, 'cr');
  stats.cacheWrite = sum(a.days, 'cw');
  stats.cacheHitRate = stats.input + stats.cacheRead ? Math.round((stats.cacheRead / (stats.input + stats.cacheRead)) * 100) : 0;

  const totals = {};
  for (const r of Object.keys(CUTOFFS)) {
    const from = dayKey(CUTOFFS[r]());
    let n = 0;
    for (const b of Object.values(a.days)) if (b.day >= from && inProject(b)) n += b.tokens + b.cache;
    totals[r] = n;
  }

  const dayTotals = new Map();
  for (const b of Object.values(a.days)) {
    if (!inRange(b) || !inProject(b)) continue;
    dayTotals.set(b.day, (dayTotals.get(b.day) ?? 0) + b.tokens + b.cache);
  }
  const heat = [...dayTotals].map(([day, tokens]) => ({ day, tokens })).sort((x, y) => x.day.localeCompare(y.day));

  const bounds = boundsFor(range);
  const deltas = {};
  if (bounds) {
    const periodSum = (start, end, field) => {
      let n = 0;
      for (const b of Object.values(a.days)) {
        if (!inProject(b) || b.day < start || (end && b.day >= end)) continue;
        n += field === 'tokens' ? b.tokens + b.cache : (b[field] || 0);
      }
      return n;
    };
    for (const field of ['tokens', 'requests', 'tools', 'skills', 'cost']) {
      const now = periodSum(bounds.start, bounds.end, field);
      const before = periodSum(bounds.prevStart, bounds.prevEnd, field);
      deltas[field] = before ? Math.round(((now - before) / before) * 100) : null;
    }
  }
  const hours = Object.values(a.hours)
    .filter((b) => inProject(b))
    .map((b) => ({ hour: Number(b.name), requests: b.requests, tokens: b.tokens + b.cache }))
    .sort((x, y) => x.hour - y.hour);
  stats.busiestHour = hours.length ? hours.reduce((best, h) => (h.requests > best.requests ? h : best), hours[0]).hour : null;
  const SUM_FIELDS = ['count', 'tokens', 'cache', 'cost', 'requests', 'tools', 'skills', 'mcp', 'errors', 'tin', 'tout', 'treason', 'cr', 'cw'];
  const fold = (out, key, make, values, fields = SUM_FIELDS) => {
    const e = out[key] ?? make(key);
    for (const f of fields) e[f] = (e[f] || 0) + (values[f] || 0);
    out[key] = e;
    return e;
  };
  const mergedList = (map, keyFn = (b) => b.name || b.id) => {
    const out = {};
    for (const b of Object.values(map)) {
      if (!inRange(b) || !inProject(b)) continue;
      const k = keyFn(b) || '(none)';
      const e = fold(out, k, (key) => ({ name: b.name || key, id: b.id || '', d: b.d, day: b.day, t: 0 }), b);
      e.t = Math.max(e.t, b.t || 0);
    }
    return Object.values(out)
      .sort((x, y) => (y.tokens + y.cache) - (x.tokens + x.cache) || (y.count || y.requests) - (x.count || x.requests))
      .slice(0, 16)
      .map((e) => ({ ...e, count: e.count || e.requests }));
  };

  const dayFields = ['tokens', 'cache', 'cost', 'requests', 'tools', 'skills', 'mcp', 'errors'];
  const projectBuckets = {};
  const dailyByDay = {};
  const byDayBuckets = {};
  for (const b of Object.values(a.days)) {
    if (!inRange(b) || !inProject(b)) continue;
    fold(projectBuckets, b.d, (key) => ({ name: key, d: key }), b, dayFields);
    fold(byDayBuckets, b.day, (key) => ({ name: key, day: key }), b, dayFields);
    fold(dailyByDay, b.day, (key) => ({ day: key, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }), {
      input: b.tin, output: b.tout, reasoning: b.treason, cacheRead: b.cr, cacheWrite: b.cw, total: b.tokens + b.cache,
    }, ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'total']);
  }
  const dailyTokens = Object.values(dailyByDay).sort((x, y) => x.day.localeCompare(y.day));
  const heatFrom = (map, filter) => {
    const m = new Map();
    for (const b of Object.values(map)) {
      if (!inRange(b) || !inProject(b) || (filter && !filter(b))) continue;
      m.set(b.day, (m.get(b.day) ?? 0) + (b.count ?? b.requests ?? 0));
    }
    return [...m].map(([day, value]) => ({ day, tokens: value })).sort((x, y) => x.day.localeCompare(y.day));
  };

  const result = {
    range, label: LABELS[range] ?? LABELS.all, project,
    projects: [...new Set(Object.values(a.days).map((b) => b.d))].filter(Boolean).sort(),
    totals, stats, deltas, heat, hours, dailyTokens,
    heatTools: heatFrom(a.toolDays), heatSkills: heatFrom(a.skillDays),
    heatMcp: heatFrom(a.toolDays, isMcp),
    days: Object.values(byDayBuckets).sort((x, y) => y.day.localeCompare(x.day)),
    bySession: mergedList(a.sessionDays, (b) => b.id || b.name),
    byProject: Object.values(projectBuckets).sort((x, y) => (y.tokens + y.cache) - (x.tokens + x.cache)).slice(0, 16),
    byModel: mergedList(a.modelDays), byTool: mergedList(a.toolDays),
    bySkill: mergedList(a.skillDays), byMcp: mergedList(a.toolDays).filter((b) => isMcp(b.name)),
    builtAt: state?.builtAt ?? 0,
    error: DatabaseSync ? null : 'Needs Node 22.5+ with node:sqlite.',
  };
  memo.set(key, result);
  return result;
}

function logs({ limit = 200, kind = 'all', session = '', q = '', project = ALL }) {
  const cap = Math.min(500, Math.max(1, Number(limit) || 200));
  const needle = String(q || '').toLowerCase();
  const out = [];
  const rows = Object.values(state?.recent ?? {}).sort((x, y) => y.t - x.t);
  const push = (row, k, name, tokens) => {
    const meta = state.sessions[row.s] ?? { title: row.s, d: '' };
    if (project !== ALL && meta.d !== project) return;
    if (kind !== 'all' && kind !== k) return;
    const rec = {
      t: row.t, kind: k, name: name || '(none)', session: row.s,
      title: meta.title || row.s, directory: meta.d || '', tokens: Math.round(tokens || 0),
    };
    if (session && rec.session !== session) return;
    if (needle && !`${rec.name} ${rec.title} ${rec.directory}`.toLowerCase().includes(needle)) return;
    out.push(rec);
  };
  for (const row of rows) {
    const tok = (row.i || 0) + (row.o || 0) + (row.r || 0) + (row.cr || 0) + (row.cw || 0);
    if (kind === 'all' || kind === 'message') push(row, 'message', row.model || 'assistant', tok);
    for (const t of row.tools || []) push(row, 'tool', t, 0);
    for (const t of row.errTools || []) push(row, 'error', t, 0);
    for (const s of row.skills || []) push(row, 'skill', s, 0);
    if (out.length >= cap) break;
  }
  return { logs: out.slice(0, cap), count: out.length, builtAt: state?.builtAt ?? 0 };
}

const rowTokens = (r) => (r.i || 0) + (r.o || 0) + (r.r || 0) + (r.cr || 0) + (r.cw || 0);

function context(sessionId = '') {
  let rows = Object.values(state?.recent ?? {}).filter((r) => !sessionId || r.s === sessionId)
    .sort((a, b) => b.t - a.t).slice(0, 200);
  if (sessionId && !rows.length && DatabaseSync) {
    try {
      const dbPath = findDb();
      const db2 = dbPath ? new DatabaseSync(dbPath, { readOnly: true }) : null;
      if (db2) {
        const found = db2.prepare("SELECT data, time_created t, session_id s FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY time_created DESC LIMIT 30").all(sessionId);
        rows = found.map((m) => {
          const d = JSON.parse(m.data);
          return { s: m.s, t: m.t, i: d.tokens?.input || 0, o: d.tokens?.output || 0, r: d.tokens?.reasoning || 0,
            cr: d.tokens?.cache?.read || 0, cw: d.tokens?.cache?.write || 0, model: d.model?.id || '', tools: [], skills: [], errTools: [] };
        });
        db2.close();
      }
    } catch { /* keep empty rows */ }
  }
  const last = rows.find((r) => rowTokens(r) > 0);
  const avg = (f) => rows.length ? Math.round(rows.reduce((a, r) => a + (r[f] || 0), 0) / rows.length) : 0;
  const input = last?.i || 0, cacheRead = last?.cr || 0;
  let skillsTokens = 0, toolTokens = 0, mcpTokens = 0, systemTokens = 2200;
  const projectDir = last ? (state.sessions[last.s]?.d || '') : '';
  for (const p of [path.join(os.homedir(), '.config', 'opencode', 'AGENTS.md'),
    projectDir ? path.join(projectDir, 'AGENTS.md') : '', projectDir ? path.join(projectDir, 'CLAUDE.md') : '']) {
    if (!p) continue;
    try { systemTokens += Math.round(fs.readFileSync(p, 'utf8').length / 4); } catch { /* no rules file */ }
  }
  systemTokens = Math.min(systemTokens, 8000);
  const dbPath = last?.s && DatabaseSync ? findDb() : null;
  let db;
  try {
    if (dbPath) {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const users = db.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY time_created DESC LIMIT 20").all(last.s);
      for (const u of users) {
        const d = JSON.parse(u.data);
        for (const sk of d.skills ?? []) skillsTokens += Math.round(String(sk.text ?? '').length / 4);
      }
      skillsTokens = Math.min(skillsTokens, 6400);
      const parts = db.prepare("SELECT data FROM session_part WHERE session_id = ? AND type = 'tool' ORDER BY time_created DESC LIMIT 30").all(last.s);
      if (parts.length) {
        for (const part of parts) {
          const d = JSON.parse(part.data);
          toolTokens += Math.round(JSON.stringify(d.state?.input ?? d.input ?? '').length / 4);
          if (isMcp(String(d.name ?? ''))) mcpTokens += 1000;
        }
      } else {
        const assistants = db.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY time_created DESC LIMIT 20").all(last.s);
        for (const a of assistants) {
          const d = JSON.parse(a.data);
          for (const part of d.content ?? []) {
            if (part.type !== 'tool' || !part.state?.input) continue;
            toolTokens += Math.round(JSON.stringify(part.state.input).length / 4);
            if (isMcp(String(part.name ?? ''))) mcpTokens += 1000;
          }
        }
      }
    }
  } catch { /* estimates are optional */ } finally { try { db?.close(); } catch { /* done */ } }

  const generated = (last?.o || 0) + (last?.r || 0);
  const recent20 = rows.filter((r) => rowTokens(r) > 0).slice(0, 20);
  const in20 = recent20.reduce((a, r) => a + (r.i || 0), 0);
  const cr20 = recent20.reduce((a, r) => a + (r.cr || 0), 0);
  const cacheHitRate20 = in20 + cr20 ? Math.round((cr20 / (in20 + cr20)) * 100) : 0;
  const nativeTools = 7200;
  const conversation = input + generated;
  return {
    input, output: last?.o || 0, reasoning: last?.r || 0, cacheRead, cacheWrite: last?.cw || 0,
    used: input + cacheRead + generated,
    avgInput: avg('i'), avgCacheRead: avg('cr'), maxInput: rows.reduce((m, r) => Math.max(m, r.i || 0), 0),
    cacheHitRate: input + cacheRead ? Math.round((cacheRead / (input + cacheRead)) * 100) : 0,
    cacheHitRate20,
    requests: rows.length,
    title: last ? (state.sessions[last.s]?.title || '') : '',
    directory: last ? (state.sessions[last.s]?.d || '') : '',
    time: last?.t || 0,
    breakdown: [
      { label: 'Conversation', tokens: conversation },
      { label: 'Native Tools', tokens: nativeTools },
      { label: 'Skills', tokens: skillsTokens },
      { label: 'System & Rules', tokens: systemTokens },
      { label: 'MCP Tools', tokens: mcpTokens || 3300 },
      { label: 'Tool Payloads', tokens: toolTokens },
    ].sort((a, b) => b.tokens - a.tokens),
  };
}

function sessionData(id) {
  const meta = state?.sessions?.[id] ?? { title: id || 'No session', d: '' };
  const result = { id, title: meta.title, directory: meta.d, stats: {}, daily: [], context: context(id), error: null };
  if (!id || !DatabaseSync) { result.error = id ? 'Database unavailable.' : 'No session is open.'; return result; }
  const dbPath = findDb();
  if (!dbPath) { result.error = 'No OpenCode database found.'; return result; }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const totals = db.prepare(`
      SELECT count(*) requests,
        COALESCE(sum(json_extract(data,'$.tokens.input')),0) i,
        COALESCE(sum(json_extract(data,'$.tokens.output')),0) o,
        COALESCE(sum(json_extract(data,'$.tokens.reasoning')),0) r,
        COALESCE(sum(json_extract(data,'$.tokens.cache.read')),0) cr,
        COALESCE(sum(json_extract(data,'$.tokens.cache.write')),0) cw,
        COALESCE(sum(json_extract(data,'$.cost')),0) cost
      FROM session_message WHERE session_id = ? AND type = 'assistant'`).get(id);
    const toolParts = db.prepare("SELECT count(*) n FROM session_part WHERE session_id = ? AND type = 'tool'").get(id).n;
    const tools = toolParts ? { n: toolParts } : db.prepare(`
      SELECT count(*) n FROM session_message sm, json_each(json_extract(sm.data,'$.content')) je
      WHERE sm.session_id = ? AND sm.type = 'assistant' AND json_extract(je.value,'$.type') = 'tool'`).get(id);
    const skills = db.prepare(`
      SELECT count(*) n FROM session_message sm, json_each(json_extract(sm.data,'$.skills')) je
      WHERE sm.session_id = ? AND sm.type = 'user'`).get(id);
    const daily = db.prepare(`
      SELECT substr(datetime(time_created/1000,'unixepoch','localtime'),1,10) day,
        sum(COALESCE(json_extract(data,'$.tokens.input'),0)+COALESCE(json_extract(data,'$.tokens.output'),0)
          +COALESCE(json_extract(data,'$.tokens.reasoning'),0)+COALESCE(json_extract(data,'$.tokens.cache.read'),0)
          +COALESCE(json_extract(data,'$.tokens.cache.write'),0)) tokens
      FROM session_message WHERE session_id = ? AND type = 'assistant' GROUP BY day ORDER BY day`).all(id);
    result.stats = {
      requests: totals.requests, input: totals.i, output: totals.o, reasoning: totals.r,
      cacheRead: totals.cr, cacheWrite: totals.cw, tokens: totals.i + totals.o + totals.r,
      cache: totals.cr + totals.cw, totalTokens: totals.i + totals.o + totals.r + totals.cr + totals.cw,
      tools: tools.n, skills: skills.n, cost: totals.cost,
      cacheHitRate: totals.i + totals.cr ? Math.round((totals.cr / (totals.i + totals.cr)) * 100) : 0,
    };
    result.daily = daily;
  } catch (e) { result.error = e.message; } finally { try { db?.close(); } catch { /* done */ } }
  return result;
}

const send = (res, code, obj) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj ?? {}));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { if (state) saveDisk(); process.exit(0); });

http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/health') { send(res, 200, {}); return; }
  if (url.pathname === '/summary' && req.method === 'GET') {
    if (url.searchParams.get('fresh') === '1') refresh(true); else refresh();
    const d = summarize('today', ALL);
    send(res, 200, { stats: d.stats, totals: d.totals, deltas: d.deltas, builtAt: d.builtAt, error: d.error });
    return;
  }
  if (url.pathname === '/logs' && req.method === 'GET') {
    refresh();
    const p = Object.fromEntries(url.searchParams);
    send(res, 200, logs(p));
    return;
  }
  if (url.pathname === '/context' && req.method === 'GET') {
    if (url.searchParams.get('fresh') === '1') refresh(true); else refresh();
    send(res, 200, context(url.searchParams.get('session') ?? ''));
    return;
  }
  if (url.pathname === '/session' && req.method === 'GET') {
    if (url.searchParams.get('fresh') === '1') refresh(true); else refresh();
    send(res, 200, sessionData(url.searchParams.get('session') ?? ''));
    return;
  }
  if (url.pathname === '/data' && req.method === 'GET') {
    if (url.searchParams.get('fresh') === '1') refresh(true); else refresh();
    const r = summarize(url.searchParams.get('range') ?? 'all', url.searchParams.get('project') ?? ALL);
    send(res, r.error ? 503 : 200, r);
    return;
  }
  if (url.pathname === '/refresh' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { refresh(true); send(res, 200, { ok: true }); });
    return;
  }
  res.writeHead(404).end();
}).listen(Number(process.env.OPENCHAMBER_SERVICE_PORT), '127.0.0.1');
