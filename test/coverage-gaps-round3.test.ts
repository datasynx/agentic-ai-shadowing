import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { ShadowingDB } from '../src/db.js';
import { getDefaultConfig } from '../src/config.js';
import { createUIServer } from '../src/ui-server.js';
import { getHistoryFilePath } from '../src/shell-history.js';
import { matchesPattern, isWithinWorkHours } from '../src/observer.js';

const TEST_AUTH_TOKEN = 'test-coverage-token';
const authHeaders: Record<string, string> = { 'Authorization': `Bearer ${TEST_AUTH_TOKEN}`, 'Content-Type': 'application/json' };

// ── UI Server: untested routes ────────────────────────────────────────────────

describe('UI Server — Additional Routes', () => {
  let db: ShadowingDB;
  let server: Server;
  let baseUrl: string;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shadow-ui-gaps-'));
    db = new ShadowingDB(join(tmpDir, 'test.db'));
    db.initialize();
    const config = getDefaultConfig();
    server = createUIServer(db, config, { authToken: TEST_AUTH_TOKEN });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createSOP(title = 'Test SOP', content = '# Test') {
    const active = db.getActiveTask();
    if (active) db.completeTask(active.id);
    const task = db.createTask('Task');
    const sop = db.createSOP(task.id, { title, content_md: content });
    return sop;
  }

  // PUT /api/sops/:id
  it('PUT /api/sops/:id updates SOP content', async () => {
    const sop = createSOP();
    const res = await fetch(`${baseUrl}/api/sops/${sop.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ content_md: '# Updated Content', title: 'New Title' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { title: string; version: number; content_md: string };
    expect(data.title).toBe('New Title');
    expect(data.content_md).toBe('# Updated Content');
    expect(data.version).toBe(2); // content changed → version bumped
  });

  it('PUT /api/sops/:id updates only title without version bump', async () => {
    const sop = createSOP();
    const res = await fetch(`${baseUrl}/api/sops/${sop.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ title: 'Only Title Update' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { title: string; version: number };
    expect(data.title).toBe('Only Title Update');
    expect(data.version).toBe(1);
  });

  // PUT /api/sops/:id/tags
  it('PUT /api/sops/:id/tags adds tags', async () => {
    const sop = createSOP();
    const res = await fetch(`${baseUrl}/api/sops/${sop.id}/tags`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ add: ['deploy', 'production'] }),
    });
    expect(res.status).toBe(200);
    const tags = await res.json() as string[];
    expect(tags).toContain('deploy');
    expect(tags).toContain('production');
  });

  it('PUT /api/sops/:id/tags removes tags', async () => {
    const sop = createSOP();
    db.addTagToSOP(sop.id, 'remove-me');
    db.addTagToSOP(sop.id, 'keep-me');

    const res = await fetch(`${baseUrl}/api/sops/${sop.id}/tags`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ remove: ['remove-me'] }),
    });
    expect(res.status).toBe(200);
    const tags = await res.json() as string[];
    expect(tags).not.toContain('remove-me');
    expect(tags).toContain('keep-me');
  });

  it('PUT /api/sops/:id/tags handles add and remove simultaneously', async () => {
    const sop = createSOP();
    db.addTagToSOP(sop.id, 'old-tag');

    const res = await fetch(`${baseUrl}/api/sops/${sop.id}/tags`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ add: ['new-tag'], remove: ['old-tag'] }),
    });
    expect(res.status).toBe(200);
    const tags = await res.json() as string[];
    expect(tags).toContain('new-tag');
    expect(tags).not.toContain('old-tag');
  });

  // GET /api/sops/:id/preview
  it('GET /api/sops/:id/preview returns anonymized content', async () => {
    const sop = createSOP('Contact john@company.com', '# SOP\nEmail: john@company.com at 192.168.1.1');

    const res = await fetch(`${baseUrl}/api/sops/${sop.id}/preview`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const data = await res.json() as { title: string; content_md: string };
    expect(data.title).toContain('[email@example.com]');
    expect(data.title).not.toContain('john@company.com');
    expect(data.content_md).toContain('[email@example.com]');
    expect(data.content_md).toContain('[internal-ip]');
  });

  it('GET /api/sops/:id/preview returns 404 for unknown SOP', async () => {
    const res = await fetch(`${baseUrl}/api/sops/deadbeef/preview`, { headers: authHeaders });
    expect(res.status).toBe(404);
  });

  // POST /api/exports
  it('POST /api/exports triggers export', async () => {
    const sop = createSOP('Export SOP', '# Export\n## Objective\nTest export.');

    const res = await fetch(`${baseUrl}/api/exports`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ sop_ids: [sop.id] }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { sop_count: number; export_path: string };
    expect(data.sop_count).toBe(1);
    expect(data.export_path).toBeTruthy();
  });

  it('POST /api/exports returns error for empty array', async () => {
    const res = await fetch(`${baseUrl}/api/exports`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ sop_ids: [] }),
    });
    expect(res.status).toBe(422); // Validation rejects empty sop_ids
  });

  // GET /api/sessions/:id/timeline
  it('GET /api/sessions/:id/timeline returns actions', async () => {
    const session = db.startObservationSession('Timeline test');
    db.logObservedAction(session.id, { source: 'shell', command: 'ls' });
    db.logObservedAction(session.id, { source: 'window', app_name: 'VS Code' });

    const res = await fetch(`${baseUrl}/api/sessions/${session.id}/timeline`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const data = await res.json() as unknown[];
    expect(data).toHaveLength(2);
  });

  it('GET /api/sessions/:id/timeline respects source filter', async () => {
    const session = db.startObservationSession('Filter test');
    db.logObservedAction(session.id, { source: 'shell', command: 'ls' });
    db.logObservedAction(session.id, { source: 'window', app_name: 'Chrome' });

    const res = await fetch(`${baseUrl}/api/sessions/${session.id}/timeline?source=shell`, { headers: authHeaders });
    const data = await res.json() as { source: string }[];
    expect(data).toHaveLength(1);
    expect(data[0]!.source).toBe('shell');
  });

  // GET /api/sessions/:id/summary
  it('GET /api/sessions/:id/summary returns action summary', async () => {
    const session = db.startObservationSession('Summary test');
    db.logObservedAction(session.id, { source: 'shell', command: 'ls', duration_seconds: 10 });
    db.logObservedAction(session.id, { source: 'shell', command: 'pwd', duration_seconds: 5 });
    db.logObservedAction(session.id, { source: 'window', app_name: 'Chrome', duration_seconds: 30 });

    const res = await fetch(`${baseUrl}/api/sessions/${session.id}/summary`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const data = await res.json() as { source: string; count: number; total_seconds: number }[];
    expect(data.length).toBeGreaterThanOrEqual(2);
    const shell = data.find(d => d.source === 'shell');
    expect(shell!.count).toBe(2);
    expect(shell!.total_seconds).toBe(15);
  });

  // CORS OPTIONS — no Origin header means no CORS headers (secure default, see #19)
  it('OPTIONS returns 204 without wildcard CORS headers', async () => {
    const res = await fetch(`${baseUrl}/api/stats`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  // SOP search filters via query params
  it('GET /api/sops?status=reviewed filters by status', async () => {
    const sop1 = createSOP('Draft SOP');
    const sop2 = createSOP('Reviewed SOP');
    db.updateSOPStatus(sop2.id, 'reviewed');

    const res = await fetch(`${baseUrl}/api/sops?status=reviewed`, { headers: authHeaders });
    const data = await res.json() as { id: string }[];
    expect(data).toHaveLength(1);
    expect(data[0]!.id).toBe(sop2.id);
  });

  it('GET /api/sops?search=keyword searches content', async () => {
    createSOP('Deploy Guide', '# Deploy\nkubectl apply');
    createSOP('Other SOP', '# Other\nSomething else');

    const res = await fetch(`${baseUrl}/api/sops?search=kubectl`, { headers: authHeaders });
    const data = await res.json() as { title: string }[];
    expect(data).toHaveLength(1);
    expect(data[0]!.title).toBe('Deploy Guide');
  });

  it('GET /api/sessions returns session list', async () => {
    db.startObservationSession('Test Session');

    const res = await fetch(`${baseUrl}/api/sessions`, { headers: authHeaders });
    const data = await res.json() as unknown[];
    expect(data).toHaveLength(1);
  });
});

// ── Shell History: getHistoryFilePath ────────────────────────────────────────

describe('getHistoryFilePath', () => {
  it('returns null for unknown shell type', () => {
    expect(getHistoryFilePath('unknown')).toBeNull();
  });

  it('returns a path or null for zsh (depends on system)', () => {
    const result = getHistoryFilePath('zsh');
    // On CI without zsh history, this may be null
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('returns null when HOME is not set', () => {
    const origHome = process.env['HOME'];
    const origUserProfile = process.env['USERPROFILE'];
    delete process.env['HOME'];
    delete process.env['USERPROFILE'];
    try {
      expect(getHistoryFilePath('bash')).toBeNull();
    } finally {
      process.env['HOME'] = origHome;
      if (origUserProfile) process.env['USERPROFILE'] = origUserProfile;
    }
  });

  it('respects HISTFILE env var for zsh', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'shadow-hist-'));
    const histFile = join(tmpDir, 'custom_history');
    writeFileSync(histFile, '');
    const origHistFile = process.env['HISTFILE'];
    process.env['HISTFILE'] = histFile;
    try {
      expect(getHistoryFilePath('zsh')).toBe(histFile);
    } finally {
      if (origHistFile) {
        process.env['HISTFILE'] = origHistFile;
      } else {
        delete process.env['HISTFILE'];
      }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('respects HISTFILE env var for bash', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'shadow-hist-'));
    const histFile = join(tmpDir, 'custom_bash_history');
    writeFileSync(histFile, '');
    const origHistFile = process.env['HISTFILE'];
    process.env['HISTFILE'] = histFile;
    try {
      expect(getHistoryFilePath('bash')).toBe(histFile);
    } finally {
      if (origHistFile) {
        process.env['HISTFILE'] = origHistFile;
      } else {
        delete process.env['HISTFILE'];
      }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Observer: matchesPattern edge cases ─────────────────────────────────────

describe('matchesPattern edge cases', () => {
  // Note: matchesPattern(pattern, value) — pattern first, value second
  // Uses regex full-match with * → .* and ? → . glob conversion

  it('handles patterns with regex special characters via escaping', () => {
    // Regex special chars are escaped, so literal match
    expect(matchesPattern('file (copy).txt', 'file (copy).txt')).toBe(true);
    expect(matchesPattern('a+b', 'a+b')).toBe(true);
  });

  it('glob wildcards work', () => {
    expect(matchesPattern('*.txt', 'file.txt')).toBe(true);
    expect(matchesPattern('*.txt', 'file.md')).toBe(false);
    expect(matchesPattern('test?', 'test1')).toBe(true);
    expect(matchesPattern('test?', 'test12')).toBe(false);
  });

  it('empty pattern matches only empty value', () => {
    expect(matchesPattern('', '')).toBe(true);
    expect(matchesPattern('', 'anything')).toBe(false);
  });

  it('case-insensitive matching', () => {
    expect(matchesPattern('vs code', 'VS Code')).toBe(true);
    expect(matchesPattern('CHROME', 'chrome')).toBe(true);
  });
});

describe('isWithinWorkHours edge cases', () => {
  // isWithinWorkHours checks hour >= start && hour < end
  // It takes a full ObserverConfig but only uses work_hours_start/end

  it('returns boolean based on current hour', () => {
    const hour = new Date().getHours();
    // Config that includes the current hour
    const includesNow = isWithinWorkHours({
      poll_interval_ms: 5000,
      watch_git: true,
      watch_files: true,
      capture_shell_history: true,
      work_hours_only: true,
      work_hours_start: 0,
      work_hours_end: 24,
    });
    expect(includesNow).toBe(true);
  });

  it('returns false when outside range', () => {
    // Use a range that excludes 0-23 by making start > end or picking impossible range
    const hour = new Date().getHours();
    const result = isWithinWorkHours({
      poll_interval_ms: 5000,
      watch_git: true,
      watch_files: true,
      capture_shell_history: true,
      work_hours_only: true,
      work_hours_start: (hour + 1) % 24,
      work_hours_end: (hour + 1) % 24, // start === end → always false
    });
    expect(result).toBe(false);
  });

  it('handles start equal to end (empty range)', () => {
    const result = isWithinWorkHours({
      poll_interval_ms: 5000,
      watch_git: true,
      watch_files: true,
      capture_shell_history: true,
      work_hours_only: true,
      work_hours_start: 12,
      work_hours_end: 12,
    });
    // hour >= 12 && hour < 12 → always false
    expect(result).toBe(false);
  });
});
