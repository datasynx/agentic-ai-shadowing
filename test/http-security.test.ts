import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import {
  isLoopbackHost,
  timingSafeStrEqual,
  timingSafeBearerEqual,
  readLimitedBody,
  BodyTooLargeError,
  loopbackHostHeaders,
  clientIpOf,
} from '../src/http-security.js';

describe('isLoopbackHost', () => {
  it('recognizes all loopback forms', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it('rejects non-loopback hosts', () => {
    for (const h of ['evil.example.com', '10.0.0.1', '0.0.0.0', '192.168.1.5']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe('constant-time comparison', () => {
  it('timingSafeStrEqual matches equal strings and rejects different ones', () => {
    expect(timingSafeStrEqual('hunter2', 'hunter2')).toBe(true);
    expect(timingSafeStrEqual('hunter2', 'hunter3')).toBe(false);
    // length mismatch must not throw and must compare false
    expect(timingSafeStrEqual('short', 'a much longer secret')).toBe(false);
  });

  it('timingSafeBearerEqual validates the Authorization header', () => {
    expect(timingSafeBearerEqual('Bearer t0ken', 't0ken')).toBe(true);
    expect(timingSafeBearerEqual('Bearer wrong', 't0ken')).toBe(false);
    expect(timingSafeBearerEqual('t0ken', 't0ken')).toBe(false); // missing "Bearer " prefix
    expect(timingSafeBearerEqual(undefined, 't0ken')).toBe(false);
  });
});

describe('readLimitedBody', () => {
  it('resolves bodies under the cap', async () => {
    const stream = Readable.from([Buffer.from('hello world')]) as unknown as IncomingMessage;
    const buf = await readLimitedBody(stream, 1024);
    expect(buf.toString('utf8')).toBe('hello world');
  });

  it('rejects bodies over the cap with BodyTooLargeError', async () => {
    const stream = Readable.from([Buffer.from('x'.repeat(50))]) as unknown as IncomingMessage;
    await expect(readLimitedBody(stream, 10)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe('loopbackHostHeaders', () => {
  it('builds host:port entries for every loopback form plus extras', () => {
    const headers = loopbackHostHeaders(3848, ['internal.host']);
    expect(headers).toContain('127.0.0.1:3848');
    expect(headers).toContain('localhost:3848');
    expect(headers).toContain('[::1]:3848');
    expect(headers).toContain('::1:3848');
    expect(headers).toContain('internal.host:3848');
  });
});

describe('clientIpOf', () => {
  it('prefers the first x-forwarded-for hop, falling back to the socket', () => {
    const fwd = { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.1' } } as unknown as IncomingMessage;
    expect(clientIpOf(fwd)).toBe('203.0.113.7');

    const direct = { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
    expect(clientIpOf(direct)).toBe('127.0.0.1');
  });
});
