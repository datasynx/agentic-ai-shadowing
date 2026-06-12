import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

// ── Shared HTTP security primitives ──────────────────────────────────────────
// Used by both the MCP Streamable HTTP transport (src/mcp-server.ts) and the
// web dashboard (src/ui-server.ts) so the two siblings share one correct
// implementation of loopback checks, constant-time auth, body caps, and
// per-IP rate limiting.

/** Loopback hostnames a server may bind / accept without an auth token. */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/**
 * Constant-time string equality. Both sides are hashed to a fixed-length digest
 * first, so timingSafeEqual never throws on a length mismatch and the comparison
 * leaks neither the secret's length nor its content via timing.
 */
export function timingSafeStrEqual(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}

/** Constant-time check of an Authorization header against the expected bearer token. */
export function timingSafeBearerEqual(header: string | undefined, token: string): boolean {
  if (!header) return false;
  return timingSafeStrEqual(header, `Bearer ${token}`);
}

export const MAX_HTTP_BODY_BYTES = 1024 * 1024; // 1 MB

export class BodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
    this.name = 'BodyTooLargeError';
  }
}

/** Buffer a request body, aborting with BodyTooLargeError once maxBytes is exceeded. */
export function readLimitedBody(req: IncomingMessage, maxBytes = MAX_HTTP_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Best-effort client IP for rate limiting (x-forwarded-for first hop, else socket). */
export function clientIpOf(req: IncomingMessage): string {
  return (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    ?? req.socket.remoteAddress
    ?? 'unknown';
}

/**
 * SDK allowedHosts entries (a Host header is "hostname:port") for a bound port
 * plus any extra hostnames. Used to enable the MCP SDK's DNS-rebinding
 * protection with an explicit Host allowlist.
 */
export function loopbackHostHeaders(port: number, extraHosts: string[] = []): string[] {
  const hosts = ['127.0.0.1', 'localhost', '[::1]', '::1', ...extraHosts];
  return hosts.map(h => `${h}:${port}`);
}

// ── Rate Limiter ──────────────────────────────────────────────────────────────

interface RateLimitEntry { count: number; resetAt: number }

/** Per-IP read/write rate limiter with a sliding fixed window. */
export class RateLimiter {
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
