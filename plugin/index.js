// OpenCode plugin part of Open Cockpit. Runs inside OpenCode with the same
// local database the OpenChamber extension reads. No external dependencies.

const DB = `${process.env.XDG_DATA_HOME || `${process.env.HOME || '/root'}/.local/share`}/opencode/opencode.db`;

function dayKey(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function openDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const fs = await import('node:fs');
  if (!fs.existsSync(DB)) return null;
  return new DatabaseSync(DB, { readOnly: true });
}

function usage(db, days) {
  const since = dayKey(Date.now() - days * 86400000);
  const rows = db.prepare(`
    SELECT substr(datetime(time_created/1000,'unixepoch','localtime'),1,10) AS day,
      count(*) AS requests,
      sum(COALESCE(json_extract(data,'$.tokens.input'),0)) AS input,
      sum(COALESCE(json_extract(data,'$.tokens.output'),0)) AS output,
      sum(COALESCE(json_extract(data,'$.tokens.reasoning'),0)) AS reasoning,
      sum(COALESCE(json_extract(data,'$.tokens.cache.read'),0)) AS cacheRead
    FROM session_message WHERE type='assistant' GROUP BY day ORDER BY day DESC`).all();
  const scoped = rows.filter((r) => r.day >= since);
  const sum = (k) => scoped.reduce((a, r) => a + (r[k] || 0), 0);
  const input = sum('input'), output = sum('output'), reasoning = sum('reasoning'), cacheRead = sum('cacheRead');
  const lines = scoped.slice(0, 14).map((r) => `${r.day}  ${r.requests} req  ${r.input + r.output + r.reasoning + r.cacheRead} tokens`);
  return [
    `Open Cockpit usage — last ${days} days`,
    `requests: ${sum('requests')}`,
    `input: ${input}  output: ${output}  reasoning: ${reasoning}  cache read: ${cacheRead}`,
    `total tokens: ${input + output + reasoning + cacheRead}`,
    `cache hit: ${input + cacheRead ? Math.round((cacheRead / (input + cacheRead)) * 100) : 0}%`,
    '', ...lines,
  ].join('\n');
}

function context(db, sessionID) {
  const sql = `SELECT data FROM session_message WHERE type='assistant' ${sessionID ? 'AND session_id=?' : ''}
    ORDER BY time_created DESC LIMIT 20`;
  const rows = sessionID ? db.prepare(sql).all(sessionID) : db.prepare(sql).all();
  const row = rows.find((r) => {
    const t = JSON.parse(r.data).tokens || {};
    return (t.input || 0) + (t.output || 0) + (t.cache?.read || 0) > 0;
  });
  if (!row) return 'No completed assistant message found yet.';
  const d = JSON.parse(row.data);
  const t = d.tokens || {};
  const input = t.input || 0, output = t.output || 0, reasoning = t.reasoning || 0;
  const cr = t.cache?.read || 0, cw = t.cache?.write || 0;
  return [
    `Open Cockpit context${sessionID ? ` — ${sessionID}` : ' — latest message'}`,
    `input: ${input}  output: ${output}  reasoning: ${reasoning}`,
    `cache read: ${cr}  cache write: ${cw}`,
    `used: ${input + output + reasoning + cr + cw}`,
    `cache hit: ${input + cr ? Math.round((cr / (input + cr)) * 100) : 0}%`,
    `model: ${d.model?.id || 'unknown'}`,
  ].join('\n');
}

function sessions(db, limit) {
  const rows = db.prepare(`
    SELECT v.title, v.id, count(*) AS requests,
      sum(COALESCE(json_extract(m.data,'$.tokens.input'),0)+COALESCE(json_extract(m.data,'$.tokens.output'),0)
        +COALESCE(json_extract(m.data,'$.tokens.reasoning'),0)+COALESCE(json_extract(m.data,'$.tokens.cache.read'),0)) AS tokens
    FROM session_message m LEFT JOIN session_v2 v ON v.id=m.session_id
    WHERE m.type='assistant' GROUP BY m.session_id ORDER BY tokens DESC LIMIT ?`).all(limit);
  return ['Open Cockpit — top sessions', ...rows.map((r, i) => `${i + 1}. ${r.title || r.id} — ${r.tokens} tokens, ${r.requests} requests`)].join('\n');
}

export default {
  id: 'open-cockpit',
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: 'cockpit',
        description: 'Open Cockpit: read real local token usage, context window and top sessions. Use action usage, context or sessions.',
        input: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['usage', 'context', 'sessions'] },
            days: { type: 'integer', enum: [1, 7, 30, 3650] },
            limit: { type: 'integer' },
            session: { type: 'string' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        execute: async ({ action = 'usage', days = 7, limit = 10, session = '' }) => {
          const db = await openDb();
          if (!db) return { content: 'OpenCode database not found.' };
          try {
            if (action === 'context') return { content: context(db, session) };
            if (action === 'sessions') return { content: sessions(db, Math.min(25, Math.max(1, limit))) };
            return { content: usage(db, days) };
          } finally { db.close(); }
        },
      });
    });
  },
};
