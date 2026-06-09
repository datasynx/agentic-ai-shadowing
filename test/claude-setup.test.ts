import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyClaudeSetup, settingsPathForScope } from '../src/claude-setup.js';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'shadowing-setup-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

const localSettings = (): string => join(projectDir, '.claude', 'settings.local.json');
const mcpJson = (): string => join(projectDir, '.mcp.json');

describe('applyClaudeSetup — install', () => {
  it('creates settings.local.json (default scope) with current hook schema and .mcp.json', () => {
    const result = applyClaudeSetup({ projectDir });
    expect(result.alreadyConfigured).toBe(false);
    expect(result.changes.map(c => c.path).sort()).toEqual([localSettings(), mcpJson()].sort());

    const settings = readJson(localSettings()) as {
      hooks: { PostToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> }>; Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUse[0]!.matcher).toBe('*');
    expect(settings.hooks.PostToolUse[0]!.hooks[0]).toMatchObject({
      type: 'command', command: 'npx shadowing hook', timeout: 10,
    });
    expect(settings.hooks.Stop[0]!.hooks[0]!.command).toBe('npx shadowing hook --event stop');

    const mcp = readJson(mcpJson()) as { mcpServers: { shadowing: Record<string, unknown> } };
    expect(mcp.mcpServers.shadowing).toEqual({ type: 'stdio', command: 'npx', args: ['shadowing', 'mcp'] });
  });

  it('is idempotent: second run reports already configured, files unchanged', () => {
    applyClaudeSetup({ projectDir });
    const settingsBefore = readFileSync(localSettings(), 'utf8');
    const mcpBefore = readFileSync(mcpJson(), 'utf8');

    const second = applyClaudeSetup({ projectDir });
    expect(second.alreadyConfigured).toBe(true);
    expect(second.changes).toEqual([]);
    expect(readFileSync(localSettings(), 'utf8')).toBe(settingsBefore);
    expect(readFileSync(mcpJson(), 'utf8')).toBe(mcpBefore);
  });

  it('respects project and user scopes', () => {
    applyClaudeSetup({ projectDir, scope: 'project' });
    expect(existsSync(join(projectDir, '.claude', 'settings.json'))).toBe(true);

    const fakeHome = mkdtempSync(join(tmpdir(), 'shadowing-home-'));
    try {
      applyClaudeSetup({ projectDir, scope: 'user', homeDir: fakeHome });
      expect(existsSync(join(fakeHome, '.claude', 'settings.json'))).toBe(true);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
    expect(settingsPathForScope(projectDir, 'local')).toBe(localSettings());
  });

  it('preserves foreign entries and migrates legacy flat hook entries', () => {
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    writeFileSync(localSettings(), JSON.stringify({
      env: { FOO: 'bar' },
      hooks: {
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] },
          { matcher: '*', command: 'npx shadowing hook' }, // legacy flat entry
        ],
      },
      mcpServers: { shadowing: { command: 'npx', args: ['shadowing', 'mcp'] }, other: { command: 'x' } },
    }, null, 2) + '\n', 'utf8');

    applyClaudeSetup({ projectDir });

    const settings = readJson(localSettings()) as {
      env: Record<string, string>;
      hooks: { PostToolUse: Array<{ matcher?: string; command?: string; hooks?: Array<{ command: string }> }> };
      mcpServers: Record<string, unknown>;
    };
    expect(settings.env).toEqual({ FOO: 'bar' });
    const commands = settings.hooks.PostToolUse.map(e => e.command ?? e.hooks![0]!.command);
    expect(commands).toContain('my-own-hook.sh');
    expect(commands).toContain('npx shadowing hook');
    // Legacy flat entry replaced, not duplicated
    expect(settings.hooks.PostToolUse).toHaveLength(2);
    // Legacy mcpServers.shadowing cleaned up, foreign server preserved
    expect(settings.mcpServers).toEqual({ other: { command: 'x' } });
  });

  it('fails safe on corrupt JSON — never clobbers', () => {
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    writeFileSync(localSettings(), '{ not json', 'utf8');

    expect(() => applyClaudeSetup({ projectDir })).toThrowError(/Refusing to modify/);
    expect(readFileSync(localSettings(), 'utf8')).toBe('{ not json');
  });
});

describe('applyClaudeSetup — dry run', () => {
  it('reports changes but writes nothing', () => {
    const result = applyClaudeSetup({ projectDir, dryRun: true });
    expect(result.changes.length).toBeGreaterThan(0);
    expect(existsSync(localSettings())).toBe(false);
    expect(existsSync(mcpJson())).toBe(false);
  });
});

describe('applyClaudeSetup — uninstall', () => {
  it('removes exactly the managed entries and deletes an .mcp.json it fully owns', () => {
    applyClaudeSetup({ projectDir });
    applyClaudeSetup({ projectDir, uninstall: true });

    // .mcp.json contained only our entry → removed entirely
    expect(existsSync(mcpJson())).toBe(false);
    // settings file is emptied but never deleted
    expect(readJson(localSettings())).toEqual({});
  });

  it('preserves foreign content on uninstall', () => {
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    writeFileSync(localSettings(), JSON.stringify({
      hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'keep-me.sh' }] }] },
    }, null, 2) + '\n', 'utf8');
    writeFileSync(mcpJson(), JSON.stringify({
      mcpServers: { other: { command: 'x' } },
    }, null, 2) + '\n', 'utf8');

    applyClaudeSetup({ projectDir });
    applyClaudeSetup({ projectDir, uninstall: true });

    const settings = readJson(localSettings()) as { hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> } };
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUse[0]!.hooks[0]!.command).toBe('keep-me.sh');

    const mcp = readJson(mcpJson()) as { mcpServers: Record<string, unknown> };
    expect(mcp.mcpServers).toEqual({ other: { command: 'x' } });
  });

  it('uninstall on a clean project reports nothing to remove', () => {
    const result = applyClaudeSetup({ projectDir, uninstall: true });
    expect(result.changes).toEqual([]);
  });

  it('install → uninstall round-trip restores a pre-existing file byte-identically', () => {
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    const original = JSON.stringify({ env: { KEEP: '1' } }, null, 2) + '\n';
    writeFileSync(localSettings(), original, 'utf8');

    applyClaudeSetup({ projectDir });
    applyClaudeSetup({ projectDir, uninstall: true });

    expect(readFileSync(localSettings(), 'utf8')).toBe(original);
  });
});
