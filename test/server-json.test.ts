import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * MCP Registry manifest validation (#32): server.json must stay consistent
 * with package.json — the registry verifies npm ownership by matching the
 * tarball's mcpName against server.json's name, and versions are kept in
 * lockstep by scripts/sync-server-json.mjs during releases.
 */

const ROOT = join(__dirname, '..');
const serverJson = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8')) as {
  name: string;
  description: string;
  version: string;
  packages: Array<{ registryType: string; identifier: string; version: string; transport: { type: string }; packageArguments?: Array<{ type: string; value: string }> }>;
};
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  name: string; version: string; mcpName?: string;
};

describe('server.json ↔ package.json consistency', () => {
  it('mcpName in package.json matches server.json name (registry ownership proof)', () => {
    expect(packageJson.mcpName).toBe(serverJson.name);
    expect(serverJson.name).toBe('io.github.datasynx/agentic-ai-shadowing');
  });

  it('versions are in lockstep', () => {
    expect(serverJson.version).toBe(packageJson.version);
    for (const pkg of serverJson.packages) {
      expect(pkg.version).toBe(packageJson.version);
    }
  });

  it('registers the npm package with stdio transport and the mcp subcommand', () => {
    const pkg = serverJson.packages[0]!;
    expect(pkg.registryType).toBe('npm');
    expect(pkg.identifier).toBe(packageJson.name);
    expect(pkg.transport.type).toBe('stdio');
    expect(pkg.packageArguments).toEqual([{ type: 'positional', value: 'mcp' }]);
  });
});

describe('scripts/sync-server-json.mjs', () => {
  it('updates all version fields and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowing-serverjson-'));
    try {
      mkdirSync(join(dir, 'scripts'));
      cpSync(join(ROOT, 'server.json'), join(dir, 'server.json'));
      cpSync(join(ROOT, 'scripts', 'sync-server-json.mjs'), join(dir, 'scripts', 'sync-server-json.mjs'));

      execFileSync('node', [join(dir, 'scripts', 'sync-server-json.mjs'), '9.9.9']);
      const once = readFileSync(join(dir, 'server.json'), 'utf8');
      const data = JSON.parse(once) as typeof serverJson;
      expect(data.version).toBe('9.9.9');
      expect(data.packages.every(p => p.version === '9.9.9')).toBe(true);

      execFileSync('node', [join(dir, 'scripts', 'sync-server-json.mjs'), '9.9.9']);
      expect(readFileSync(join(dir, 'server.json'), 'utf8')).toBe(once);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects garbage version arguments', () => {
    expect(() => execFileSync('node', [join(ROOT, 'scripts', 'sync-server-json.mjs'), 'not-a-version'], { stdio: 'pipe' }))
      .toThrow();
  });
});
