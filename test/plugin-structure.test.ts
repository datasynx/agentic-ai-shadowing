import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { HOOK_COMMAND, STOP_COMMAND } from '../src/claude-setup.js';

/**
 * Structural validation of the Claude Code plugin (plugin/).
 * CI gate standing in for `claude plugin validate --strict` (the claude CLI
 * is not available in CI) — validates manifest shape, referenced files,
 * hook schema, MCP entry, and SKILL.md frontmatter.
 */

const PLUGIN_DIR = join(__dirname, '..', 'plugin');

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PLUGIN_DIR, rel), 'utf8')) as Record<string, unknown>;
}

describe('plugin manifest (.claude-plugin/plugin.json)', () => {
  const manifest = readJson('.claude-plugin/plugin.json');

  it('has a kebab-case name and the core metadata', () => {
    expect(manifest['name']).toBe('shadowing');
    expect(manifest['name']).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(String(manifest['description']).length).toBeGreaterThan(20);
    expect(manifest['license']).toBe('MIT');
    expect(String(manifest['version'])).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('references existing component files', () => {
    for (const key of ['mcpServers', 'hooks', 'skills'] as const) {
      const ref = manifest[key] as string;
      expect(ref, `${key} reference`).toBeTruthy();
      expect(existsSync(join(PLUGIN_DIR, ref)), `${key} → ${ref} exists`).toBe(true);
    }
  });
});

describe('plugin MCP registration (.mcp.json)', () => {
  it('registers the published npm package over stdio', () => {
    const mcp = readJson('.mcp.json') as { mcpServers: Record<string, { type: string; command: string; args: string[] }> };
    const entry = mcp.mcpServers['shadowing']!;
    expect(entry.type).toBe('stdio');
    expect(entry.command).toBe('npx');
    expect(entry.args).toEqual(['-y', '@datasynx/agentic-ai-shadowing', 'mcp']);
  });
});

describe('plugin hooks (hooks/hooks.json)', () => {
  const hooksFile = readJson('hooks/hooks.json') as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> }>>;
  };

  it('uses the documented nested schema with type/command/timeout', () => {
    for (const entries of Object.values(hooksFile.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          expect(hook.type).toBe('command');
          expect(hook.command).toContain('shadowing hook');
          expect(hook.timeout).toBeGreaterThan(0);
        }
      }
    }
  });

  it('uses commands identical to setup-hooks (Claude Code dedupes identical commands — double-registration guard)', () => {
    const commands = Object.values(hooksFile.hooks)
      .flatMap(entries => entries.flatMap(e => e.hooks.map(h => h.command)))
      .sort();
    expect(commands).toEqual([HOOK_COMMAND, STOP_COMMAND].sort());
  });

  it('covers PostToolUse and Stop', () => {
    expect(Object.keys(hooksFile.hooks).sort()).toEqual(['PostToolUse', 'Stop']);
    expect(hooksFile.hooks['PostToolUse']![0]!.matcher).toBe('*');
  });
});

describe('plugin skill (skills/shadowing/SKILL.md)', () => {
  const skill = readFileSync(join(PLUGIN_DIR, 'skills', 'shadowing', 'SKILL.md'), 'utf8');

  it('has valid frontmatter with name and an action-oriented description', () => {
    expect(skill.startsWith('---\n')).toBe(true);
    const frontmatter = skill.split('---')[1]!;
    expect(frontmatter).toMatch(/name:\s*shadowing/);
    const description = /description:\s*(.+)/.exec(frontmatter)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(50);
    expect(description).toContain('shadowing_start_task');
  });

  it('stays concise (recurring token cost) and references real tool names', () => {
    expect(skill.split('\n').length).toBeLessThan(100);
    for (const tool of ['shadowing_start_task', 'shadowing_complete_task', 'shadowing_approve_sop', 'shadowing_export_sops']) {
      expect(skill).toContain(tool);
    }
  });
});
