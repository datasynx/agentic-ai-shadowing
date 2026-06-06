import type { ShadowingConfig } from './types.js';
import { getPackageVersion } from './version.js';

export function getDashboardHTML(config: ShadowingConfig, authToken = ''): string {
  // Token is a hex string from randomBytes; JSON.stringify keeps the inline
  // script well-formed and prevents breaking out of the assignment.
  const tokenLiteral = JSON.stringify(authToken);
  const version = getPackageVersion();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Shadowing Dashboard</title>
<style>
/* ── Design System ──────────────────────────────────────────────────────── */
:root {
  --bg-0: #0a0e14; --bg-1: #0d1117; --bg-2: #161b22; --bg-3: #1c2128; --bg-4: #21262d;
  --fg: #e6edf3; --fg-muted: #8b949e; --fg-subtle: #6e7681;
  --border: #30363d; --border-light: #3d444d;
  --accent: #58a6ff; --accent-hover: #79c0ff; --accent-bg: rgba(56,139,253,0.1);
  --green: #3fb950; --green-bg: rgba(63,185,80,0.12);
  --red: #f85149; --red-bg: rgba(248,81,73,0.12);
  --yellow: #d29922; --yellow-bg: rgba(210,153,34,0.12);
  --purple: #bc8cff; --purple-bg: rgba(188,140,255,0.12);
  --orange: #f0883e;
  --radius-sm: 6px; --radius-md: 8px; --radius-lg: 12px;
  --shadow: 0 1px 3px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2);
  --shadow-lg: 0 4px 12px rgba(0,0,0,0.4);
  --transition: 150ms ease;
  --sidebar-w: 260px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  --font-mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
}
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; overflow: hidden; }
body { font-family: var(--font); background: var(--bg-1); color: var(--fg); font-size: 14px; line-height: 1.6; display: flex; }

/* ── Sidebar ────────────────────────────────────────────────────────────── */
.sidebar {
  width: var(--sidebar-w); min-width: var(--sidebar-w); height: 100vh;
  background: var(--bg-0); border-right: 1px solid var(--border);
  display: flex; flex-direction: column; overflow-y: auto;
}
.sidebar-brand {
  padding: 20px 16px 12px; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 10px;
}
.sidebar-brand svg { width: 28px; height: 28px; fill: var(--accent); flex-shrink: 0; }
.sidebar-brand h1 { font-size: 15px; font-weight: 700; color: var(--fg); letter-spacing: -0.3px; }
.sidebar-brand small { display: block; font-size: 11px; color: var(--fg-muted); font-weight: 400; }
.sidebar-nav { padding: 8px; flex: 1; }
.nav-section { padding: 12px 8px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--fg-subtle); font-weight: 600; }
.nav-item {
  display: flex; align-items: center; gap: 10px; padding: 8px 12px;
  border-radius: var(--radius-sm); color: var(--fg-muted); text-decoration: none;
  cursor: pointer; transition: all var(--transition); font-size: 13px; font-weight: 500;
}
.nav-item:hover { background: var(--bg-2); color: var(--fg); }
.nav-item.active { background: var(--accent-bg); color: var(--accent); }
.nav-item svg { width: 16px; height: 16px; opacity: 0.7; flex-shrink: 0; }
.nav-item.active svg { opacity: 1; }
.nav-badge {
  margin-left: auto; background: var(--bg-3); color: var(--fg-muted);
  padding: 1px 7px; border-radius: 10px; font-size: 11px; font-weight: 600;
}
.sidebar-footer {
  padding: 12px 16px; border-top: 1px solid var(--border);
  font-size: 11px; color: var(--fg-subtle);
}

/* ── Main ───────────────────────────────────────────────────────────────── */
.main { flex: 1; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; }
.topbar {
  padding: 16px 24px; border-bottom: 1px solid var(--border); background: var(--bg-1);
  display: flex; align-items: center; justify-content: space-between; min-height: 56px;
  position: sticky; top: 0; z-index: 10;
}
.topbar h2 { font-size: 16px; font-weight: 600; }
.topbar-actions { display: flex; gap: 8px; align-items: center; }
.content { flex: 1; padding: 24px; max-width: 1400px; width: 100%; }

/* ── Components ─────────────────────────────────────────────────────────── */
.card {
  background: var(--bg-2); border: 1px solid var(--border); border-radius: var(--radius-md);
  padding: 16px; transition: border-color var(--transition);
}
.card:hover { border-color: var(--border-light); }
.card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.card-title { font-size: 13px; font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.3px; }

/* Stat Cards */
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
.stat-card { text-align: center; padding: 20px 16px; }
.stat-value { font-size: 28px; font-weight: 700; line-height: 1.2; }
.stat-value.accent { color: var(--accent); }
.stat-value.green { color: var(--green); }
.stat-value.yellow { color: var(--yellow); }
.stat-value.purple { color: var(--purple); }
.stat-label { font-size: 12px; color: var(--fg-muted); margin-top: 4px; }

/* Buttons */
.btn {
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-2); color: var(--fg); cursor: pointer;
  font-size: 13px; font-weight: 500; font-family: var(--font);
  transition: all var(--transition); white-space: nowrap;
}
.btn:hover { background: var(--bg-3); border-color: var(--border-light); }
.btn-sm { padding: 4px 10px; font-size: 12px; }
.btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.btn-primary:hover { background: var(--accent-hover); }
.btn-success { background: var(--green); color: #fff; border-color: var(--green); }
.btn-danger { background: transparent; color: var(--red); border-color: var(--red); }
.btn-danger:hover { background: var(--red-bg); }
.btn-ghost { background: transparent; border-color: transparent; }
.btn-ghost:hover { background: var(--bg-3); }
.btn-group { display: flex; gap: 0; }
.btn-group .btn { border-radius: 0; margin-left: -1px; }
.btn-group .btn:first-child { border-radius: var(--radius-sm) 0 0 var(--radius-sm); margin-left: 0; }
.btn-group .btn:last-child { border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }
.btn-group .btn.active { background: var(--accent-bg); color: var(--accent); border-color: var(--accent); z-index: 1; }

/* Badges */
.badge {
  display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 12px;
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
}
.badge-draft { background: var(--yellow-bg); color: var(--yellow); }
.badge-reviewed { background: var(--accent-bg); color: var(--accent); }
.badge-approved { background: var(--green-bg); color: var(--green); }
.badge-exported { background: var(--purple-bg); color: var(--purple); }
.badge-archived { background: var(--bg-3); color: var(--fg-muted); }
.badge-active { background: var(--green-bg); color: var(--green); }
.badge-paused { background: var(--yellow-bg); color: var(--yellow); }
.badge-completed { background: var(--accent-bg); color: var(--accent); }

/* Tags */
.tag {
  display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 12px;
  font-size: 11px; font-weight: 500; background: var(--accent-bg); color: var(--accent);
  cursor: pointer; transition: all var(--transition); gap: 4px;
}
.tag:hover { background: rgba(56,139,253,0.2); }
.tag-remove { cursor: pointer; opacity: 0.6; font-size: 13px; line-height: 1; }
.tag-remove:hover { opacity: 1; color: var(--red); }

/* Forms */
.input, .select, .textarea {
  background: var(--bg-1); border: 1px solid var(--border); border-radius: var(--radius-sm);
  color: var(--fg); padding: 6px 12px; font-size: 13px; font-family: var(--font);
  transition: border-color var(--transition); width: 100%;
}
.input:focus, .select:focus, .textarea:focus { outline: none; border-color: var(--accent); }
.textarea { font-family: var(--font-mono); font-size: 13px; line-height: 1.6; resize: vertical; }
.input-group { display: flex; gap: 8px; align-items: center; }
.search-box { position: relative; }
.search-box .input { padding-left: 32px; }
.search-box svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; color: var(--fg-muted); }

/* Quality Bar */
.quality-bar { height: 6px; border-radius: 3px; background: var(--bg-4); overflow: hidden; }
.quality-fill { height: 100%; border-radius: 3px; transition: width 0.4s ease; }
.q-high { background: var(--green); }
.q-mid { background: var(--yellow); }
.q-low { background: var(--red); }
.quality-ring {
  width: 64px; height: 64px; border-radius: 50%; position: relative;
  display: flex; align-items: center; justify-content: center;
}
.quality-ring svg { transform: rotate(-90deg); }
.quality-ring .ring-text { position: absolute; font-size: 14px; font-weight: 700; }

/* Tables */
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--fg-muted); padding: 8px 12px; border-bottom: 1px solid var(--border); font-weight: 600; }
td { padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
tr:hover td { background: var(--bg-3); }
tr.selected td { background: var(--accent-bg); }

/* Markdown rendered content */
.md-content { line-height: 1.7; }
.md-content h1 { font-size: 22px; font-weight: 700; margin: 24px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
.md-content h2 { font-size: 18px; font-weight: 600; margin: 20px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
.md-content h3 { font-size: 15px; font-weight: 600; margin: 16px 0 8px; }
.md-content p { margin: 8px 0; }
.md-content ul, .md-content ol { margin: 8px 0; padding-left: 24px; }
.md-content li { margin: 4px 0; }
.md-content code { background: var(--bg-4); padding: 2px 6px; border-radius: 4px; font-family: var(--font-mono); font-size: 12px; }
.md-content pre { background: var(--bg-0); padding: 16px; border-radius: var(--radius-md); overflow-x: auto; margin: 12px 0; border: 1px solid var(--border); }
.md-content pre code { background: none; padding: 0; font-size: 13px; }
.md-content strong { font-weight: 600; }
.md-content em { font-style: italic; color: var(--fg-muted); }
.md-content blockquote { border-left: 3px solid var(--accent); padding: 4px 16px; margin: 8px 0; color: var(--fg-muted); background: var(--bg-3); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }

/* SOP List */
.sop-row {
  display: grid; grid-template-columns: 1fr auto auto auto;
  gap: 12px; align-items: center; padding: 12px 16px;
  border-bottom: 1px solid var(--border); cursor: pointer;
  transition: background var(--transition);
}
.sop-row:hover { background: var(--bg-3); }
.sop-row.selected { background: var(--accent-bg); border-left: 2px solid var(--accent); }
.sop-title { font-weight: 600; font-size: 14px; }
.sop-meta { font-size: 12px; color: var(--fg-muted); margin-top: 2px; }

/* Split Pane (Editor) */
.split-pane { display: grid; grid-template-columns: 1fr 1fr; gap: 0; height: calc(100vh - 130px); }
.split-left, .split-right { overflow-y: auto; }
.split-left { border-right: 1px solid var(--border); }
.split-left .textarea { height: 100%; border: none; border-radius: 0; resize: none; padding: 20px; }
.split-right { padding: 20px; }

/* Timeline */
.timeline-item {
  display: flex; gap: 12px; padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.timeline-dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 6px; flex-shrink: 0; }
.timeline-dot.window { background: var(--accent); }
.timeline-dot.shell { background: var(--green); }
.timeline-dot.git { background: var(--orange); }
.timeline-dot.file { background: var(--purple); }
.timeline-dot.manual { background: var(--yellow); }
.timeline-content { flex: 1; min-width: 0; }
.timeline-time { font-size: 11px; color: var(--fg-subtle); white-space: nowrap; }

/* Modal */
.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 100;
  display: flex; align-items: center; justify-content: center;
  opacity: 0; pointer-events: none; transition: opacity 200ms;
}
.modal-overlay.open { opacity: 1; pointer-events: auto; }
.modal {
  background: var(--bg-2); border: 1px solid var(--border); border-radius: var(--radius-lg);
  width: 90%; max-width: 600px; max-height: 80vh; overflow-y: auto;
  box-shadow: var(--shadow-lg); padding: 24px;
}
.modal h3 { margin-bottom: 16px; font-size: 16px; }

/* Toast */
.toast-container { position: fixed; bottom: 20px; right: 20px; z-index: 200; display: flex; flex-direction: column; gap: 8px; }
.toast {
  padding: 10px 16px; border-radius: var(--radius-md); font-size: 13px; font-weight: 500;
  box-shadow: var(--shadow-lg); animation: slideIn 300ms ease;
  display: flex; align-items: center; gap: 8px;
}
.toast-success { background: var(--green); color: #fff; }
.toast-error { background: var(--red); color: #fff; }
.toast-info { background: var(--accent); color: #fff; }
@keyframes slideIn { from { transform: translateX(100px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

/* Empty State */
.empty-state { text-align: center; padding: 48px 24px; color: var(--fg-muted); }
.empty-state svg { width: 48px; height: 48px; margin-bottom: 12px; opacity: 0.3; }
.empty-state p { font-size: 14px; }

/* Diff */
.diff-line { font-family: var(--font-mono); font-size: 12px; padding: 1px 12px; white-space: pre-wrap; }
.diff-add { background: var(--green-bg); color: var(--green); }
.diff-remove { background: var(--red-bg); color: var(--red); }
.diff-context { color: var(--fg-muted); }

/* Progress Ring */
.progress-ring { display: inline-block; }

/* Active Task Banner */
.active-banner {
  background: linear-gradient(135deg, rgba(63,185,80,0.08), rgba(56,139,253,0.08));
  border: 1px solid var(--green); border-radius: var(--radius-md);
  padding: 16px 20px; margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between;
}
.active-banner .task-info { display: flex; align-items: center; gap: 12px; }
.active-banner .pulse { width: 10px; height: 10px; border-radius: 50%; background: var(--green); animation: pulse 2s infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.active-banner .task-title { font-weight: 600; font-size: 14px; }
.active-banner .task-duration { font-family: var(--font-mono); font-size: 20px; font-weight: 700; color: var(--green); }

/* Checkbox */
.checkbox { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.checkbox input { width: 16px; height: 16px; accent-color: var(--accent); cursor: pointer; }

/* Responsive */
@media (max-width: 768px) {
  .sidebar { display: none; }
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
  .split-pane { grid-template-columns: 1fr; }
  .sop-row { grid-template-columns: 1fr; }
}

/* Scrollbar */
::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--bg-4); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--border-light); }

/* Loading */
.spinner { width: 20px; height: 20px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 600ms linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.loading-center { display: flex; justify-content: center; padding: 48px; }

/* Tabs */
.tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
.tab {
  padding: 8px 16px; font-size: 13px; color: var(--fg-muted); cursor: pointer;
  border-bottom: 2px solid transparent; transition: all var(--transition); font-weight: 500;
}
.tab:hover { color: var(--fg); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }

/* Filter bar */
.filter-bar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
.filter-tags { display: flex; gap: 4px; flex-wrap: wrap; }
</style>
</head>
<body>

<!-- ── Sidebar ──────────────────────────────────────────────────────────── -->
<nav class="sidebar">
  <div class="sidebar-brand">
    <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
    <div><h1>Shadowing</h1><small>Enterprise Dashboard</small></div>
  </div>
  <div class="sidebar-nav">
    <div class="nav-section">General</div>
    <div class="nav-item active" onclick="navigate('dashboard')" data-page="dashboard">
      <svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>
      Dashboard
    </div>
    <div class="nav-item" onclick="navigate('sops')" data-page="sops">
      <svg viewBox="0 0 24 24"><path fill="currentColor" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
      SOPs
      <span class="nav-badge" id="nav-sop-count">-</span>
    </div>
    <div class="nav-item" onclick="navigate('export')" data-page="export">
      <svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
      Export
    </div>
    <div class="nav-section">Observation</div>
    <div class="nav-item" onclick="navigate('timeline')" data-page="timeline">
      <svg viewBox="0 0 24 24"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
      Timeline
    </div>
  </div>
  <div class="sidebar-footer">
    Agentic AI Shadowing v${version}<br>Port: ${config.ui_port}
  </div>
</nav>

<!-- ── Main Content ─────────────────────────────────────────────────────── -->
<div class="main">
  <div class="topbar">
    <h2 id="page-title">Dashboard</h2>
    <div class="topbar-actions" id="topbar-actions"></div>
  </div>
  <div class="content" id="content">
    <div class="loading-center"><div class="spinner"></div></div>
  </div>
</div>

<!-- ── Modal ────────────────────────────────────────────────────────────── -->
<div class="modal-overlay" id="modal-overlay" onclick="if(event.target===this)closeModal()">
  <div class="modal" id="modal-content"></div>
</div>

<!-- ── Toast Container ──────────────────────────────────────────────────── -->
<div class="toast-container" id="toast-container"></div>

<script>
/* ═══════════════════════════════════════════════════════════════════════════
   API Client
   ═══════════════════════════════════════════════════════════════════════════ */
// Same-origin auth token injected by the server so the dashboard can call /api/*.
window.__SHADOWING_TOKEN__ = ${tokenLiteral};
function authHeaders(extra) {
  const h = Object.assign({}, extra || {});
  if (window.__SHADOWING_TOKEN__) h['Authorization'] = 'Bearer ' + window.__SHADOWING_TOKEN__;
  return h;
}
const API = {
  async get(path) {
    const r = await fetch(path, { headers: authHeaders() });
    if (!r.ok) throw new Error('API ' + r.status);
    return r.json();
  },
  async put(path, body) {
    const r = await fetch(path, { method:'PUT', headers: authHeaders({'Content-Type':'application/json'}), body: JSON.stringify(body) });
    if (!r.ok) throw new Error('API ' + r.status);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, { method:'POST', headers: authHeaders({'Content-Type':'application/json'}), body: JSON.stringify(body) });
    if (!r.ok) throw new Error('API ' + r.status);
    return r.json();
  }
};

/* ═══════════════════════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════════════════════ */
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

function fmtDur(sec) {
  if (!sec || sec <= 0) return '-';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return h + 'h ' + m + 'min';
  if (m > 0) return m + 'min ' + s + 's';
  return s + 's';
}

function fmtDate(iso) { return iso ? iso.substring(0, 10) : '-'; }
function fmtTime(iso) { return iso ? iso.substring(11, 16) : '-'; }
function fmtDateTime(iso) { return iso ? iso.substring(0, 16).replace('T', ' ') : '-'; }

function qClass(score) { return score >= 70 ? 'q-high' : score >= 40 ? 'q-mid' : 'q-low'; }
function qColor(score) { return score >= 70 ? 'var(--green)' : score >= 40 ? 'var(--yellow)' : 'var(--red)'; }

function badgeHTML(status) {
  return '<span class="badge badge-' + esc(status) + '">' + esc(status) + '</span>';
}

function tagsHTML(tags, removable, sopId) {
  return (tags || []).map(t =>
    '<span class="tag">#' + esc(t) +
    (removable ? ' <span class="tag-remove" onclick="event.stopPropagation();removeTag(\\'' + sopId + '\\',\\'' + esc(t) + '\\')">&times;</span>' : '') +
    '</span>'
  ).join(' ');
}

function qualityRing(score, size) {
  size = size || 64;
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const off = c - (score / 100) * c;
  const color = qColor(score);
  return '<div class="quality-ring" style="width:'+size+'px;height:'+size+'px">' +
    '<svg width="'+size+'" height="'+size+'"><circle cx="'+(size/2)+'" cy="'+(size/2)+'" r="'+r+'" fill="none" stroke="var(--bg-4)" stroke-width="4"/>' +
    '<circle cx="'+(size/2)+'" cy="'+(size/2)+'" r="'+r+'" fill="none" stroke="'+color+'" stroke-width="4" stroke-dasharray="'+c+'" stroke-dashoffset="'+off+'" stroke-linecap="round"/></svg>' +
    '<span class="ring-text" style="color:'+color+'">'+Math.round(score)+'</span></div>';
}

/* ── Markdown Parser ──────────────────────────────────────────────────── */
function renderMD(text) {
  if (!text) return '';
  let html = esc(text);
  // Code blocks
  html = html.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, function(m, lang, code) {
    return '<pre><code>' + code + '</code></pre>';
  });
  // Inline code
  html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Bold & italic
  html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\\/li>\\n?)+/g, '<ul>$&</ul>');
  // Ordered lists
  html = html.replace(/^\\d+\\. (.+)$/gm, '<li>$1</li>');
  // Paragraphs
  html = html.replace(/^(?!<[hupbo]|<li|<code|<pre)(\\S.+)$/gm, '<p>$1</p>');
  // Clean up extra newlines
  html = html.replace(/\\n{2,}/g, '\\n');
  return html;
}

/* ── Toast ─────────────────────────────────────────────────────────────── */
function toast(msg, type) {
  type = type || 'info';
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(function() { el.remove(); }, 3500);
}

/* ── Modal ─────────────────────────────────────────────────────────────── */
function openModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

/* ═══════════════════════════════════════════════════════════════════════════
   Router
   ═══════════════════════════════════════════════════════════════════════════ */
let currentPage = 'dashboard';
let currentSOPId = null;
let activeTaskTimer = null;

function navigate(page, params) {
  currentPage = page;
  // Update nav
  document.querySelectorAll('.nav-item').forEach(function(el) {
    el.classList.toggle('active', el.dataset.page === page);
  });
  clearInterval(activeTaskTimer);
  const content = document.getElementById('content');
  content.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
  document.getElementById('topbar-actions').innerHTML = '';

  switch(page) {
    case 'dashboard': renderDashboard(); break;
    case 'sops': renderSOPList(); break;
    case 'sop-detail': renderSOPDetail(params); break;
    case 'sop-edit': renderSOPEditor(params); break;
    case 'export': renderExport(); break;
    case 'timeline': renderTimeline(); break;
    default: renderDashboard();
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Page: Dashboard
   ═══════════════════════════════════════════════════════════════════════════ */
async function renderDashboard() {
  document.getElementById('page-title').textContent = 'Dashboard';

  const [stats, activeTask, sops, tags] = await Promise.all([
    API.get('/api/stats'),
    API.get('/api/tasks/active'),
    API.get('/api/sops'),
    API.get('/api/tags')
  ]);

  document.getElementById('nav-sop-count').textContent = stats.total_sops;

  let html = '';

  // Active Task Banner
  if (activeTask) {
    html += '<div class="active-banner" id="active-banner">' +
      '<div class="task-info"><div class="pulse"></div>' +
      '<div><div class="task-title">' + esc(activeTask.title) + '</div>' +
      '<div style="font-size:12px;color:var(--fg-muted)">' + (activeTask.description ? esc(activeTask.description.substring(0, 120)) : 'No description') + '</div></div></div>' +
      '<div class="task-duration" id="task-timer">--:--</div></div>';
  }

  // Stats
  html += '<div class="stats-grid">';
  html += statCard(stats.total_tasks, 'Total Tasks', 'accent');
  html += statCard(stats.completed_tasks, 'Completed', 'green');
  html += statCard(stats.total_sops, 'SOPs', 'accent');
  html += statCard(stats.approved_sops, 'Approved', 'green');
  html += statCard(stats.total_executions, 'Executions', 'purple');
  html += statCard(stats.total_exports, 'Exports', 'yellow');
  html += '</div>';

  // Quality overview + SOP status distribution
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">';

  // Quality overview
  html += '<div class="card"><div class="card-header"><span class="card-title">Quality Overview</span></div>';
  if (stats.avg_quality_score > 0) {
    html += '<div style="display:flex;align-items:center;gap:20px">';
    html += qualityRing(stats.avg_quality_score, 80);
    html += '<div><div style="font-size:12px;color:var(--fg-muted)">Avg. Quality</div>';
    html += '<div style="font-size:24px;font-weight:700;color:' + qColor(stats.avg_quality_score) + '">' + Math.round(stats.avg_quality_score) + '%</div></div></div>';
  } else {
    html += '<div style="color:var(--fg-muted);font-size:13px">No quality data available yet</div>';
  }
  html += '</div>';

  // SOP status distribution
  html += '<div class="card"><div class="card-header"><span class="card-title">SOP Status Distribution</span></div>';
  const total = stats.total_sops || 1;
  html += statusBar('Draft', stats.draft_sops, total, 'var(--yellow)');
  html += statusBar('Reviewed', stats.reviewed_sops, total, 'var(--accent)');
  html += statusBar('Approved', stats.approved_sops, total, 'var(--green)');
  html += statusBar('Exported', stats.exported_sops, total, 'var(--purple)');
  html += '</div></div>';

  // Recent SOPs
  html += '<div class="card"><div class="card-header"><span class="card-title">Recent SOPs</span>' +
    '<button class="btn btn-sm" onclick="navigate(\\\'sops\\\')">Show all</button></div>';
  const recentSOPs = sops.slice(0, 5);
  if (recentSOPs.length === 0) {
    html += '<div class="empty-state"><p>No SOPs available yet. Start a task with <code>shadowing start</code></p></div>';
  } else {
    recentSOPs.forEach(function(s) {
      html += '<div class="sop-row" onclick="navigate(\\\'sop-detail\\\',\\'' + s.id + '\\')">' +
        '<div><div class="sop-title">' + esc(s.title) + '</div>' +
        '<div class="sop-meta">' + tagsHTML(s.tags) + '</div></div>' +
        badgeHTML(s.status) +
        '<span style="font-size:12px;color:var(--fg-muted)">v' + s.version + '</span>' +
        '<span style="font-size:12px;color:var(--fg-muted)">' + fmtDate(s.created_at) + '</span></div>';
    });
  }
  html += '</div>';

  // Tags overview
  if (tags.length > 0) {
    html += '<div class="card" style="margin-top:16px"><div class="card-header"><span class="card-title">Tags (' + tags.length + ')</span></div>';
    html += '<div style="display:flex;gap:6px;flex-wrap:wrap">';
    tags.forEach(function(t) {
      html += '<span class="tag" onclick="navigate(\\\'sops\\\');setTimeout(function(){filterByTag(\\'' + esc(t.name) + '\\')},100)">#' + esc(t.name) + '</span>';
    });
    html += '</div></div>';
  }

  document.getElementById('content').innerHTML = html;

  // Start active task timer
  if (activeTask) {
    const startedAt = new Date(activeTask.started_at).getTime();
    function updateTimer() {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
      const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
      const s = String(elapsed % 60).padStart(2, '0');
      const el = document.getElementById('task-timer');
      if (el) el.textContent = h + ':' + m + ':' + s;
    }
    updateTimer();
    activeTaskTimer = setInterval(updateTimer, 1000);
  }
}

function statCard(value, label, colorClass) {
  return '<div class="card stat-card"><div class="stat-value ' + colorClass + '">' + value + '</div><div class="stat-label">' + label + '</div></div>';
}

function statusBar(label, count, total, color) {
  const pct = total > 0 ? (count / total * 100) : 0;
  return '<div style="display:flex;align-items:center;gap:8px;margin:6px 0">' +
    '<span style="width:70px;font-size:12px;color:var(--fg-muted)">' + label + '</span>' +
    '<div style="flex:1;height:8px;background:var(--bg-4);border-radius:4px;overflow:hidden">' +
    '<div style="width:' + pct + '%;height:100%;background:' + color + ';border-radius:4px;transition:width 0.4s"></div></div>' +
    '<span style="width:30px;text-align:right;font-size:12px;font-weight:600">' + count + '</span></div>';
}

/* ═══════════════════════════════════════════════════════════════════════════
   Page: SOP List
   ═══════════════════════════════════════════════════════════════════════════ */
let sopListFilter = { status: '', tag: '', search: '' };

async function renderSOPList() {
  document.getElementById('page-title').textContent = 'SOPs';

  const [sops, tags] = await Promise.all([
    API.get('/api/sops'),
    API.get('/api/tags')
  ]);

  let html = '';

  // Filter Bar
  html += '<div class="filter-bar">';
  html += '<div class="search-box"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>';
  html += '<input class="input" id="sop-search" placeholder="Search SOPs..." oninput="filterSOPs()" value="' + esc(sopListFilter.search) + '"></div>';
  html += '<select class="select" style="width:auto" id="sop-status-filter" onchange="filterSOPs()">' +
    '<option value="">All Statuses</option><option value="draft">Draft</option>' +
    '<option value="reviewed">Reviewed</option><option value="approved">Approved</option>' +
    '<option value="exported">Exported</option><option value="archived">Archived</option></select>';
  html += '</div>';

  // Tag filter chips
  if (tags.length > 0) {
    html += '<div class="filter-tags" id="tag-filters" style="margin-bottom:12px">';
    tags.forEach(function(t) {
      html += '<span class="tag" onclick="toggleTagFilter(\\'' + esc(t.name) + '\\')" data-tag="' + esc(t.name) + '">#' + esc(t.name) + '</span>';
    });
    html += '</div>';
  }

  // SOP List
  html += '<div class="card" style="padding:0;overflow:hidden" id="sop-list-container">';
  html += renderSOPRows(sops);
  html += '</div>';

  document.getElementById('content').innerHTML = html;

  // Restore filter state
  if (sopListFilter.status) {
    document.getElementById('sop-status-filter').value = sopListFilter.status;
  }
}

function renderSOPRows(sops) {
  if (sops.length === 0) {
    return '<div class="empty-state"><p>No SOPs found</p></div>';
  }
  return sops.map(function(s) {
    return '<div class="sop-row" onclick="navigate(\\\'sop-detail\\\',\\'' + s.id + '\\')">' +
      '<div><div class="sop-title">' + esc(s.title) + '</div>' +
      '<div class="sop-meta">' + tagsHTML(s.tags) + '</div></div>' +
      badgeHTML(s.status) +
      '<span style="font-size:12px;color:var(--fg-muted)">v' + s.version + '</span>' +
      '<span style="font-size:12px;color:var(--fg-muted)">' + fmtDate(s.created_at) + '</span></div>';
  }).join('');
}

async function filterSOPs() {
  const search = document.getElementById('sop-search').value;
  const status = document.getElementById('sop-status-filter').value;
  sopListFilter.search = search;
  sopListFilter.status = status;

  let url = '/api/sops?';
  if (status) url += 'status=' + status + '&';
  if (sopListFilter.tag) url += 'tag=' + encodeURIComponent(sopListFilter.tag) + '&';
  if (search) url += 'search=' + encodeURIComponent(search) + '&';

  const sops = await API.get(url);
  document.getElementById('sop-list-container').innerHTML = renderSOPRows(sops);
}

function toggleTagFilter(tag) {
  sopListFilter.tag = sopListFilter.tag === tag ? '' : tag;
  document.querySelectorAll('#tag-filters .tag').forEach(function(el) {
    el.style.background = el.dataset.tag === sopListFilter.tag ? 'rgba(56,139,253,0.3)' : '';
  });
  filterSOPs();
}

function filterByTag(tag) {
  sopListFilter.tag = tag;
  filterSOPs();
  document.querySelectorAll('#tag-filters .tag').forEach(function(el) {
    el.style.background = el.dataset.tag === tag ? 'rgba(56,139,253,0.3)' : '';
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Page: SOP Detail
   ═══════════════════════════════════════════════════════════════════════════ */
async function renderSOPDetail(id) {
  currentSOPId = id;
  document.getElementById('page-title').textContent = 'SOP Detail';

  const data = await API.get('/api/sops/' + id);

  // Topbar actions
  document.getElementById('topbar-actions').innerHTML =
    '<button class="btn" onclick="navigate(\\\'sops\\\')">&larr; Back</button>' +
    '<button class="btn btn-primary" onclick="navigate(\\\'sop-edit\\\',\\'' + id + '\\')">Edit</button>' +
    statusActions(id, data.status);

  const q = data.metrics?.overall_quality_score ?? 0;
  let html = '';

  // Header
  html += '<div style="display:flex;gap:20px;margin-bottom:20px">';
  html += '<div style="flex:1"><h2 style="font-size:20px;margin-bottom:8px">' + esc(data.title) + ' ' + badgeHTML(data.status) + '</h2>';
  html += '<div style="font-size:12px;color:var(--fg-muted)">Version ' + data.version + ' | Created ' + fmtDateTime(data.created_at) + ' | Updated ' + fmtDateTime(data.updated_at) + '</div>';
  html += '<div style="margin-top:8px" id="sop-tags">' + tagsHTML(data.tags, true, id) + '</div>';
  html += '<div style="margin-top:8px"><input class="input" style="width:200px;display:inline-block" id="new-tag-input" placeholder="Add tag..." onkeydown="if(event.key===\\\'Enter\\\')addTag(\\'' + id + '\\')">' +
    ' <button class="btn btn-sm" onclick="addTag(\\'' + id + '\\')">+</button></div>';
  html += '</div>';
  if (data.metrics?.execution_count > 0) {
    html += '<div style="text-align:center">' + qualityRing(q, 80) +
      '<div style="font-size:11px;color:var(--fg-muted);margin-top:4px">Quality</div></div>';
  }
  html += '</div>';

  // Tabs
  html += '<div class="tabs">';
  html += '<div class="tab active" onclick="showSOPTab(\\\'content\\\',this)">Content</div>';
  html += '<div class="tab" onclick="showSOPTab(\\\'metrics\\\',this)">Metrics</div>';
  html += '<div class="tab" onclick="showSOPTab(\\\'versions\\\',this)">Versions (' + (data.versions?.length || 0) + ')</div>';
  html += '<div class="tab" onclick="showSOPTab(\\\'diff\\\',this)">Diff</div>';
  html += '<div class="tab" onclick="showSOPTab(\\\'preview\\\',this)">Export Preview</div>';
  html += '</div>';

  // Tab: Content
  html += '<div id="tab-content" class="card"><div class="md-content">' + renderMD(data.content_md) + '</div></div>';

  // Tab: Metrics
  html += '<div id="tab-metrics" class="card" style="display:none">';
  if (data.metrics?.execution_count > 0) {
    const m = data.metrics;
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px">';
    html += metricCard('Executions', m.execution_count, '');
    html += metricCard('Avg. Duration', fmtDur(m.avg_duration_seconds), '');
    html += metricCard('Min. Duration', fmtDur(m.min_duration_seconds), '');
    html += metricCard('Max. Duration', fmtDur(m.max_duration_seconds), '');
    html += metricCard('Complexity', m.avg_complexity ? m.avg_complexity.toFixed(1) + '/5' : '-', '');
    html += '</div>';
    html += '<div style="margin-top:16px">';
    html += scoreRow('Consistency', m.consistency_score);
    html += scoreRow('Maturity', m.maturity_score);
    html += scoreRow('Freshness', m.freshness_score);
    html += scoreRow('Overall', m.overall_quality_score);
    html += '</div>';
  } else {
    html += '<div class="empty-state"><p>No execution data available yet</p></div>';
  }
  html += '</div>';

  // Tab: Versions
  html += '<div id="tab-versions" style="display:none">';
  if (data.versions?.length > 0) {
    html += '<div class="card" style="padding:0"><table><thead><tr><th>Version</th><th>Title</th><th>Changed</th><th>Summary</th></tr></thead><tbody>';
    data.versions.forEach(function(v) {
      html += '<tr><td>v' + v.version + '</td><td>' + esc(v.title) + '</td><td>' + fmtDateTime(v.changed_at) + '</td><td>' + esc(v.change_summary || '-') + '</td></tr>';
    });
    html += '</tbody></table></div>';
  } else {
    html += '<div class="card empty-state"><p>No previous versions</p></div>';
  }
  html += '</div>';

  // Tab: Diff
  html += '<div id="tab-diff" style="display:none"><div class="card" id="diff-content"><div class="loading-center"><div class="spinner"></div></div></div></div>';

  // Tab: Preview
  html += '<div id="tab-preview" style="display:none"><div class="card" id="preview-content"><div class="loading-center"><div class="spinner"></div></div></div></div>';

  document.getElementById('content').innerHTML = html;
}

function statusActions(id, status) {
  let html = '';
  if (status === 'draft') html += '<button class="btn btn-success btn-sm" onclick="changeSOPStatus(\\'' + id + '\\',\\\'reviewed\\\')">Mark as Reviewed</button>';
  if (status === 'reviewed') html += '<button class="btn btn-success btn-sm" onclick="changeSOPStatus(\\'' + id + '\\',\\\'approved\\\')">Approve</button>';
  if (status === 'approved') html += '<button class="btn btn-primary btn-sm" onclick="exportSingleSOP(\\'' + id + '\\')">Export</button>';
  return html;
}

function showSOPTab(tab, el) {
  ['content','metrics','versions','diff','preview'].forEach(function(t) {
    const panel = document.getElementById('tab-' + t);
    if (panel) panel.style.display = t === tab ? '' : 'none';
  });
  el.parentElement.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  el.classList.add('active');

  if (tab === 'diff' && currentSOPId) loadDiff(currentSOPId);
  if (tab === 'preview' && currentSOPId) loadPreview(currentSOPId);
}

async function loadDiff(id) {
  const diff = await API.get('/api/sops/' + id + '/diff');
  const el = document.getElementById('diff-content');
  if (!diff.lines || diff.lines.length === 0) {
    el.innerHTML = '<div class="empty-state"><p>No diff available (first version)</p></div>';
    return;
  }
  let html = '<div style="font-size:12px;color:var(--fg-muted);margin-bottom:8px">v' + diff.fromVersion + ' &rarr; v' + diff.toVersion +
    ' | <span style="color:var(--green)">+' + diff.addedCount + '</span> <span style="color:var(--red)">-' + diff.removedCount + '</span></div>';
  diff.lines.forEach(function(line) {
    const cls = line.type === 'added' ? 'diff-add' : line.type === 'removed' ? 'diff-remove' : 'diff-context';
    const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
    html += '<div class="diff-line ' + cls + '">' + prefix + ' ' + esc(line.content) + '</div>';
  });
  el.innerHTML = html;
}

async function loadPreview(id) {
  const preview = await API.get('/api/sops/' + id + '/preview');
  const el = document.getElementById('preview-content');
  el.innerHTML = '<div style="font-size:12px;color:var(--fg-muted);margin-bottom:12px">Anonymized preview for export:</div>' +
    '<h3 style="margin-bottom:8px">' + esc(preview.title) + '</h3>' +
    '<div class="md-content">' + renderMD(preview.content_md) + '</div>';
}

function metricCard(label, value, suffix) {
  return '<div style="background:var(--bg-3);border-radius:var(--radius-sm);padding:12px;text-align:center">' +
    '<div style="font-size:18px;font-weight:700">' + value + suffix + '</div>' +
    '<div style="font-size:11px;color:var(--fg-muted)">' + label + '</div></div>';
}

function scoreRow(label, score) {
  return '<div style="display:flex;align-items:center;gap:12px;margin:8px 0">' +
    '<span style="width:90px;font-size:13px">' + label + '</span>' +
    '<div style="flex:1"><div class="quality-bar"><div class="quality-fill ' + qClass(score) + '" style="width:' + score + '%"></div></div></div>' +
    '<span style="width:40px;text-align:right;font-size:13px;font-weight:600;color:' + qColor(score) + '">' + Math.round(score) + '</span></div>';
}

async function changeSOPStatus(id, status) {
  await API.put('/api/sops/' + id + '/status', { status: status });
  toast('Status changed: ' + status, 'success');
  navigate('sop-detail', id);
}

async function addTag(id) {
  const input = document.getElementById('new-tag-input');
  const tag = input.value.trim().toLowerCase().replace(/^#/, '');
  if (!tag) return;
  await API.put('/api/sops/' + id + '/tags', { add: [tag] });
  input.value = '';
  toast('Tag added: #' + tag, 'success');
  navigate('sop-detail', id);
}

async function removeTag(id, tag) {
  await API.put('/api/sops/' + id + '/tags', { remove: [tag] });
  toast('Tag removed: #' + tag, 'info');
  navigate('sop-detail', id);
}

async function exportSingleSOP(id) {
  const result = await API.post('/api/exports', { sop_ids: [id] });
  toast('Export created: ' + result.export_path, 'success');
}

/* ═══════════════════════════════════════════════════════════════════════════
   Page: SOP Editor
   ═══════════════════════════════════════════════════════════════════════════ */
async function renderSOPEditor(id) {
  document.getElementById('page-title').textContent = 'Edit SOP';
  document.getElementById('topbar-actions').innerHTML =
    '<button class="btn" onclick="navigate(\\\'sop-detail\\\',\\'' + id + '\\')">Cancel</button>' +
    '<button class="btn btn-primary" onclick="saveSOPEdit(\\'' + id + '\\')">Save</button>';

  const data = await API.get('/api/sops/' + id);

  let html = '<div class="split-pane">';
  html += '<div class="split-left"><textarea class="textarea" id="editor-textarea" oninput="updateEditorPreview()">' + esc(data.content_md) + '</textarea></div>';
  html += '<div class="split-right"><div class="md-content" id="editor-preview">' + renderMD(data.content_md) + '</div></div>';
  html += '</div>';

  document.getElementById('content').innerHTML = html;
}

function updateEditorPreview() {
  const text = document.getElementById('editor-textarea').value;
  document.getElementById('editor-preview').innerHTML = renderMD(text);
}

async function saveSOPEdit(id) {
  const content = document.getElementById('editor-textarea').value;
  await API.put('/api/sops/' + id, { content_md: content });
  toast('SOP saved', 'success');
  navigate('sop-detail', id);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Page: Export
   ═══════════════════════════════════════════════════════════════════════════ */
let exportSelection = new Set();

async function renderExport() {
  document.getElementById('page-title').textContent = 'Export';

  const [sops, exports] = await Promise.all([
    API.get('/api/sops?status=approved'),
    API.get('/api/exports')
  ]);

  let html = '';

  // Export Selection
  html += '<div class="card" style="margin-bottom:16px"><div class="card-header"><span class="card-title">Select SOPs for Export</span>';
  html += '<button class="btn btn-primary btn-sm" onclick="triggerExport()" id="export-btn" disabled>Export (0)</button></div>';

  if (sops.length === 0) {
    html += '<div class="empty-state"><p>No approved SOPs available. SOPs must have the status "approved" first.</p></div>';
  } else {
    html += '<div style="margin-bottom:8px"><label class="checkbox"><input type="checkbox" onchange="toggleAllExport(this.checked)"> Select all</label></div>';
    sops.forEach(function(s) {
      html += '<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border)">';
      html += '<label class="checkbox"><input type="checkbox" data-sop-id="' + s.id + '" onchange="updateExportSelection()"></label>';
      html += '<div style="flex:1"><span style="font-weight:500">' + esc(s.title) + '</span>';
      html += '<div style="font-size:12px;color:var(--fg-muted)">' + tagsHTML(s.tags) + ' | v' + s.version + '</div></div>';
      html += '<button class="btn btn-sm btn-ghost" onclick="previewExportSOP(\\'' + s.id + '\\')">Preview</button>';
      html += '</div>';
    });
  }
  html += '</div>';

  // Export Preview Panel
  html += '<div class="card" id="export-preview-panel" style="display:none;margin-bottom:16px">';
  html += '<div class="card-header"><span class="card-title">Anonymized Preview</span>';
  html += '<button class="btn btn-sm btn-ghost" onclick="document.getElementById(\\\'export-preview-panel\\\').style.display=\\\'none\\\'">&times; Close</button></div>';
  html += '<div id="export-preview-content"></div></div>';

  // Export History
  html += '<div class="card"><div class="card-header"><span class="card-title">Export History</span></div>';
  if (exports.length === 0) {
    html += '<div style="color:var(--fg-muted);font-size:13px">No exports performed yet</div>';
  } else {
    html += '<table><thead><tr><th>Date</th><th>SOPs</th><th>Path</th><th>Anonymized</th></tr></thead><tbody>';
    exports.forEach(function(e) {
      html += '<tr><td>' + fmtDateTime(e.exported_at) + '</td><td>' + e.sop_count + '</td><td style="font-family:var(--font-mono);font-size:12px">' + esc(e.export_path) + '</td><td>' + (e.anonymized ? 'Yes' : 'No') + '</td></tr>';
    });
    html += '</tbody></table>';
  }
  html += '</div>';

  document.getElementById('content').innerHTML = html;
  exportSelection.clear();
}

function toggleAllExport(checked) {
  document.querySelectorAll('[data-sop-id]').forEach(function(cb) { cb.checked = checked; });
  updateExportSelection();
}

function updateExportSelection() {
  exportSelection.clear();
  document.querySelectorAll('[data-sop-id]:checked').forEach(function(cb) {
    exportSelection.add(cb.dataset.sopId);
  });
  const btn = document.getElementById('export-btn');
  if (btn) {
    btn.disabled = exportSelection.size === 0;
    btn.textContent = 'Export (' + exportSelection.size + ')';
  }
}

async function triggerExport() {
  if (exportSelection.size === 0) return;
  const ids = Array.from(exportSelection);
  const result = await API.post('/api/exports', { sop_ids: ids });
  toast('Export created: ' + result.sop_count + ' SOPs to ' + result.export_path, 'success');
  renderExport();
}

async function previewExportSOP(id) {
  const preview = await API.get('/api/sops/' + id + '/preview');
  const panel = document.getElementById('export-preview-panel');
  panel.style.display = '';
  document.getElementById('export-preview-content').innerHTML =
    '<h3 style="margin-bottom:8px">' + esc(preview.title) + '</h3>' +
    '<div class="md-content">' + renderMD(preview.content_md) + '</div>';
  panel.scrollIntoView({ behavior: 'smooth' });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Page: Timeline
   ═══════════════════════════════════════════════════════════════════════════ */
async function renderTimeline() {
  document.getElementById('page-title').textContent = 'Timeline';

  const sessions = await API.get('/api/sessions');

  let html = '';

  if (sessions.length === 0) {
    html += '<div class="card empty-state"><p>No observation sessions available.<br>Start one with <code>shadowing observe</code></p></div>';
    document.getElementById('content').innerHTML = html;
    return;
  }

  // Session List
  html += '<div class="card" style="margin-bottom:16px"><div class="card-header"><span class="card-title">Sessions</span></div>';
  html += '<table><thead><tr><th>Status</th><th>Title</th><th>Start</th><th>Actions</th><th></th></tr></thead><tbody>';
  sessions.forEach(function(s) {
    html += '<tr><td>' + badgeHTML(s.status) + '</td><td>' + esc(s.title || 'Session ' + s.id.substring(0,8)) + '</td><td>' + fmtDateTime(s.started_at) + '</td><td>' + s.total_actions + '</td>' +
      '<td><button class="btn btn-sm" onclick="loadSessionTimeline(\\'' + s.id + '\\')">View</button></td></tr>';
  });
  html += '</tbody></table></div>';

  // Timeline Content
  html += '<div id="session-timeline"></div>';

  document.getElementById('content').innerHTML = html;
}

async function loadSessionTimeline(sessionId) {
  const el = document.getElementById('session-timeline');
  el.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';

  const [timeline, summary] = await Promise.all([
    API.get('/api/sessions/' + sessionId + '/timeline?limit=200'),
    API.get('/api/sessions/' + sessionId + '/summary')
  ]);

  let html = '';

  // Summary
  html += '<div class="card" style="margin-bottom:16px"><div class="card-header"><span class="card-title">Session Overview</span></div>';
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px">';
  if (summary && typeof summary === 'object') {
    Object.entries(summary).forEach(function(entry) {
      const key = entry[0];
      const val = entry[1];
      html += '<div style="text-align:center;padding:8px"><div style="font-size:20px;font-weight:700">' + (typeof val === 'number' ? val : Object.keys(val).length) + '</div><div style="font-size:11px;color:var(--fg-muted)">' + esc(key) + '</div></div>';
    });
  }
  html += '</div></div>';

  // Source filter
  html += '<div class="filter-bar">';
  html += '<div class="btn-group">';
  ['All','window','shell','git','file','manual'].forEach(function(src) {
    html += '<button class="btn btn-sm' + (src === 'All' ? ' active' : '') + '" onclick="filterTimeline(\\'' + sessionId + '\\',\\'' + (src === 'All' ? '' : src) + '\\',this)">' + src + '</button>';
  });
  html += '</div></div>';

  // Timeline
  html += '<div class="card" id="timeline-list">';
  html += renderTimelineItems(timeline);
  html += '</div>';

  el.innerHTML = html;
}

function renderTimelineItems(items) {
  if (items.length === 0) return '<div class="empty-state"><p>No actions in this session</p></div>';
  return items.map(function(a) {
    const title = a.app_name || a.command || a.file_path || a.window_title || '(unknown)';
    const detail = a.window_title && a.app_name ? a.window_title : (a.command || a.file_path || '');
    return '<div class="timeline-item">' +
      '<div class="timeline-dot ' + (a.source || '') + '"></div>' +
      '<div class="timeline-content">' +
      '<div style="font-weight:500;font-size:13px">' + esc(title) + '</div>' +
      (detail && detail !== title ? '<div style="font-size:12px;color:var(--fg-muted)">' + esc(detail.substring(0, 120)) + '</div>' : '') +
      '<div style="font-size:11px;color:var(--fg-subtle)">' + esc(a.source) + ' | ' + fmtDur(a.duration_seconds) + '</div>' +
      '</div>' +
      '<div class="timeline-time">' + fmtTime(a.started_at) + '</div></div>';
  }).join('');
}

async function filterTimeline(sessionId, source, btn) {
  btn.parentElement.querySelectorAll('.btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  const url = '/api/sessions/' + sessionId + '/timeline?limit=200' + (source ? '&source=' + source : '');
  const items = await API.get(url);
  document.getElementById('timeline-list').innerHTML = renderTimelineItems(items);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Init
   ═══════════════════════════════════════════════════════════════════════════ */
navigate('dashboard');
</script>
</body>
</html>`;
}
