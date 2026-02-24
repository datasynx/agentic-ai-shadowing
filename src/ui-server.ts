import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ShadowingDB } from './db.js';
import type { ShadowingConfig, SOPStatus } from './types.js';
import { calculateSOPMetrics } from './metrics.js';
import { formatDuration } from './task-manager.js';
import { diffTexts } from './diff.js';
import { Anonymizer } from './anonymizer.js';
import { Exporter } from './exporter.js';
import { getDashboardHTML } from './dashboard-html.js';

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
          status: status as SOPStatus | undefined,
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
      } else if (path.match(/^\/api\/sops\/[a-f0-9]+$/) && req.method === 'PUT') {
        // Update SOP content (for in-browser editing)
        const id = path.split('/').pop()!;
        const body = await readBody(req);
        const data = JSON.parse(body) as { content_md?: string; title?: string; description?: string };
        const sop = db.updateSOP(id, data);
        json(res, sop);
      } else if (path.match(/^\/api\/sops\/[a-f0-9]+\/status$/) && req.method === 'PUT') {
        const id = path.split('/')[3]!;
        const body = await readBody(req);
        const { status } = JSON.parse(body) as { status: string };
        const sop = db.updateSOPStatus(id, status as SOPStatus);
        json(res, sop);
      } else if (path.match(/^\/api\/sops\/[a-f0-9]+\/tags$/) && req.method === 'PUT') {
        const id = path.split('/')[3]!;
        const body = await readBody(req);
        const { add, remove } = JSON.parse(body) as { add?: string[]; remove?: string[] };
        if (add) for (const tag of add) db.addTagToSOP(id, tag, false);
        if (remove) {
          const sopTags = db.getTagsForSOP(id);
          for (const name of remove) {
            const match = sopTags.find(t => t.name.toLowerCase() === name.toLowerCase());
            if (match) db.removeTagFromSOP(id, match.id);
          }
        }
        json(res, db.getTagsForSOP(id).map(t => t.name));
      } else if (path.match(/^\/api\/sops\/[a-f0-9]+\/diff$/) && req.method === 'GET') {
        const id = path.split('/')[3]!;
        const sop = db.getSOP(id);
        if (!sop) { notFound(res); return; }
        const versions = db.getSOPVersions(id);
        if (versions.length === 0) { json(res, { lines: [], addedCount: 0, removedCount: 0 }); return; }
        const prev = versions[0]!;
        json(res, { ...diffTexts(prev.content_md, sop.content_md), fromVersion: prev.version, toVersion: sop.version });
      } else if (path.match(/^\/api\/sops\/[a-f0-9]+\/preview$/) && req.method === 'GET') {
        // Anonymized preview for export
        const id = path.split('/')[3]!;
        const sop = db.getSOP(id);
        if (!sop) { notFound(res); return; }
        const anonymizer = new Anonymizer(config.anonymization);
        json(res, {
          title: anonymizer.anonymize(sop.title),
          content_md: anonymizer.anonymize(sop.content_md),
        });
      } else if (path === '/api/tags' && req.method === 'GET') {
        json(res, db.listTags());
      } else if (path === '/api/exports' && req.method === 'GET') {
        json(res, db.getExports());
      } else if (path === '/api/exports' && req.method === 'POST') {
        // Trigger export from dashboard
        const body = await readBody(req);
        const { sop_ids } = JSON.parse(body) as { sop_ids: string[] };
        const anonymizer = new Anonymizer(config.anonymization);
        const exporter = new Exporter(db, anonymizer, config);
        const result = exporter.exportSOPs(sop_ids);
        json(res, result);
      } else if (path === '/api/sessions' && req.method === 'GET') {
        json(res, db.listObservationSessions());
      } else if (path.match(/^\/api\/sessions\/[a-f0-9]+\/timeline$/) && req.method === 'GET') {
        const id = path.split('/')[3]!;
        const source = url.searchParams.get('source') ?? undefined;
        const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);
        json(res, db.getObservedActions(id, { source: source as 'window' | 'shell' | 'git' | 'file' | 'manual' | undefined, limit }));
      } else if (path.match(/^\/api\/sessions\/[a-f0-9]+\/summary$/) && req.method === 'GET') {
        const id = path.split('/')[3]!;
        json(res, db.getActionSummary(id));
      } else if (path === '/' || path === '/index.html') {
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

// Dashboard HTML is imported from dashboard-html.ts
