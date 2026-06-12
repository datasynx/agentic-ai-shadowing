import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  isLoopbackHost,
  RateLimiter,
  clientIpOf,
  timingSafeBearerEqual,
  readLimitedBody,
} from './http-security.js';
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

// ── Bind Host Guard ────────────────────────────────────────────────────────────

// Loopback check shared with the MCP server (src/http-security.ts); re-exported
// for callers that import it from here (bindRefusalReason, src/cli.ts).
export { isLoopbackHost } from './http-security.js';

/**
 * Refusal reason if binding `host` without a token is disallowed, else null.
 * Mirrors the MCP server's non-loopback guard (src/mcp-server.ts).
 */
export function bindRefusalReason(host: string, hasToken: boolean): string | null {
  if (isLoopbackHost(host) || hasToken) return null;
  return 'refusing to bind a non-loopback host without SHADOWING_UI_TOKEN set — ' +
    'exposure beyond localhost without authentication is unsupported';
}

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

// ── REST API Router ──────────────────────────────────────────────────────────

export interface UIServerOptions {
  authToken?: string;
  readRateLimit?: number;
  writeRateLimit?: number;
  /** Cross-origin origins allowed to call the API (overrides config.ui_allowed_origins). */
  allowedOrigins?: string[];
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

  // CORS policy: the dashboard is served same-origin, so by default no CORS
  // headers are emitted at all. Cross-origin callers must be explicitly
  // allowlisted (config.ui_allowed_origins); everything else gets 403 on
  // API routes. Requests without an Origin header (curl, same-origin GET
  // navigations) are unaffected.
  const allowedOrigins = opts?.allowedOrigins ?? config.ui_allowed_origins ?? [];

  function checkOrigin(req: IncomingMessage): { allowed: boolean; corsOrigin?: string } {
    const origin = req.headers['origin'];
    if (!origin) return { allowed: true };
    try {
      const originHost = new URL(origin).host;
      const requestHost = req.headers['host'];
      if (requestHost && originHost === requestHost) return { allowed: true }; // same-origin
    } catch {
      // Malformed Origin header — fall through to the allowlist check
    }
    if (allowedOrigins.includes(origin)) return { allowed: true, corsOrigin: origin };
    return { allowed: false };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const path = url.pathname;
    const requestId = (req.headers['x-request-id'] as string) ?? randomUUID();

    res.setHeader('X-Request-Id', requestId);

    const originCheck = checkOrigin(req);
    if (originCheck.corsOrigin) {
      // Allowlisted cross-origin caller — echo the specific origin, never '*'
      res.setHeader('Access-Control-Allow-Origin', originCheck.corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      if (!originCheck.allowed) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Origin not allowed', status: 403 }));
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    const isApiRoute = path.startsWith('/api/');
    const isWriteMethod = req.method === 'PUT' || req.method === 'POST' || req.method === 'DELETE';

    // Reject disallowed cross-origin requests on API routes (DNS-rebinding /
    // cross-site request protection in addition to Bearer auth).
    if (isApiRoute && !originCheck.allowed) {
      log.warn('Blocked disallowed origin', { origin: req.headers['origin'], request_id: requestId });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Origin not allowed', status: 403 }));
      return;
    }

    // Rate limiting for API routes
    if (isApiRoute) {
      const clientIp = clientIpOf(req);
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
      if (!timingSafeBearerEqual(req.headers['authorization'], authToken)) {
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
        if (!db.getSOP(id)) { notFound(res); return; }
        // Audit is written atomically inside updateSOP (#56).
        const sop = db.updateSOP(id, parsed.data, undefined, { action: 'update', source: 'api' });
        json(res, sop);
      } else if (path.match(/^\/api\/sops\/[a-f0-9]+\/status$/) && req.method === 'PUT') {
        const id = path.split('/')[3]!;
        const body = await readBody(req);
        const parsed = UpdateSOPStatusSchema.safeParse(JSON.parse(body));
        if (!parsed.success) { zodError(res, parsed.error); return; }
        if (!db.getSOP(id)) { notFound(res); return; }
        // Audit is written atomically inside updateSOPStatus (#56).
        const sop = db.updateSOPStatus(id, parsed.data.status as SOPStatus, { action: 'status_change', source: 'api' });
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
        res.end(getDashboardHTML(config));
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

/** Read the request body as a UTF-8 string, capped at the shared HTTP body limit. */
function readBody(req: IncomingMessage): Promise<string> {
  return readLimitedBody(req).then(buf => buf.toString('utf8'));
}
