import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountButton, mountEmpty, mountSelect, mountTabs, mountTextField } from '@openchamber/sdk/ui';

type Row = Record<string, any>;
type Col = { key: string; label: string; num?: boolean; get?: (r: Row) => string | number; raw?: (r: Row) => number };
type Stats = Record<string, any>;
type Data = {
  range: string; label: string; project: string; projects: string[];
  totals: Record<string, number>; deltas: Record<string, number | null>;
  stats: Stats; heat: { day: string; tokens: number }[];
  heatTools: { day: string; tokens: number }[]; heatSkills: { day: string; tokens: number }[]; heatMcp: { day: string; tokens: number }[];
  dailyTokens: { day: string; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number }[];
  hours: { hour: number; requests: number; tokens: number }[]; days: Row[];
  bySession: Row[]; byProject: Row[]; byModel: Row[]; byTool: Row[]; bySkill: Row[]; byMcp: Row[];
  builtAt: number; error?: string | null;
};
type Summary = { stats: Stats; totals: Record<string, number>; deltas: Record<string, number | null>; builtAt: number; error?: string | null };
type LogEntry = { t: number; kind: string; name: string; session: string; title: string; directory: string; tokens: number };
type Ctx = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; used: number; avgInput: number; avgCacheRead: number; maxInput: number; cacheHitRate: number; requests: number; title: string; directory: string; time: number };

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root')!;
const ALL = '__all__';
const TABS = [
  { id: 'overview', label: 'Overview' }, { id: 'token', label: 'Token' }, { id: 'date', label: 'Date' },
  { id: 'model', label: 'Model' }, { id: 'session', label: 'Session' }, { id: 'project', label: 'Project' },
  { id: 'context', label: 'Context' }, { id: 'tool', label: 'Tool' }, { id: 'skill', label: 'Skill' },
  { id: 'mcp', label: 'MCP' }, { id: 'logs', label: 'Logs' }, { id: 'settings', label: 'Settings' },
];
const TAB_ICONS: Record<string, string> = {
  overview: '▤', token: '◈', date: '▦', model: '⬡', session: '◉', project: '▣',
  context: '◫', tool: '⚒', skill: '✦', mcp: '⬢', logs: '☰', settings: '⚙',
};
const RANGES = [
  { id: 'today', label: 'Today' }, { id: 'week', label: '7 days' }, { id: 'month', label: '30 days' },
  { id: 'year', label: 'Year' }, { id: 'all', label: 'All time' },
];
let surface = 'panel';
let tab = 'overview';
let range = 'all';
let project = ALL;
let filter = '';
let logKind = 'all';
let logSession = '';
let logSearch = '';
let collapsed = new Set<string>();
const settings = { bars: 14, heatWeeks: 26, showTrends: true, clock12: false, contextLimit: 1048576,
  budget: 0, priceIn: 0, priceOut: 0, priceCache: 0, sectionPicker: 'dropdown' as 'dropdown' | 'icons', cardOrder: [] as string[] };
let data: Data | null = null;
let summary: Summary | null = null;
let todayData: Data | null = null;
let ctxData: Ctx | null = null;
let logData: LogEntry[] = [];
let currentSession = '';
let focusSession = '';
let sessionInfo: any = null;
let loading = false;
let ready = false;
const sorts: Record<string, { key: string; dir: number }> = {};

const fmt = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n || 0));
const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const clock = (t: number): string => t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: settings.clock12 }) : '—';
const estCost = (s: Stats): number =>
  ((s.input || 0) * settings.priceIn + ((s.output || 0) + (s.reasoning || 0)) * settings.priceOut + (s.cacheRead || 0) * settings.priceCache) / 1e6;
const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const factsGrid = (pairs: [string, string][]): HTMLElement => {
  const wrap = el('div', 'history');
  for (const [label, value] of pairs) {
    const h = el('div', 'hist');
    h.append(el('div', 'l', label), el('div', 'v', value));
    wrap.append(h);
  }
  return wrap;
};
const tileGrid = (pairs: [string, string][]): HTMLElement => {
  const wrap = el('div', 'stats');
  for (const [label, value] of pairs) wrap.append(tile(label, value));
  return wrap;
};

async function saveView(): Promise<void> {
  try { await host.storage.set('view', { tab, range, project, filter, logKind, logSession, collapsed: [...collapsed], settings }); }
  catch { /* optional */ }
}
async function loadView(): Promise<void> {
  try {
    const v = await host.storage.get('view') as Record<string, any> | undefined;
    if (!v) return;
    if (TABS.some((t) => t.id === v.tab)) tab = v.tab;
    if (RANGES.some((t) => t.id === v.range)) range = v.range;
    if (typeof v.project === 'string') project = v.project;
    if (typeof v.filter === 'string') filter = v.filter;
    if (typeof v.logKind === 'string') logKind = v.logKind;
    if (typeof v.logSession === 'string') logSession = v.logSession;
    if (Array.isArray(v.collapsed)) collapsed = new Set(v.collapsed);
    if (v.settings && typeof v.settings === 'object') {
      const s = v.settings as Record<string, any>;
      if ([7, 14, 30].includes(s.bars)) settings.bars = s.bars;
      if ([13, 26, 52].includes(s.heatWeeks)) settings.heatWeeks = s.heatWeeks;
      if (typeof s.showTrends === 'boolean') settings.showTrends = s.showTrends;
      if (typeof s.clock12 === 'boolean') settings.clock12 = s.clock12;
      if ([262144, 524288, 1048576, 2097152].includes(s.contextLimit)) settings.contextLimit = s.contextLimit;
      if (typeof s.budget === 'number') settings.budget = s.budget;
      if (typeof s.priceIn === 'number') settings.priceIn = s.priceIn;
      if (typeof s.priceOut === 'number') settings.priceOut = s.priceOut;
      if (typeof s.priceCache === 'number') settings.priceCache = s.priceCache;
      if (s.sectionPicker === 'icons' || s.sectionPicker === 'dropdown') settings.sectionPicker = s.sectionPicker;
      if (Array.isArray(s.cardOrder)) settings.cardOrder = s.cardOrder.filter((x: unknown) => typeof x === 'string');
    }
  } catch { /* no saved view */ }
}

async function json(path: string): Promise<any> {
  const res = await host.serviceRequest({ method: 'GET', path });
  return typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
}

async function load(force = false): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    if (force) await host.serviceRequest({ method: 'POST', path: '/refresh', body: '{}' });
    if (surface === 'status') {
      summary = await json(force ? '/summary?fresh=1' : '/summary');
    } else {
      data = await json(`/data?range=${range}&project=${encodeURIComponent(project)}`);
      todayData = await json(`/data?range=today&project=${encodeURIComponent(project)}`);
      summary = await json('/summary');
      ctxData = await json('/context');
      if (currentSession) sessionInfo = await json(`/session?session=${encodeURIComponent(currentSession)}`);
    }
  } catch {
    if (surface === 'status') summary = { error: 'Usage service is starting.', stats: {}, totals: {}, deltas: {}, builtAt: 0 };
    else data = { error: 'Usage service is starting.' } as Data;
  }
  loading = false;
  render();
}

async function loadLogs(): Promise<void> {
  try {
    const params = new URLSearchParams({ limit: '300', kind: logKind, q: logSearch, project });
    if (logSession) params.set('session', logSession);
    const body = await json(`/logs?${params}`);
    logData = body.logs ?? [];
  } catch { logData = []; }
  render();
}

function card(id: string, title: string, right: string, build: () => HTMLElement | HTMLElement[]): HTMLElement {
  const c = el('div', 'card');
  c.dataset.card = id;
  const h = el('button', 'card-h');
  h.append(el('span', '', title));
  const r = el('span', 'right');
  const grip = el('span', 'grip', '⋮⋮');
  grip.draggable = true;
  grip.title = 'Drag to reorder';
  grip.onmousedown = (e) => e.stopPropagation();
  grip.ondragstart = (e) => { e.dataTransfer?.setData('text/plain', id); };
  r.append(el('span', '', right), el('span', 'chev', collapsed.has(id) ? '▸' : '▾'), grip);
  h.append(r);
  c.ondragover = (e) => e.preventDefault();
  c.ondrop = (e) => {
    e.preventDefault();
    const from = e.dataTransfer?.getData('text/plain');
    if (!from || from === id) return;
    const cards = [...root.querySelectorAll<HTMLElement>('[data-card]')];
    const a = cards.find((x) => x.dataset.card === from);
    if (!a) return;
    const box = c.getBoundingClientRect();
    c.parentNode?.insertBefore(a, e.clientY > box.top + box.height / 2 ? c.nextSibling : c);
    settings.cardOrder = [...root.querySelectorAll<HTMLElement>('[data-card]')].map((x) => x.dataset.card ?? '');
    void saveView();
  };
  const body = el('div', 'card-body');
  const made = build();
  const nodes = Array.isArray(made) ? made : [made];
  for (const node of nodes) body.append(node);
  body.hidden = collapsed.has(id);
  h.onclick = () => {
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    body.hidden = collapsed.has(id);
    h.querySelector('.chev')!.textContent = collapsed.has(id) ? '▸' : '▾';
    void saveView();
  };
  c.append(h, body);
  return c;
}

function tile(label: string, value: string, delta?: number | null): HTMLElement {
  const t = el('div', 'tile');
  t.append(el('div', 'v', value), el('div', 'l', label));
  if (settings.showTrends && delta !== null && delta !== undefined) {
    t.append(el('div', `d ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}`, `${delta > 0 ? '+' : ''}${delta}% vs prior`));
  }
  return t;
}

function statTiles(s: Stats, deltas: Record<string, number | null> = {}): HTMLElement {
  const wrap = el('div', 'stats');
  const cards = surface === 'status'
    ? [['Tokens', fmt(s.tokens), deltas.tokens], ['Requests', String(s.requests), deltas.requests],
       ['Tool calls', String(s.tools), deltas.tools], ['Skills', String(s.skills), deltas.skills]]
    : [['Text', fmt(s.tokens), deltas.tokens], ['In', fmt(s.input), null], ['Out', fmt(s.output), null], ['Cache', fmt(s.cache), null],
       ['Req', String(s.requests), deltas.requests], ['Tools', String(s.tools), deltas.tools],
       ['Skills', String(s.skills), deltas.skills], ['MCP', String(s.mcp), null],
       ['Errors', String(s.errors ?? 0), null], ['Sessions', String(s.sessions), null],
       ['Projects', String(s.projects), null], ['Total', fmt(s.totalTokens), null]];
  for (const [label, value, delta] of cards) wrap.append(tile(label, value, delta as number | null | undefined));
  return wrap;
}

function breakdownCard(title: string, items: [string, number, string?][], right = ''): HTMLElement {
  return card(`breakdown-${title}`, title, right || 'tokens', () => {
    const wrap = el('div', 'breakdown');
    const top = Math.max(1, ...items.map((i) => i[1]));
    for (const [label, value, note] of items) {
      const row = el('div', 'b-row');
      const head = el('div', 'b-head');
      head.append(el('span', 'b-name', label), el('span', 'b-val', `${fmt(value)}${note ? ` · ${note}` : ''}`));
      const track = el('div', 'track');
      const fill = el('div', 'fill');
      fill.style.width = `${Math.max(1, Math.round((value / top) * 100))}%`;
      track.append(fill);
      row.append(head, track);
      wrap.append(row);
    }
    return wrap;
  });
}

function barCard(id: string, title: string, points: { day: string; tokens: number }[], right: string): HTMLElement {
  const shown = points.slice(-settings.bars);
  const peak = shown.reduce((m, p) => Math.max(m, p.tokens), 0);
  return card(id, title, `peak ${fmt(peak)} · ${right}`, () => {
    const wrap = el('div', 'bars');
    shown.forEach((p, i) => {
      const col = el('div', 'bar-col');
      const track = el('div', 'bar-track');
      const fill = el('div', 'bar-fill');
      const ratio = p.tokens > 0 ? Math.pow(p.tokens / Math.max(1, peak), 0.45) : 0;
      fill.style.height = ratio ? `${Math.max(5, Math.round(ratio * 100))}%` : '0';
      track.append(fill);
      track.title = `${p.day} · ${fmt(p.tokens)}`;
      const step = shown.length <= 14 ? 2 : 5;
      col.append(track, el('div', 'bar-l', i % step === 0 || i === shown.length - 1 ? p.day.slice(5) : ''));
      wrap.append(col);
    });
    return wrap;
  });
}

function heatCard(id: string, title: string, heat: { day: string; tokens: number }[], right: string): HTMLElement {
  return card(id, title, `${settings.heatWeeks} weeks · ${right}`, () => {
    const scroll = el('div', 'heat-scroll');
    const grid = el('div', 'heat-grid');
    const byDay = new Map(heat.map((h) => [h.day, h.tokens]));
    const max = Math.max(1, ...byDay.values());
    const end = new Date(); end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - (settings.heatWeeks * 7 - 1));
    start.setDate(start.getDate() - start.getDay());
    for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = ymd(d);
      const v = byDay.get(key) ?? 0;
      const cell = el('div', 'heat-cell');
      cell.title = `${key} · ${fmt(v)}`;
      if (v) { cell.style.background = 'var(--oc-primary)'; cell.style.opacity = String(0.25 + 0.75 * (v / max)); }
      grid.append(cell);
    }
    scroll.append(grid);
    const foot = el('div', 'heat-foot');
    foot.append(el('span', '', 'Less'));
    for (const p of [0, 25, 50, 75, 100]) {
      const i = el('i');
      if (p) { i.style.background = 'var(--oc-primary)'; i.style.opacity = String(p / 100); }
      foot.append(i);
    }
    foot.append(el('span', '', 'More'), el('span', 'spacer'), el('span', '', `${heat.filter((h) => h.tokens > 0).length} active days`));
    return [scroll, foot];
  });
}

function hourCard(hours: { hour: number; requests: number; tokens: number }[]): HTMLElement {
  return card('hours', 'Hour of day', settings.clock12 ? '12h clock' : '24h clock', () => {
    const wrap = el('div', 'hour-bars');
    const byHour = new Map(hours.map((h) => [h.hour, h]));
    const top = Math.max(1, ...hours.map((h) => h.requests));
    for (let h = 0; h < 24; h++) {
      const v = byHour.get(h);
      const col = el('div', 'hour-col');
      const bar = el('div', 'hour-bar');
      bar.style.height = `${v ? Math.max(2, Math.round((v.requests / top) * 100)) : 2}%`;
      const label = settings.clock12 ? `${h % 12 || 12}${h < 12 ? 'a' : 'p'}` : String(h).padStart(2, '0');
      bar.title = `${label} · ${v?.requests ?? 0} requests`;
      col.append(bar, el('div', 'hour-l', h % 4 === 0 ? label : ''));
      wrap.append(col);
    }
    return wrap;
  });
}

function tableCard(id: string, title: string, rows: Row[], cols: Col[], onRow?: (r: Row) => void): HTMLElement {
  return card(id, title, `${rows.length} rows`, () => {
    const sort = sorts[id] ?? (sorts[id] = { key: cols[cols.length - 1].key, dir: -1 });
    const needle = filter.trim().toLowerCase();
    const view = rows.filter((r) => !needle || String(r.name).toLowerCase().includes(needle));
    const col = cols.find((c) => c.key === sort.key) ?? cols[0];
    const val = (r: Row, c: Col): string | number => c.get ? c.get(r) : (r[c.key] ?? 0);
    const rawVal = (r: Row, c: Col): number => c.raw ? c.raw(r) : Number(r[c.key] ?? 0);
    view.sort((x, y) => {
      const a = rawVal(x, col), b = rawVal(y, col);
      const n = Number.isFinite(a) && Number.isFinite(b) ? a - b : String(val(x, col)).localeCompare(String(val(y, col)));
      return n * sort.dir;
    });
    const scroll = el('div', 'heat-scroll');
    const tbl = el('table', 'tbl');
    const head = el('tr');
    for (const c of cols) {
      const th = el('th', c.num ? 'n' : '', `${c.label}${sort.key === c.key ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}`);
      th.onclick = () => { const s = sorts[id]; s.dir = s.key === c.key ? -s.dir : -1; s.key = c.key; render(); };
      head.append(th);
    }
    tbl.append(head);
    for (const r of view.slice(0, 20)) {
      const tr = el('tr', onRow ? 'click' : '');
      if (onRow) tr.onclick = () => onRow(r);
      for (const c of cols) {
        const td = el('td', c.num ? 'n' : '', String(val(r, c)));
        td.title = String(val(r, c));
        tr.append(td);
      }
      tbl.append(tr);
    }
    if (!view.length) {
      const tr = el('tr');
      const td = el('td', 'empty', 'Nothing here for this period.');
      td.colSpan = cols.length;
      tr.append(td); tbl.append(tr);
    }
    scroll.append(tbl);
    return scroll;
  });
}

const NAME: Col = { key: 'name', label: 'Name' };
const USES: Col = { key: 'count', label: 'Uses', num: true, get: (r) => fmt(r.count ?? r.requests ?? 0), raw: (r) => r.count ?? r.requests ?? 0 };
const ERR: Col = { key: 'errors', label: 'Err', num: true, raw: (r) => r.errors ?? 0 };
const TOK: Col = { key: 'tokens', label: 'Tokens', num: true, get: (r) => fmt((r.tokens || 0) + (r.cache || 0)), raw: (r) => (r.tokens || 0) + (r.cache || 0) };
const IN: Col = { key: 'tin', label: 'In', num: true, get: (r) => fmt(r.tin || 0), raw: (r) => r.tin || 0 };
const OUT: Col = { key: 'tout', label: 'Out', num: true, get: (r) => fmt(r.tout || 0), raw: (r) => r.tout || 0 };
const CACHE: Col = { key: 'cr', label: 'Cache', num: true, get: (r) => fmt(r.cr || 0), raw: (r) => r.cr || 0 };
const dateCols: Col[] = [NAME, { key: 'requests', label: 'Req', num: true }, { key: 'tools', label: 'Tools', num: true }, ERR, TOK];

function todayCard(): HTMLElement {
  return card('todayOverview', 'Today at a glance', 'real data', () => {
    const s = summary?.stats ?? todayData?.stats ?? {};
    return tileGrid([
      ['Sessions', String(s.sessions ?? 0)], ['Requests', String(s.requests ?? 0)],
      ['Tools', String(s.tools ?? 0)], ['Skills', String(s.skills ?? 0)],
      ['MCP', String(s.mcp ?? 0)], ['Projects', String(s.projects ?? 0)],
      ['Text', fmt(s.tokens ?? 0)], ['Cache', fmt(s.cache ?? 0)],
      ['Total', fmt(s.totalTokens ?? 0)], ['Errors', String(s.errors ?? 0)],
      ['Est. cost', `$${estCost(s).toFixed(4)}`],
    ]);
  });
}

function contextCard(source?: Ctx): HTMLElement {
  const c = source ?? ctxData;
  const limit = settings.contextLimit;
  const pct = c ? Math.min(100, Math.round((c.used / limit) * 100)) : 0;
  return card('context', 'Context window', `${pct}% used`, () => {
    const wrap = el('div');
    const bar = el('div', 'gauge');
    const fill = el('div', 'gauge-fill');
    fill.style.width = `${pct}%`;
    bar.append(fill);
    wrap.append(bar);
    const meta = el('div', 'gauge-meta');
    meta.append(el('span', '', `${fmt(c?.used ?? 0)} / ${fmt(limit)} tokens`),
      el('span', '', `${pct}%`));
    wrap.append(meta);
    wrap.append(factsGrid([
      ['Input', fmt(c?.input ?? 0)], ['Cache read', fmt(c?.cacheRead ?? 0)],
      ['Cache write', fmt(c?.cacheWrite ?? 0)], ['Cache hit', `${c?.cacheHitRate ?? 0}%`],
      ['Avg input', fmt(c?.avgInput ?? 0)], ['Max input', fmt(c?.maxInput ?? 0)],
      ['Requests seen', String(c?.requests ?? 0)], ['Last seen', clock(c?.time ?? 0)],
    ]));
    if (c?.title) wrap.append(el('div', 'hint', `Session: ${c.title}`));
    return wrap;
  });
}

function contextExtras(source?: Ctx): HTMLElement[] {
  const c = source ?? ctxData;
  const cacheCard = card('latestCache', 'Latest cache hit rate', c ? fmt(c.cacheRead) : '', () => {
    const wrap = el('div');
    const big = el('div', 'big', `${c?.cacheHitRate ?? 0}%`);
    wrap.append(big);
    wrap.append(el('div', 'hint', `20-request average ${c?.cacheHitRate20 ?? 0}% · cache read ${fmt(c?.cacheRead ?? 0)}`));
    wrap.append(el('div', 'hint', `Input ${fmt(c?.input ?? 0)} · output ${fmt(c?.output ?? 0)}`));
    return wrap;
  });
  const breakdown = breakdownCard('Context breakdown', (c?.breakdown ?? []).map((b: any) => [b.label, b.tokens] as [string, number]), 'tokens');
  return [cacheCard, breakdown];
}

function historyCard(totals: Record<string, number>, compact = false): HTMLElement {
  return card(compact ? 'statusHistory' : 'history', 'Total tokens', compact ? '' : 'all periods', () => {
    const periods: [string, string][] = compact
      ? [['week', '7 days'], ['month', '30 days'], ['all', 'All time']]
      : [['week', '7 days'], ['month', '30 days'], ['year', 'Year'], ['all', 'All time']];
    return tileGrid(periods.map(([id, label]) => [label, fmt(totals[id] ?? 0)] as [string, string]));
  });
}

function tokenBreakdown(s: Stats, title: string): HTMLElement {
  return breakdownCard(title, [
    ['Input', s.input || 0], ['Output', s.output || 0], ['Reasoning', s.reasoning || 0],
    ['Cache read', s.cacheRead || 0], ['Cache write', s.cacheWrite || 0],
    ['Total', s.totalTokens || 0, `${s.cacheHitRate || 0}% cache hit`],
  ], 'tokens');
}

function logCard(): HTMLElement {
  return card('logs', 'Recent activity', `${logData.length} events`, () => {
    const controls = el('div', 'toolrow');
    const kinds = el('div', 'proj');
    mountSelect(kinds, {
      value: logKind,
      options: [['all', 'All events'], ['message', 'Requests'], ['tool', 'Tools'], ['error', 'Errors'], ['skill', 'Skills']]
        .map(([id, label]) => ({ id, label })),
      onChange: (id: string) => { logKind = id; void saveView(); void loadLogs(); },
    });
    controls.append(kinds);
    const search = el('div', 'search');
    const input = el('input');
    (input as HTMLInputElement).type = 'search';
    (input as HTMLInputElement).placeholder = 'Search logs';
    (input as HTMLInputElement).dataset.focusKey = 'log-search';
    (input as HTMLInputElement).value = logSearch;
    input.oninput = () => { logSearch = (input as HTMLInputElement).value; void loadLogs(); };
    search.append(input);
    controls.append(search);
    if (logSession) {
      const clear = el('button', 'mini', 'Clear session');
      clear.onclick = () => { logSession = ''; void saveView(); void loadLogs(); };
      controls.append(clear);
    }
    const scroll = el('div', 'heat-scroll');
    const tbl = el('table', 'tbl');
    const head = el('tr');
    for (const [label, cls] of [['Time', 'log-time'], ['Type', 'log-type'], ['Detail', 'log-detail'], ['Session', 'log-session'], ['Tokens', 'log-tokens n']] as [string, string][]) {
      head.append(el('th', cls, label));
    }
    tbl.append(head);
    for (const l of logData) {
      const tr = el('tr');
      tr.append(el('td', 'log-time', `${ymd(new Date(l.t)).slice(5)} ${clock(l.t)}`));
      const badge = el('td', 'log-type');
      badge.append(el('span', `badge ${l.kind}`, l.kind));
      const detail = el('td', 'log-detail', l.name);
      detail.title = l.name;
      const session = el('td', 'log-session', l.title.length > 24 ? `${l.title.slice(0, 23)}…` : l.title);
      session.title = l.title;
      tr.append(badge, detail, session, el('td', 'log-tokens n', l.tokens ? fmt(l.tokens) : ''));
      tbl.append(tr);
    }
    if (!logData.length) {
      const tr = el('tr');
      const td = el('td', 'empty', 'No events found for these filters.');
      td.colSpan = 5; tr.append(td); tbl.append(tr);
    }
    scroll.append(tbl);
    return [controls, scroll];
  });
}

function settingsCard(): HTMLElement {
  return card('settings', 'Settings', 'saved on this device', () => {
    const wrap = el('div', 'settings');
    const add = (label: string, hint: string, control: HTMLElement): void => {
      const row = el('div', 'setting');
      const left = el('div');
      left.append(el('div', 'label', label), el('div', 'hint', hint));
      row.append(left, control);
      wrap.append(row);
    };
    const select = (value: string | number, options: [string, string][], onChange: (id: string) => void): HTMLElement => {
      const box = el('div', 'control');
      mountSelect(box, { value: String(value), options: options.map(([id, label]) => ({ id, label })), onChange });
      return box;
    };
    add('Default period', 'Which range opens by default', select(range, RANGES.map((r) => [r.id, r.label]), (id) => { range = id; void saveView(); void load(); }));
    add('Clock', '12 hour or 24 hour time', select(settings.clock12 ? '12' : '24', [['24', '24 hour'], ['12', '12 hour']], (id) => {
      settings.clock12 = id === '12'; void saveView(); render();
    }));
    add('Section control', 'Narrow layout: names or icons', select(settings.sectionPicker, [['dropdown', 'Names'], ['icons', 'Icons']], (id) => {
      settings.sectionPicker = id as 'dropdown' | 'icons'; void saveView(); render();
    }));
    add('Context limit', 'Model context window size', select(settings.contextLimit, [['262144', '256k'], ['524288', '512k'], ['1048576', '1M'], ['2097152', '2M']], (id) => {
      settings.contextLimit = Number(id); void saveView(); render();
    }));
    const num = (value: number, placeholder: string, key: string, onChange: (n: number) => void): HTMLElement => {
      const box = el('div', 'control');
      mountTextField(box, {
        value: value ? String(value) : '',
        placeholder,
        mono: true,
        onChange: (v: string) => { const n = Number(v); onChange(Number.isFinite(n) && n >= 0 ? n : 0); },
      });
      const input = box.querySelector('input');
      if (input) input.dataset.focusKey = key;
      return box;
    };
    add('Daily budget', 'Tokens per day, 0 = off', num(settings.budget, 'e.g. 1000000', 'budget', (n) => { settings.budget = n; void saveView(); render(); }));
    add('Price in / 1M', 'Optional estimate for input tokens', num(settings.priceIn, '0', 'price-in', (n) => { settings.priceIn = n; void saveView(); render(); }));
    add('Price out / 1M', 'Optional estimate for output tokens', num(settings.priceOut, '0', 'price-out', (n) => { settings.priceOut = n; void saveView(); render(); }));
    add('Price cache / 1M', 'Optional estimate for cache reads', num(settings.priceCache, '0', 'price-cache', (n) => { settings.priceCache = n; void saveView(); render(); }));
    add('Daily bars', 'Days in the bar chart', select(settings.bars, [['7', '7 days'], ['14', '14 days'], ['30', '30 days']], (id) => {
      settings.bars = Number(id); void saveView(); render();
    }));
    add('Heat map', 'Weeks of activity', select(settings.heatWeeks, [['13', '13 weeks'], ['26', '26 weeks'], ['52', '52 weeks']], (id) => {
      settings.heatWeeks = Number(id); void saveView(); render();
    }));
    const trendBtn = el('div', 'btn');
    mountButton(trendBtn, { label: `Trends: ${settings.showTrends ? 'on' : 'off'}`, onClick: () => { settings.showTrends = !settings.showTrends; void saveView(); render(); } });
    add('Trend deltas', 'Show vs-prior change on tiles', trendBtn);
    const resetBtn = el('div', 'btn');
    mountButton(resetBtn, {
      label: 'Reset view',
      onClick: () => {
        tab = 'overview'; range = 'all'; project = ALL; filter = ''; logKind = 'all'; logSession = ''; collapsed = new Set();
        settings.bars = 14; settings.heatWeeks = 26; settings.showTrends = true; settings.clock12 = false; settings.contextLimit = 1048576;
        settings.budget = 0; settings.priceIn = 0; settings.priceOut = 0; settings.priceCache = 0;
        settings.sectionPicker = 'dropdown'; settings.cardOrder = [];
        void host.storage.delete('view').catch(() => undefined);
        void saveView(); void load();
      },
    });
    add('Reset', 'Restore default view and settings', resetBtn);
    wrap.append(el('div', 'hint', 'Data comes from the local OpenCode database. Nothing is sent anywhere.'));
    return wrap;
  });
}

function budgetCard(s: Stats): HTMLElement {
  const used = s?.totalTokens ?? 0;
  return card('budget', 'Daily budget', settings.budget ? `${fmt(used)} / ${fmt(settings.budget)}` : 'off', () => {
    if (!settings.budget) return el('div', 'hint', 'Set a daily token budget in Settings to track usage against a limit.');
    const pct = Math.min(100, Math.round((used / settings.budget) * 100));
    const wrap = el('div');
    const bar = el('div', 'gauge');
    const fill = el('div', 'gauge-fill');
    fill.style.width = `${pct}%`;
    if (pct >= 100) fill.style.background = 'var(--destructive)';
    bar.append(fill);
    wrap.append(bar, el('div', pct >= 100 ? 'hint up' : 'hint',
      pct >= 100 ? `Budget exceeded by ${fmt(used - settings.budget)} tokens.` : `${pct}% of today's budget used.`));
    return wrap;
  });
}

function sessionOverview(): HTMLElement[] {
  const s = sessionInfo?.stats ?? {};
  const c = sessionInfo?.context ?? ctxData;
  const out: HTMLElement[] = [];
  if (focusSession && sessionInfo) {
    const back = el('button', 'mini', '← All sessions');
    back.onclick = () => { focusSession = ''; sessionInfo = null; void load(); };
    const bar = el('div', 'toolrow');
    bar.append(back, el('span', 'hint', sessionInfo.title || focusSession));
    out.push(bar);
  }
  out.push(card('sessionStats', focusSession ? 'Session totals' : 'This session', sessionInfo?.title ?? 'none', () => {
    return tileGrid([
      ['Tokens', fmt(s.totalTokens ?? 0)], ['Text', fmt(s.tokens ?? 0)], ['Cache', fmt(s.cache ?? 0)],
      ['Requests', String(s.requests ?? 0)], ['Tools', String(s.tools ?? 0)], ['Skills', String(s.skills ?? 0)],
      ['Est. cost', `$${estCost(s).toFixed(4)}`], ['Context req', String(sessionInfo?.context?.requests ?? 0)],
    ]);
  }));
  out.push(tokenBreakdown(s, focusSession ? 'Session token breakdown' : 'Session token breakdown', 'tokens'));
  out.push(contextCard(c));
  out.push(...contextExtras(c));
  if (sessionInfo?.daily?.length) {
    out.push(barCard('sessionBars', 'Session activity', sessionInfo.daily.map((d: any) => ({ day: d.day, tokens: d.tokens })), 'tokens'));
  }
  out.push(budgetCard(summary?.stats ?? {}));
  return out;
}

function applyCardOrder(): void {
  if (!settings.cardOrder.length) return;
  const cards = [...root.querySelectorAll<HTMLElement>('[data-card]')];
  const foot = root.querySelector('.foot');
  const ordered = [...settings.cardOrder]
    .map((id) => cards.find((c) => c.dataset.card === id))
    .filter((c): c is HTMLElement => Boolean(c));
  for (const c of ordered) root.insertBefore(c, foot);
}

function overviewCards(): HTMLElement[] {
  // Global Today section stays visible even when a session is open.
  const out: HTMLElement[] = [todayCard()];
  if (todayData) out.push(tokenBreakdown(todayData.stats, "Today's token breakdown"));
  out.push(historyCard(data!.totals));
  out.push(card('stats', 'Current period', data!.label, () => statTiles(data!.stats, data!.deltas)));
  out.push(budgetCard(summary?.stats ?? {}));
  if (currentSession) {
    out.push(...sessionOverview());
  } else {
    out.push(contextCard());
    out.push(...contextExtras());
  }
  return out;
}

function renderStatus(): void {
  root.replaceChildren();
  if (!summary) { root.append(el('div', 'empty', 'Reading usage…')); return; }
  if (summary.error) { mountEmpty(root, { title: 'No usage data', body: summary.error }); return; }
  root.append(card('statusStats', 'Today at a glance', '', () => statTiles(summary!.stats, summary!.deltas)));
  root.append(historyCard(summary!.totals, true));
  const d = summary!.deltas.tokens;
  if (d !== null && d !== undefined) root.append(el('div', 'foot', `Tokens ${d >= 0 ? 'up' : 'down'} ${Math.abs(d)}% versus yesterday`));
  if (settings.budget && (summary!.stats.totalTokens ?? 0) > settings.budget) {
    root.append(el('div', 'hint up', `Daily budget exceeded: ${fmt(summary!.stats.totalTokens - settings.budget)} tokens over.`));
  }
  requestAnimationFrame(() => { void host.setHeight(Math.min(320, Math.ceil(root.getBoundingClientRect().height) + 12)); });
}

function tokenTab(): void {
  const s = data!.stats;
  root.append(tokenBreakdown(s, 'Token breakdown · selected period'));
  root.append(barCard('tokenBars', 'Token volume', data!.dailyTokens.map((d) => ({ day: d.day, tokens: d.total })), 'tokens'));
  root.append(heatCard('tokenHeat', 'Token activity', data!.heat, 'tokens'));
  root.append(historyCard(data!.totals));
}

function modelTab(): void {
  root.append(tableCard('models', 'By model', data!.byModel, [NAME, USES, IN, OUT, CACHE, TOK]));
  root.append(barCard('modelBars', 'Tokens by model', data!.dailyTokens.map((d) => ({ day: d.day, tokens: d.total })), 'tokens'));
  root.append(heatCard('modelHeat', 'Model activity', data!.heat, 'tokens'));
}

function tableWithViews(id: string, title: string, rows: Row[], heat: { day: string; tokens: number }[], cols: Col[], onRow?: (r: Row) => void): void {
  root.append(tableCard(id, title, rows, cols, onRow));
  root.append(barCard(`${id}Bars`, `${title} · daily`, heat, 'uses'));
  root.append(heatCard(`${id}Heat`, `${title} · heat map`, heat, 'uses'));
}

async function loadSession(id: string): Promise<void> {
  try { sessionInfo = await json(`/session?session=${encodeURIComponent(id)}`); }
  catch { sessionInfo = { title: id, stats: {}, daily: [], context: null }; }
}

function selectRange(id: string): void {
  range = id;
  void saveView();
  void load();
}

function selectTab(id: string): void {
  if (id !== 'session') focusSession = '';
  tab = id;
  void saveView();
  if (id === 'logs' && !logData.length) void loadLogs();
  else render();
}

function renderPanel(): void {
  document.body.classList.toggle('icon-picker', settings.sectionPicker === 'icons');
  root.replaceChildren();
  const top = el('div', 'rowbar');
  const toprow = el('div', 'toprow');
  const tabsWrap = el('div', 'tabs-wrap');
  mountTabs(tabsWrap, { items: TABS, activeId: tab, onChange: (id: string) => selectTab(id) });
  const tabSelect = el('div', 'tab-select');
  mountSelect(tabSelect, {
    value: tab,
    options: TABS.map((t) => ({ id: t.id, label: t.label })),
    onChange: (id: string) => selectTab(id),
    placeholder: 'Section',
  });
  const iconPick = el('div', 'icon-picker');
  for (const t of TABS) {
    const b = el('button', `icon-btn${t.id === tab ? ' active' : ''}`, TAB_ICONS[t.id]);
    b.title = t.label;
    b.setAttribute('aria-label', t.label);
    b.onclick = () => selectTab(t.id);
    iconPick.append(b);
  }
  toprow.append(tabsWrap, tabSelect, iconPick);
  top.append(toprow);
  const toolrow = el('div', 'toolrow');
  const ranges = el('div', 'tabs');
  mountTabs(ranges, { items: RANGES, activeId: range, onChange: (id: string) => selectRange(id) });
  const periodSelect = el('div', 'period-select');
  mountSelect(periodSelect, {
    value: range,
    options: RANGES.map((r) => ({ id: r.id, label: r.label })),
    onChange: (id: string) => selectRange(id),
    placeholder: 'Period',
  });
  toolrow.append(ranges, periodSelect);
  const pick = el('div', 'proj');
  mountSelect(pick, {
    value: project,
    options: [{ id: ALL, label: 'All projects' }, ...(data?.projects ?? []).map((p) => ({ id: p, label: p.split('/').pop() || p }))],
    onChange: (id: string) => { project = id; void saveView(); void load(); if (tab === 'logs') void loadLogs(); },
    placeholder: 'Project',
  });
  toolrow.append(pick);
  const refresh = el('div', 'refresh');
  mountButton(refresh, { label: '⟳', onClick: () => { void load(true); if (tab === 'logs') void loadLogs(); } });
  refresh.querySelector('button')?.setAttribute('title', 'Refresh');
  toolrow.append(refresh);
  const search = el('div', 'search');
  const input = el('input');
  (input as HTMLInputElement).type = 'search';
  (input as HTMLInputElement).placeholder = 'Filter tables';
  (input as HTMLInputElement).dataset.focusKey = 'filter';
  (input as HTMLInputElement).value = filter;
  input.oninput = () => { filter = (input as HTMLInputElement).value; render(); };
  search.append(input);
  toolrow.append(search);
  top.append(toolrow);
  root.append(top);

  if (!data) { root.append(el('div', 'empty', 'Reading usage…')); return; }
  if (data.error) { mountEmpty(root, { title: 'No usage data', body: data.error }); return; }

  if (tab === 'overview') {
    for (const c of overviewCards()) root.append(c);
  } else if (tab === 'token') {
    tokenTab();
  } else if (tab === 'date') {
    root.append(barCard('dateBars', 'Daily tokens', data.heat, 'tokens'));
    root.append(heatCard('dateHeat', 'Date activity', data.heat, 'tokens'));
    root.append(tableCard('days', 'By date', data.days, dateCols));
  } else if (tab === 'model') {
    modelTab();
  } else if (tab === 'session') {
    if (focusSession) {
      for (const c of sessionOverview()) root.append(c);
    } else {
      tableWithViews('sessions', 'By session', data.bySession, data.heat, [NAME, USES, ERR, TOK], (r) => {
        focusSession = r.id || '';
        void loadSession(focusSession).then(() => render());
      });
    }
  } else if (tab === 'project') {
    tableWithViews('projects', 'By project', data.byProject, data.heat, [NAME, USES, ERR, TOK]);
  } else if (tab === 'context') {
    root.append(contextCard());
    for (const c of contextExtras()) root.append(c);
    root.append(card('contextUse', 'Last request tokens', '', () => tokenBreakdown(ctxData ? {
      input: ctxData.input, output: ctxData.output, reasoning: ctxData.reasoning,
      cacheRead: ctxData.cacheRead, cacheWrite: ctxData.cacheWrite,
      totalTokens: ctxData.used, cacheHitRate: ctxData.cacheHitRate,
    } : {}, 'tokens')));
    root.append(hourCard(data.hours));
  } else if (tab === 'tool') {
    tableWithViews('tools', 'By tool', data.byTool, data.heatTools, [NAME, USES, ERR]);
  } else if (tab === 'skill') {
    tableWithViews('skills', 'By skill', data.bySkill, data.heatSkills, [NAME, USES]);
  } else if (tab === 'mcp') {
    tableWithViews('mcp', 'By MCP', data.byMcp, data.heatMcp, [NAME, USES]);
  } else if (tab === 'logs') {
    root.append(logCard());
  } else if (tab === 'settings') {
    root.append(settingsCard());
  }
  applyCardOrder();
  root.append(el('div', 'foot', `Updated ${clock(data.builtAt)} · checks every 5s · local OpenCode data`));
}

function render(): void {
  const active = document.activeElement as HTMLInputElement | null;
  const focusKey = active?.dataset?.focusKey ?? '';
  const caret = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;
  const y = window.scrollY;
  if (surface === 'status') renderStatus();
  else renderPanel();
  requestAnimationFrame(() => {
    if (focusKey) {
      const el = document.querySelector<HTMLInputElement>(`[data-focus-key="${focusKey}"]`);
      if (el) {
        el.focus();
        if (caret !== null) el.setSelectionRange(caret, caret);
      }
    }
    if (y) window.scrollTo(0, y);
  });
}

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  surface = context.surface ?? 'panel';
  currentSession = (context.session as any)?.id ?? '';
  document.body.classList.toggle('status', surface === 'status');
  if (ready) return;
  ready = true;
  void (async () => { await loadView(); await load(); if (surface === 'panel' && tab === 'logs') await loadLogs(); })();
  setInterval(() => {
    if (loading || document.visibilityState !== 'visible') return;
    void load(true);
  }, 5000);
});
