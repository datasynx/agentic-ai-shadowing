import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  applyHarness, planHarness, detectHarnesses, agentsMdSection,
  type ExecFn, type HarnessEnv,
} from '../src/harness.js';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let projectDir: string;
let homeDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'shadowing-harness-'));
  homeDir = mkdtempSync(join(tmpdir(), 'shadowing-harness-home-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

/** Fake exec: records calls; configurable per-CLI availability and failures. */
function fakeExec(opts: { available: string[]; failOn?: string[] }): { exec: ExecFn; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec: ExecFn = (command, args) => {
    calls.push({ command, args });
    if (!opts.available.includes(command)) return { ok: false, output: `${command}: command not found` };
    if (opts.failOn?.some(f => args.join(' ').includes(f))) return { ok: false, output: 'simulated failure' };
    return { ok: true, output: 'ok' };
  };
  return { exec, calls };
}

function env(exec: ExecFn): HarnessEnv {
  return { projectDir, homeDir, exec };
}

describe('CLI adapters — install via the framework CLI (CLI-first strategy)', () => {
  it('codex: runs codex mcp add with the npm package and verifies', () => {
    const { exec, calls } = fakeExec({ available: ['codex'] });
    const result = applyHarness('codex', env(exec), {});

    expect(result.applied).toBe(true);
    const add = calls.find(c => c.args.includes('add'))!;
    expect(add.command).toBe('codex');
    expect(add.args).toEqual(['mcp', 'add', 'shadowing', '--', 'npx', '-y', '@datasynx/agentic-ai-shadowing', 'mcp']);
    // post-install verification through the tool's own CLI
    expect(calls.some(c => c.args.join(' ') === 'mcp get shadowing')).toBe(true);
  });

  it('openclaw: never writes openclaw.json directly — drives the CLI', () => {
    const { exec, calls } = fakeExec({ available: ['openclaw'] });
    const result = applyHarness('openclaw', env(exec), {});

    expect(result.applied).toBe(true);
    expect(calls.find(c => c.args.includes('add'))!.args.slice(0, 3)).toEqual(['mcp', 'add', 'shadowing']);
    expect(existsSync(join(homeDir, '.openclaw'))).toBe(false);
  });

  it('hermes: registers and verifies via hermes mcp test', () => {
    const { exec, calls } = fakeExec({ available: ['hermes'] });
    const result = applyHarness('hermes', env(exec), {});
    expect(result.applied).toBe(true);
    expect(calls.some(c => c.command === 'hermes' && c.args.join(' ') === 'mcp test shadowing')).toBe(true);
  });

  it('fails safe with a manual snippet when the CLI is missing', () => {
    const { exec } = fakeExec({ available: [] });
    const result = applyHarness('codex', env(exec), {});

    expect(result.applied).toBe(false);
    expect(result.manualSnippet).toContain('[mcp_servers.shadowing]');
    expect(result.manualSnippet).toContain('@datasynx/agentic-ai-shadowing');
  });

  it('surfaces CLI failures (e.g. admin requirements.toml force-disable) instead of guessing', () => {
    const { exec } = fakeExec({ available: ['codex'], failOn: ['mcp add'] });
    const result = applyHarness('codex', env(exec), {});

    expect(result.applied).toBe(false);
    expect(result.messages.join('\n')).toContain('failed');
    expect(result.messages.join('\n')).toContain('simulated failure');
  });

  it('uninstall runs the remove command', () => {
    const { exec, calls } = fakeExec({ available: ['hermes'] });
    const result = applyHarness('hermes', env(exec), { uninstall: true });
    expect(result.applied).toBe(true);
    expect(calls.some(c => c.args.join(' ') === 'mcp remove shadowing')).toBe(true);
  });

  it('dry run executes nothing beyond detection', () => {
    const { exec, calls } = fakeExec({ available: ['codex'] });
    const result = applyHarness('codex', env(exec), { dryRun: true });
    expect(result.applied).toBe(false);
    expect(calls.every(c => c.args.join(' ') === '--version')).toBe(true);
  });
});

describe('AGENTS.md adapter — managed section', () => {
  const agentsPath = (): string => join(projectDir, 'AGENTS.md');
  const noExec = fakeExec({ available: [] }).exec;

  it('creates AGENTS.md with a small managed section', () => {
    const result = applyHarness('agents-md', env(noExec), {});
    expect(result.applied).toBe(true);

    const content = readFileSync(agentsPath(), 'utf8');
    expect(content).toContain('BEGIN shadowing');
    expect(content).toContain('shadowing_start_task');
    // Size budget: Codex caps combined project docs at 32 KiB with silent drop
    expect(Buffer.byteLength(agentsMdSection(), 'utf8')).toBeLessThan(1024);
  });

  it('appends to an existing AGENTS.md without touching foreign content', () => {
    writeFileSync(agentsPath(), '# My project\n\nBuild with `make`.\n', 'utf8');
    applyHarness('agents-md', env(noExec), {});

    const content = readFileSync(agentsPath(), 'utf8');
    expect(content).toContain('# My project');
    expect(content).toContain('Build with `make`.');
    expect(content.indexOf('BEGIN shadowing')).toBeGreaterThan(content.indexOf('# My project'));
  });

  it('re-running replaces the managed section instead of duplicating (idempotent)', () => {
    applyHarness('agents-md', env(noExec), {});
    const first = readFileSync(agentsPath(), 'utf8');
    const second = applyHarness('agents-md', env(noExec), {});
    expect(second.applied).toBe(false);
    expect(second.messages.join(' ')).toContain('already up to date');
    expect(readFileSync(agentsPath(), 'utf8')).toBe(first);
  });

  it('uninstall removes exactly the managed section', () => {
    writeFileSync(agentsPath(), '# Keep me\n', 'utf8');
    applyHarness('agents-md', env(noExec), {});
    applyHarness('agents-md', env(noExec), { uninstall: true });

    const content = readFileSync(agentsPath(), 'utf8');
    expect(content).toContain('# Keep me');
    expect(content).not.toContain('BEGIN shadowing');
  });

  it('uninstall without a managed section is a safe no-op', () => {
    writeFileSync(agentsPath(), '# Untouched\n', 'utf8');
    const result = applyHarness('agents-md', env(noExec), { uninstall: true });
    expect(result.applied).toBe(false);
    expect(readFileSync(agentsPath(), 'utf8')).toBe('# Untouched\n');
  });

  it('dry run reports but does not write', () => {
    const result = applyHarness('agents-md', env(noExec), { dryRun: true });
    expect(result.applied).toBe(true);
    expect(result.messages.join(' ')).toContain('dry run');
    expect(existsSync(agentsPath())).toBe(false);
  });
});

describe('detection and planning', () => {
  it('detects frameworks via CLI presence or config dir', () => {
    mkdirSync(join(homeDir, '.hermes'));
    writeFileSync(join(projectDir, 'AGENTS.md'), '# x\n', 'utf8');
    const { exec } = fakeExec({ available: ['codex'] });

    const detected = detectHarnesses({ projectDir, homeDir, exec });
    expect(detected['codex']).toBe(true);      // CLI on PATH
    expect(detected['hermes']).toBe(true);     // ~/.hermes exists
    expect(detected['openclaw']).toBe(false);
    expect(detected['agents-md']).toBe(true);  // file exists
  });

  it('plans describe the exact CLI invocation', () => {
    const { exec } = fakeExec({ available: ['openclaw'] });
    const plan = planHarness('openclaw', { projectDir, homeDir, exec }, {});
    expect(plan.detected).toBe(true);
    expect(plan.actions[0]).toContain('openclaw mcp add shadowing');
  });
});
