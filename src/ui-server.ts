import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ShadowingDB } from './db.js';
import type { ShadowingConfig, SOPStatus, TaskStatus } from './types.js';
import { ShadowingError } from './errors.js';
import { calculateSOPMetrics } from './metrics.js';
import { diffTexts } from './diff.js';
import { Anonymizer } from './anonymizer.js';
import { Exporter } from './exporter.js';
import { getDashboardHTML } from './dashboard-html.js';
import { getLogger } from './logger.js';

const log = getLogger('ui-server');

// ── Request Body Schemas ──────────────────────────────────────────────────────

const UpdateSOPSchema = z.object({
  content_md: z.string().min(1).max(500_000).optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10_000).optional(),
}).refine(data => data.content_md !== undefined || data.title !== undefined || data.description !== undefined, {
  message: 'At least one field (content_md, title, description) must be provided',
});

const UpdateSOPStatusSchema = z.object({
  status: z.enum(['draft', 'reviewed', 'approved', 'exported', 'archived']),
});

const UpdateSOPTagsSchema = z.object({
  add: z.array(z.string().min(1)).optional(),
  remove: z.array(z.string().min(1)).optional(),
}).refine(data => (data.add && data.add.length > 0) || (data.remove && data.remove.length > 0), {
  message: 'At least one of add or remove must be provided with entries',
});

const ExportSOPsSchema = z.object({
  sop_ids: z.array(z.string().min(1)).min(1, 'At least one SOP ID is required'),
});

// Query parameter validation
const VALID_TASK_STATUSES = new Set<string>(['active', 'paused', 'completed', 'cancelled']);
const VALID_SOP_STATUSES = new Set<string>(['draft', 'reviewed', 'approved', 'exported', 'archived']);
const MAX_SEARCH_LENGTH = 200;

// ── Rate Limiter ──────────────────────────────────────────────────────────────

interface RateLimitEntry { count: number; resetAt: number }

class RateLimiter {
  private entries = new Map<string, RateLimitEntry>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private readLimit: number = 100,
    private writeLimit: number = 20,
    private windowMs: number = 60_000,
  ) {
    this.cleanupTimer = setInterval(() => this.cleanup(), this.windowMs);
    this.cleanupTimer.unref();
  }

  check(ip: string, isWrite: boolean): { allowed: boolean; retryAfter?: number } {
    const key = `${ip}:${isWrite ? 'w' : 'r'}`;
    const now = Date.now();
    const limit = isWrite ? this.writeLimit : this.readLimit;

    let entry = this.entries.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.entries.set(key, entry);
    }

    entry.count++;
    if (entry.count > limit) {
      return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    }
    return { allowed: true };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.resetAt) this.entries.delete(key);
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
  }
}

// ── REST API Router ──────────────────────────────────────────────────────────

export interface UIServerOptions {
  authToken?: string;
  readRateLimit?: number;
  writeRateLimit?: number;
}

export function createUIServer(db: ShadowingDB, config: ShadowingConfig, opts?: UIServerOptions) {
  // Auth token: from options, env, or auto-generated
  const authToken = opts?.authToken
    ?? process.env['SHADOWING_UI_TOKEN']
    ?? randomBytes(32).toString('hex');

  const rateLimiter = new RateLimiter(
    opts?.readRateLimit ?? 100,
    opts?.writeRateLimit ?? 20,
  );

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const path = url.pathname;
    const requestId = (req.headers['x-request-id'] as string) ?? randomUUID();

    // Set standard headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
    res.setHeader('X-Request-Id', requestId);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const isApiRoute = path.startsWith('/api/');
    const isWriteMethod = req.method === 'PUT' || req.method === 'POST' || req.method === 'DELETE';

    // Rate limiting for API routes
    if (isApiRoute) {
      const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
        ?? req.socket.remoteAddress ?? 'unknown';
      const rateResult = rateLimiter.check(clientIp, isWriteMethod);
      if (!rateResult.allowed) {
        log.warn('Rate limit exceeded', { ip: clientIp, request_id: requestId });
        res.setHeader('Retry-After', String(rateResult.retryAfter));
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded', status: 429 }));
        return;
      }
    }

    // Authentication for API routes
    if (isApiRoute) {
      const authHeader = req.headers['authorization'];
      if (!authHeader || authHeader !== `Bearer ${authToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized', status: 401 }));
        return;
      }
    }

    try {
      // ── API routes ────────────────────────────────────────────
      if (path === '/api/stats' && req.method === 'GET') {
        const stats = db.getGlobalStats();
        const apiUsage = db.getApiUsageSummary();
        json(res, { ...stats, api_usage_summary: apiUsage });
      } else if (path === '/api/tasks' && req.method === 'GET') {
        const status = url.searchParams.get('status') ?? undefined;
        if (status && !VALID_TASK_STATUSES.has(status)) {
          badRequest(res, `Invalid status filter: ${status}. Must be one of: ${[...VALID_TASK_STATUSES].join(', ')}`);
          return;
        }
        json(res, db.listTasks(status ? { status: status as TaskStatus } : undefined));
      } else if (path === '/api/tasks/active' && req.method === 'GET') {
        json(res, db.getActiveTask());
      } else if (path === '/api/sops' && req.method === 'GET') {
        const status = url.searchParams.get('status') ?? undefined;
        const tag = url.searchParams.get('tag') ?? undefined;
        let search = url.searchParams.get('search') ?? undefined;
        if (status && !VALID_SOP_STATUSES.has(status)) {
          badRequest(res, `Invalid status filter: ${status}. Must be one of: ${[...VALID_SOP_STATUSES].join(', ')}`);
          return;
        }
        if (search && search.length > MAX_SEARCH_LENGTH) {
          search = search.substring(0, MAX_SEARCH_LENGTH);
        }
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
        const auditHistory = db.getAuditLog('sop', id);
        json(res, { ...sop, tags, metrics, versions, audit_history: auditHistory });
      } else if (path.match(/^\/api\/sops\/[a-f0-9]+$/) && req.method === 'PUT') {
        const id = path.split('/').pop()!;
        const body = await readBody(req);
        const parsed = UpdateSOPSchema.safeParse(JSON.parse(body));
        if (!parsed.success) { zodError(res, parsed.error); return; }
        const oldSop = db.getSOP(id);
        if (!oldSop) { notFound(res); return; }
        const sop = db.updateSOP(id, parsed.data);
        db.logAudit({
          entity_type: 'sop', entity_id: id, action: 'update',
          old_value: JSON.stringify({ title: oldSop.title, version: oldSop.version }),
          new_value: JSON.stringify({ title: sop.title, version: sop.version }),
          source: 'api',
        });
        json(res, sop);
      } else if (path.match(/^\/api\/sops\/[a-f0-9]+\/status$/) && req.method === 'PUT') {
        const id = path.split('/')[3]!;
        const body = await readBody(req);
        const parsed = UpdateSOPStatusSchema.safeParse(JSON.parse(body));
        if (!parsed.success) { zodError(res, parsed.error); return; }
        const oldSop = db.getSOP(id);
        if (!oldSop) { notFound(res); return; }
        const sop = db.updateSOPStatus(id, parsed.data.status as SOPStatus);
        db.logAudit({
          entity_type: 'sop', entity_id: id, action: 'status_change',
          old_value: oldSop.status, new_value: parsed.data.status,
          source: 'api',
        });
        json(res, sop);
      } else if (path.match(/^\/api\/sops\/[a-f0-9]+\/tags$/) && req.method === 'PUT') {
        const id = path.split('/')[3]!;
        const body = await readBody(req);
        const parsed = UpdateSOPTagsSchema.safeParse(JSON.parse(body));
        if (!parsed.success) { zodError(res, parsed.error); return; }
        const { add, remove } = parsed.data;
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
        const body = await readBody(req);
        const parsed = ExportSOPsSchema.safeParse(JSON.parse(body));
        if (!parsed.success) { zodError(res, parsed.error); return; }
        const { sop_ids } = parsed.data;
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
        res.end(getDashboardHTML(config, authToken));
      } else {
        notFound(res);
      }
    } catch (err) {
      // Central error handler
      log.error('Request error', {
        request_id: requestId,
        path,
        method: req.method,
        error: err instanceof Error ? err.message : String(err),
      });

      if (err instanceof z.ZodError) {
        zodError(res, err);
        return;
      }

      if (err instanceof ShadowingError) {
        const status = err.httpStatus;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, code: err.code, status }));
        return;
      }

      // Never expose stack traces to clients
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error', status: 500 }));
    }
  });

  // Attach metadata for callers
  (server as ServerWithMeta).__authToken = authToken;
  (server as ServerWithMeta).__rateLimiter = rateLimiter;

  return server;
}

type ServerWithMeta = ReturnType<typeof createServer> & {
  __authToken?: string;
  __rateLimiter?: RateLimiter;
};

/** Get the auth token for a server created by createUIServer. */
export function getServerAuthToken(server: ReturnType<typeof createServer>): string | undefined {
  return (server as ServerWithMeta).__authToken;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(res: ServerResponse, data: unknown) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function notFound(res: ServerResponse) {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', status: 404 }));
}

function badRequest(res: ServerResponse, message: string) {
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message, status: 400 }));
}

function zodError(res: ServerResponse, err: z.ZodError) {
  res.writeHead(422, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: 'Validation error',
    code: 'validation_error',
    status: 422,
    issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
  }));
}

const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
