/**
 * Claude Code integration setup (`shadowing setup-hooks`).
 *
 * Writes two things, idempotently and reversibly (#24):
 *  - Hook entries (current Claude Code schema: matcher + hooks[] with
 *    type/command/timeout) into the chosen settings file. Default scope is
 *    `local` (.claude/settings.local.json) — observing is a personal choice
 *    and should not land in the team's committed settings by default.
 *  - The MCP server registration into the project's `.mcp.json` (the
 *    documented project-scope location; older versions wrote it into
 *    settings.json, which install/uninstall clean up).
 *
 * Managed-entry convention: entries are recognized by their canonical
 * command strings (exact match), plus a legacy substring match so entries
 * written by older versions are migrated/removed. Unparseable target files
 * abort with an error — this module never overwrites what it cannot read.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export type SetupScope = 'local' | 'project' | 'user';

export interface SetupFileChange {
  path: string;
  /** Raw file text before (null = file did not exist). */
  before: string | null;
  /** Raw file text after (null = file deleted). */
  after: string | null;
}

export interface SetupResult {
  /** Files that would change / changed. Unchanged files are not listed. */
  changes: SetupFileChange[];
  /** True when an install run found everything already in place. */
  alreadyConfigured: boolean;
}

export interface SetupOptions {
  projectDir: string;
  scope?: SetupScope;
  uninstall?: boolean;
  dryRun?: boolean;
  /** Test override for the user scope home directory. */
  homeDir?: string;
}

const HOOK_COMMAND = 'npx shadowing hook';
const STOP_COMMAND = 'npx shadowing hook --event stop';
const LEGACY_MARKER = 'shadowing hook';
const HOOK_TIMEOUT_SECONDS = 10;

interface HookCommandSpec { type: 'command'; command: string; timeout: number }
interface HookEntry { matcher?: string; hooks?: HookCommandSpec[]; command?: string }

function managedPostToolUseEntry(): HookEntry {
  return {
    matcher: '*',
    hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS }],
  };
}

function managedStopEntry(): HookEntry {
  return {
    hooks: [{ type: 'command', command: STOP_COMMAND, timeout: HOOK_TIMEOUT_SECONDS }],
  };
}

/** An entry is ours if any nested (or legacy flat) command references the hook handler. */
function isManagedEntry(entry: HookEntry): boolean {
  if (typeof entry.command === 'string' && entry.command.includes(LEGACY_MARKER)) return true;
  return (entry.hooks ?? []).some(h => typeof h.command === 'string' && h.command.includes(LEGACY_MARKER));
}

export function settingsPathForScope(projectDir: string, scope: SetupScope, homeDir?: string): string {
  switch (scope) {
    case 'project': return join(projectDir, '.claude', 'settings.json');
    case 'user': return join(homeDir ?? homedir(), '.claude', 'settings.json');
    case 'local':
    default: return join(projectDir, '.claude', 'settings.local.json');
  }
}

function readJsonFile(path: string): { raw: string | null; data: Record<string, unknown> } {
  if (!existsSync(path)) return { raw: null, data: {} };
  const raw = readFileSync(path, 'utf8');
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('not a JSON object');
    }
    return { raw, data };
  } catch (err) {
    throw new Error(
      `Refusing to modify ${path}: file is not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
      'Fix or remove it manually, then re-run.',
    );
  }
}

function serialize(data: Record<string, unknown>): string {
  return JSON.stringify(data, null, 2) + '\n';
}

/** Apply (or remove) the Claude Code integration. Pure planning when dryRun. */
export function applyClaudeSetup(opts: SetupOptions): SetupResult {
  const scope = opts.scope ?? 'local';
  const settingsPath = settingsPathForScope(opts.projectDir, scope, opts.homeDir);
  const mcpJsonPath = join(opts.projectDir, '.mcp.json');

  const changes: SetupFileChange[] = [];

  // ── settings file: hooks (+ legacy mcpServers cleanup) ─────────────────
  const settingsFile = readJsonFile(settingsPath);
  const settings = structuredClone(settingsFile.data);

  const hooks = (settings['hooks'] as Record<string, HookEntry[]> | undefined) ?? {};

  for (const [event, canonical] of [
    ['PostToolUse', managedPostToolUseEntry()],
    ['Stop', managedStopEntry()],
  ] as const) {
    const entries = (hooks[event] ?? []).filter(e => !isManagedEntry(e));
    if (!opts.uninstall) entries.push(canonical);
    if (entries.length > 0) hooks[event] = entries;
    else delete hooks[event];
  }

  if (Object.keys(hooks).length > 0) settings['hooks'] = hooks;
  else delete settings['hooks'];

  // Legacy location cleanup: older versions registered the MCP server in
  // settings.json — remove it there in both install and uninstall mode.
  const legacyMcp = settings['mcpServers'] as Record<string, unknown> | undefined;
  if (legacyMcp && 'shadowing' in legacyMcp) {
    delete legacyMcp['shadowing'];
    if (Object.keys(legacyMcp).length === 0) delete settings['mcpServers'];
  }

  const settingsAfter = serialize(settings);
  const settingsIsEmpty = Object.keys(settings).length === 0;
  if (settingsFile.raw === null) {
    // Only create the file when installing actually adds content
    if (!settingsIsEmpty) changes.push({ path: settingsPath, before: null, after: settingsAfter });
  } else if (settingsAfter !== settingsFile.raw) {
    // Never delete a settings file the user may own — write the emptied object instead
    changes.push({ path: settingsPath, before: settingsFile.raw, after: settingsAfter });
  }

  // ── .mcp.json: MCP server registration ─────────────────────────────────
  const mcpFile = readJsonFile(mcpJsonPath);
  const mcpData = structuredClone(mcpFile.data);
  const mcpServers = (mcpData['mcpServers'] as Record<string, unknown> | undefined) ?? {};

  if (opts.uninstall) {
    delete mcpServers['shadowing'];
  } else {
    mcpServers['shadowing'] = {
      type: 'stdio',
      command: 'npx',
      args: ['shadowing', 'mcp'],
    };
  }

  if (Object.keys(mcpServers).length > 0) mcpData['mcpServers'] = mcpServers;
  else delete mcpData['mcpServers'];

  const mcpAfter = serialize(mcpData);
  const mcpIsEmpty = Object.keys(mcpData).length === 0;
  if (mcpFile.raw === null && !mcpIsEmpty) {
    changes.push({ path: mcpJsonPath, before: null, after: mcpAfter });
  } else if (mcpFile.raw !== null && mcpAfter !== mcpFile.raw) {
    if (mcpIsEmpty) {
      changes.push({ path: mcpJsonPath, before: mcpFile.raw, after: null });
    } else {
      changes.push({ path: mcpJsonPath, before: mcpFile.raw, after: mcpAfter });
    }
  }

  // ── write phase ─────────────────────────────────────────────────────────
  if (!opts.dryRun) {
    for (const change of changes) {
      if (change.after === null) {
        unlinkSync(change.path);
      } else {
        mkdirSync(dirname(change.path), { recursive: true });
        writeFileSync(change.path, change.after, 'utf8');
      }
    }
  }

  return {
    changes,
    alreadyConfigured: !opts.uninstall && changes.length === 0,
  };
}
