import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ShadowingDB } from './db.js';
import type { ShadowingConfig } from './types.js';
import { calculateSOPMetrics } from './metrics.js';
import { formatDuration } from './task-manager.js';
import { diffTexts } from './diff.js';

// ── REST API Router ──────────────────────────────────────────────────────────

export function createUIServer(db: ShadowingDB, config: ShadowingConfig) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const path = url.pathname;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // ── API routes ────────────────────────────────────────────
      if (path === '/api/stats' && req.method === 'GET') {
        json(res, db.getGlobalStats());
      } else if (path === '/api/tasks' && req.method === 'GET') {
        const status = url.searchParams.get('status') ?? undefined;
        json(res, db.listTasks(status ? { status: status as 'active' | 'paused' | 'completed' | 'cancelled' } : undefined));
      } else if (path === '/api/tasks/active' && req.method === 'GET') {
        json(res, db.getActiveTask());
      } else if (path === '/api/sops' && req.method === 'GET') {
        const status = url.searchParams.get('status') ?? undefined;
        const tag = url.searchParams.get('tag') ?? undefined;
        const search = url.searchParams.get('search') ?? undefined;
        const sops = db.listSOPs({
          status: status as 'draft' | 'reviewed' | 'approved' | 'exported' | 'archived' | undefined,
          tag, search,
        });
        json(res, sops.map(s => ({
          ...s,
          tags: db.getTagsForSOP(s.id).map(t => t.name),
        })));
      } else if (path.match(/^\/api\/sops\/[a-f0-9]+$/) && req.method === 'GET') {
        const id = path.split('/').pop()!;
        const sop = db.getSOP(id);
        if (!sop) { notFound(res); return; }
        const tags = db.getTagsForSOP(id).map(t => t.name);
        const metrics = calculateSOPMetrics(db, id, config.metrics.quality_score_weights);
        const versions = db.getSOPVersions(id);
        json(res, { ...sop, tags, metrics, versions });
      } else if (path.match(/^\/api\/sops\/[a-f0-9]+\/status$/) && req.method === 'PUT') {
        const id = path.split('/')[3]!;
        const body = await readBody(req);
        const { status } = JSON.parse(body) as { status: string };
        const sop = db.updateSOPStatus(id, status as 'draft' | 'reviewed' | 'approved' | 'exported' | 'archived');
        json(res, sop);
      } else if (path.match(/^\/api\/sops\/[a-f0-9]+\/diff$/) && req.method === 'GET') {
        const id = path.split('/')[3]!;
        const sop = db.getSOP(id);
        if (!sop) { notFound(res); return; }
        const versions = db.getSOPVersions(id);
        if (versions.length === 0) { json(res, { lines: [], addedCount: 0, removedCount: 0 }); return; }
        const prev = versions[0]!;
        json(res, { ...diffTexts(prev.content_md, sop.content_md), fromVersion: prev.version, toVersion: sop.version });
      } else if (path === '/api/tags' && req.method === 'GET') {
        json(res, db.listTags());
      } else if (path === '/api/exports' && req.method === 'GET') {
        json(res, db.getExports());
      } else if (path === '/' || path === '/index.html') {
        // Serve embedded HTML dashboard
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getDashboardHTML(config));
      } else {
        notFound(res);
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }));
    }
  });

  return server;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(res: ServerResponse, data: unknown) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function notFound(res: ServerResponse) {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// ── Embedded Dashboard HTML ──────────────────────────────────────────────────

function getDashboardHTML(config: ShadowingConfig): string {
  const port = config.ui_port;
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Shadowing Dashboard</title>
  <style>
    :root { --bg: #0d1117; --fg: #c9d1d9; --card: #161b22; --border: #30363d; --accent: #58a6ff; --green: #3fb950; --red: #f85149; --yellow: #d29922; --muted: #8b949e; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.6; padding: 2rem; max-width: 1200px; margin: 0 auto; }
    h1 { color: var(--accent); margin-bottom: 1.5rem; font-size: 1.5rem; }
    h2 { color: var(--fg); font-size: 1.1rem; margin-bottom: 0.8rem; border-bottom: 1px solid var(--border); padding-bottom: 0.3rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .stat { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; }
    .stat .value { font-size: 2rem; font-weight: 700; color: var(--accent); }
    .stat .label { color: var(--muted); font-size: 0.85rem; }
    .sop-list { list-style: none; }
    .sop-item { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 0.5rem; cursor: pointer; transition: border-color 0.15s; }
    .sop-item:hover { border-color: var(--accent); }
    .sop-item .title { font-weight: 600; }
    .sop-item .meta { color: var(--muted); font-size: 0.85rem; margin-top: 0.3rem; }
    .tag { display: inline-block; background: #1f6feb33; color: var(--accent); padding: 0.1rem 0.5rem; border-radius: 12px; font-size: 0.75rem; margin-right: 0.3rem; }
    .badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
    .badge-draft { background: var(--yellow); color: #000; }
    .badge-reviewed { background: var(--accent); color: #000; }
    .badge-approved { background: var(--green); color: #000; }
    .badge-exported { background: var(--muted); color: #000; }
    #detail { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1.5rem; margin-top: 1rem; display: none; }
    #detail pre { background: var(--bg); padding: 1rem; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; font-size: 0.9rem; line-height: 1.5; }
    .actions { margin-top: 1rem; display: flex; gap: 0.5rem; }
    .btn { padding: 0.4rem 0.8rem; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--fg); cursor: pointer; font-size: 0.85rem; }
    .btn:hover { border-color: var(--accent); }
    .btn-primary { background: var(--accent); color: #000; border-color: var(--accent); }
    .active-task { background: linear-gradient(135deg, #1a3a1a, #161b22); border: 1px solid var(--green); border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem; }
    .active-task .title { color: var(--green); font-weight: 700; }
    .filters { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
    .filters select, .filters input { background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 0.3rem 0.6rem; font-size: 0.85rem; }
    .quality-bar { height: 6px; border-radius: 3px; background: var(--border); margin-top: 0.3rem; overflow: hidden; }
    .quality-bar .fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
    .quality-bar .fill.high { background: var(--green); }
    .quality-bar .fill.mid { background: var(--yellow); }
    .quality-bar .fill.low { background: var(--red); }
    @media (max-width: 600px) { body { padding: 1rem; } .grid { grid-template-columns: 1fr 1fr; } }
  </style>
</head>
<body>
  <h1>Shadowing Dashboard</h1>

  <div id="active-task"></div>

  <h2>Statistiken</h2>
  <div class="grid" id="stats"></div>

  <h2>SOPs</h2>
  <div class="filters">
    <select id="filter-status" onchange="loadSOPs()">
      <option value="">Alle Status</option>
      <option value="draft">Draft</option>
      <option value="reviewed">Reviewed</option>
      <option value="approved">Approved</option>
      <option value="exported">Exported</option>
    </select>
    <input id="filter-search" placeholder="Suche..." oninput="loadSOPs()">
  </div>
  <ul class="sop-list" id="sop-list"></ul>

  <div id="detail"></div>

  <script>
    const API = '';
    async function get(path) { return (await fetch(API + path)).json(); }
    async function put(path, body) { return (await fetch(API + path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(); }

    function fmtDur(sec) {
      if (!sec) return '-';
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      return h > 0 ? h + 'h ' + m + 'min' : m + 'min';
    }

    async function loadStats() {
      const s = await get('/api/stats');
      document.getElementById('stats').innerHTML =
        stat(s.total_tasks, 'Tasks') + stat(s.completed_tasks, 'Abgeschlossen') +
        stat(s.total_sops, 'SOPs') + stat(s.approved_sops, 'Approved') +
        stat(s.total_executions, 'Ausführungen') + stat(s.total_exports, 'Exports');
    }

    function stat(value, label) {
      return '<div class="stat"><div class="value">' + value + '</div><div class="label">' + label + '</div></div>';
    }

    async function loadActiveTask() {
      const task = await get('/api/tasks/active');
      const el = document.getElementById('active-task');
      if (!task) { el.innerHTML = ''; return; }
      const elapsed = Math.round((Date.now() - new Date(task.started_at).getTime()) / 1000);
      el.innerHTML = '<div class="active-task"><div class="title">Aktiver Task: ' + esc(task.title) + '</div><div class="meta">Laufzeit: ' + fmtDur(elapsed) + (task.description ? ' | ' + esc(task.description.substring(0, 100)) : '') + '</div></div>';
    }

    async function loadSOPs() {
      const status = document.getElementById('filter-status').value;
      const search = document.getElementById('filter-search').value;
      let url = '/api/sops?';
      if (status) url += 'status=' + status + '&';
      if (search) url += 'search=' + encodeURIComponent(search) + '&';
      const sops = await get(url);
      const list = document.getElementById('sop-list');
      list.innerHTML = sops.map(s =>
        '<li class="sop-item" onclick="showSOP(\\'' + s.id + '\\')">' +
        '<span class="title">' + esc(s.title) + '</span> ' +
        '<span class="badge badge-' + s.status + '">' + s.status + '</span>' +
        '<div class="meta">' +
        (s.tags || []).map(t => '<span class="tag">#' + esc(t) + '</span>').join('') +
        ' | v' + s.version + ' | ' + s.created_at.substring(0, 10) +
        '</div></li>'
      ).join('');
    }

    async function showSOP(id) {
      const data = await get('/api/sops/' + id);
      const el = document.getElementById('detail');
      el.style.display = 'block';

      const q = data.metrics?.overall_quality_score ?? 0;
      const qClass = q >= 70 ? 'high' : q >= 40 ? 'mid' : 'low';

      el.innerHTML =
        '<h2>' + esc(data.title) + ' <span class="badge badge-' + data.status + '">' + data.status + '</span></h2>' +
        '<div class="meta" style="margin:0.5rem 0">' +
        'Version ' + data.version + ' | ' +
        (data.tags || []).map(t => '<span class="tag">#' + esc(t) + '</span>').join('') +
        '</div>' +
        (data.metrics?.execution_count > 0 ?
          '<div class="meta">Ausführungen: ' + data.metrics.execution_count +
          ' | Avg: ' + fmtDur(data.metrics.avg_duration_seconds) +
          ' | Qualität: ' + q + '%</div>' +
          '<div class="quality-bar"><div class="fill ' + qClass + '" style="width:' + q + '%"></div></div>' : '') +
        '<pre>' + esc(data.content_md) + '</pre>' +
        '<div class="actions">' +
        (data.status === 'draft' ? '<button class="btn btn-primary" onclick="setStatus(\\'' + id + '\\',\\'reviewed\\')">Als reviewed markieren</button>' : '') +
        (data.status === 'reviewed' ? '<button class="btn btn-primary" onclick="setStatus(\\'' + id + '\\',\\'approved\\')">Approve</button>' : '') +
        '</div>' +
        (data.versions?.length > 0 ? '<h2 style="margin-top:1rem">Versionen (' + data.versions.length + ')</h2>' +
          data.versions.map(v => '<div class="meta">v' + v.version + ' — ' + v.changed_at + (v.change_summary ? ' — ' + esc(v.change_summary) : '') + '</div>').join('') : '');

      el.scrollIntoView({ behavior: 'smooth' });
    }

    async function setStatus(id, status) {
      await put('/api/sops/' + id + '/status', { status });
      loadSOPs();
      showSOP(id);
    }

    function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

    loadStats();
    loadActiveTask();
    loadSOPs();
    setInterval(loadActiveTask, 30000);
  </script>
</body>
</html>`;
}
