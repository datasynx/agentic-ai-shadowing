/**
 * Multi-framework harness adapters (#27): register the shadowing MCP server
 * with agent frameworks beyond Claude Code.
 *
 * Strategy (research-backed, see issue #27):
 *  - **CLI-first.** Codex, OpenClaw and Hermes all ship `… mcp add` commands.
 *    Driving the official CLI inherits each tool's own validation and
 *    migrations — OpenClaw in particular validates its config strictly
 *    (unknown keys fail startup) and changes schema monthly, so writing its
 *    files directly is a liability.
 *  - **Fail safe.** When a framework's CLI is not installed, the adapter does
 *    NOT fall back to hand-writing TOML/JSON5/YAML; it reports the manual
 *    config snippet instead. Never clobber what we cannot parse.
 *  - AGENTS.md is the one direct file write: a small (< 1 KiB) managed,
 *    markered section — Codex caps combined project docs at 32 KiB and
 *    silently drops overflow, so the section must stay an index.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

export type HarnessTarget = 'codex' | 'openclaw' | 'hermes' | 'agents-md';

export interface ExecResult { ok: boolean; output: string }
export type ExecFn = (command: string, args: string[]) => ExecResult;

export interface HarnessEnv {
  projectDir: string;
  homeDir?: string;
  /** Injectable for tests; defaults to execFileSync. */
  exec?: ExecFn;
}

export interface HarnessPlan {
  target: HarnessTarget;
  detected: boolean;
  /** Human-readable description of what install/uninstall will do. */
  actions: string[];
  /** Manual config snippet shown when the framework CLI is unavailable. */
  manualSnippet?: string;
}

export interface HarnessApplyResult {
  target: HarnessTarget;
  applied: boolean;
  messages: string[];
  /** Set when nothing could be done automatically (CLI missing). */
  manualSnippet?: string;
}

const PACKAGE = '@datasynx/agentic-ai-shadowing';
const SERVER_NAME = 'shadowing';

function defaultExec(command: string, args: string[]): ExecResult {
  try {
    const output = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: [e.stdout, e.stderr, e.message].filter(Boolean).join('\n') };
  }
}

function commandExists(exec: ExecFn, command: string): boolean {
  return exec(command, ['--version']).ok;
}

// ── Codex ────────────────────────────────────────────────────────────────────

const CODEX_SNIPPET = `# ~/.codex/config.toml
[mcp_servers.${SERVER_NAME}]
command = "npx"
args = ["-y", "${PACKAGE}", "mcp"]
`;

// ── OpenClaw ────────────────────────────────────────────────────────────────

const OPENCLAW_SNIPPET = `// ~/.openclaw/openclaw.json — prefer: openclaw mcp add ${SERVER_NAME} --command npx --arg -y --arg ${PACKAGE} --arg mcp
mcp: { servers: { ${SERVER_NAME}: { command: "npx", args: ["-y", "${PACKAGE}", "mcp"] } } }
`;

// ── Hermes ──────────────────────────────────────────────────────────────────

const HERMES_SNIPPET = `# ~/.hermes/config.yaml
mcp_servers:
  ${SERVER_NAME}:
    command: "npx"
    args: ["-y", "${PACKAGE}", "mcp"]
`;

interface CliAdapterSpec {
  target: Exclude<HarnessTarget, 'agents-md'>;
  cli: string;
  installArgs: string[];
  uninstallArgs: string[];
  verifyArgs: string[];
  snippet: string;
}

const CLI_ADAPTERS: CliAdapterSpec[] = [
  {
    target: 'codex',
    cli: 'codex',
    // codex mcp add <name> -- <command...>
    installArgs: ['mcp', 'add', SERVER_NAME, '--', 'npx', '-y', PACKAGE, 'mcp'],
    uninstallArgs: ['mcp', 'remove', SERVER_NAME],
    verifyArgs: ['mcp', 'get', SERVER_NAME],
    snippet: CODEX_SNIPPET,
  },
  {
    target: 'openclaw',
    cli: 'openclaw',
    installArgs: ['mcp', 'add', SERVER_NAME, '--command', 'npx', '--arg', '-y', '--arg', PACKAGE, '--arg', 'mcp'],
    uninstallArgs: ['mcp', 'unset', SERVER_NAME],
    verifyArgs: ['mcp', 'show', SERVER_NAME],
    snippet: OPENCLAW_SNIPPET,
  },
  {
    target: 'hermes',
    cli: 'hermes',
    installArgs: ['mcp', 'add', SERVER_NAME, '--command', 'npx -y ' + PACKAGE + ' mcp'],
    uninstallArgs: ['mcp', 'remove', SERVER_NAME],
    verifyArgs: ['mcp', 'test', SERVER_NAME],
    snippet: HERMES_SNIPPET,
  },
];

function planCliAdapter(spec: CliAdapterSpec, exec: ExecFn, uninstall: boolean): HarnessPlan {
  const detected = commandExists(exec, spec.cli);
  if (!detected) {
    return {
      target: spec.target,
      detected: false,
      actions: [`${spec.cli} CLI not found — manual configuration required`],
      manualSnippet: spec.snippet,
    };
  }
  const args = uninstall ? spec.uninstallArgs : spec.installArgs;
  return {
    target: spec.target,
    detected: true,
    actions: [`run: ${spec.cli} ${args.join(' ')}`],
  };
}

function applyCliAdapter(spec: CliAdapterSpec, exec: ExecFn, uninstall: boolean): HarnessApplyResult {
  if (!commandExists(exec, spec.cli)) {
    return {
      target: spec.target,
      applied: false,
      messages: [`${spec.cli} CLI not found. Add the server manually:`],
      manualSnippet: spec.snippet,
    };
  }

  const args = uninstall ? spec.uninstallArgs : spec.installArgs;
  const result = exec(spec.cli, args);
  if (!result.ok) {
    // e.g. Codex: server force-disabled by an admin requirements.toml,
    // or uninstall of a server that was never added. Surface, don't guess.
    return {
      target: spec.target,
      applied: false,
      messages: [
        `${spec.cli} ${args.join(' ')} failed:`,
        result.output.trim(),
        uninstall ? '' : 'Add the server manually if needed:',
      ].filter(Boolean),
      manualSnippet: uninstall ? undefined : spec.snippet,
    };
  }

  const messages = [`${spec.cli}: ${uninstall ? 'removed' : 'registered'} MCP server "${SERVER_NAME}"`];
  if (!uninstall) {
    const verify = exec(spec.cli, spec.verifyArgs);
    messages.push(verify.ok
      ? `${spec.cli}: verified (${spec.verifyArgs.join(' ')})`
      : `${spec.cli}: verification reported a problem — check ${spec.cli} ${spec.verifyArgs.join(' ')}`);
  }
  return { target: spec.target, applied: true, messages };
}

// ── AGENTS.md managed section ────────────────────────────────────────────────

const AGENTS_BEGIN = '<!-- BEGIN shadowing (managed by @datasynx/agentic-ai-shadowing — do not edit inside) -->';
const AGENTS_END = '<!-- END shadowing -->';

/** Small by design: Codex caps combined project docs at 32 KiB (silent drop). */
export function agentsMdSection(): string {
  return [
    AGENTS_BEGIN,
    '## Shadowing (task tracking & SOPs)',
    '',
    `This project uses the \`${SERVER_NAME}\` MCP server (\`npx -y ${PACKAGE} mcp\`).`,
    'Call `shadowing_start_task` when beginning a distinct piece of work and',
    '`shadowing_complete_task` when done; log notable steps with',
    '`shadowing_log_observation`. SOPs are reviewed via `shadowing_list_sops` /',
    '`shadowing_approve_sop`.',
    AGENTS_END,
  ].join('\n');
}

export function applyAgentsMd(env: HarnessEnv, opts: { uninstall?: boolean; dryRun?: boolean }): HarnessApplyResult {
  const path = join(env.projectDir, 'AGENTS.md');
  const exists = existsSync(path);
  const before = exists ? readFileSync(path, 'utf8') : null;

  const sectionPattern = new RegExp(
    `\\n?${escapeRegExp(AGENTS_BEGIN)}[\\s\\S]*?${escapeRegExp(AGENTS_END)}\\n?`,
  );

  let after: string | null;
  if (opts.uninstall) {
    if (before === null || !sectionPattern.test(before)) {
      return { target: 'agents-md', applied: false, messages: ['AGENTS.md: no managed section found — nothing to remove'] };
    }
    after = before.replace(sectionPattern, '\n').replace(/\n{3,}$/g, '\n');
    if (after.trim() === '') {
      // The file consisted only of our section — leave an empty file rather
      // than deleting a file the user may have created intentionally.
      after = '';
    }
  } else {
    const section = agentsMdSection();
    if (before === null) {
      after = section + '\n';
    } else if (sectionPattern.test(before)) {
      // Strip a leading newline introduced when the section sits at the top
      // of the file — keeps re-runs byte-identical (idempotency).
      after = before.replace(sectionPattern, '\n' + section + '\n').replace(/^\n+/, '');
    } else {
      after = before.replace(/\n*$/, '\n\n') + section + '\n';
    }
  }

  if (after === before || (before === null && after === null)) {
    return { target: 'agents-md', applied: false, messages: ['AGENTS.md: already up to date'] };
  }

  if (!opts.dryRun) {
    writeFileSync(path, after ?? '', 'utf8');
  }

  return {
    target: 'agents-md',
    applied: true,
    messages: [
      `AGENTS.md: ${opts.uninstall ? 'managed section removed' : before === null ? 'created with managed section' : 'managed section written'}${opts.dryRun ? ' (dry run)' : ''}`,
    ],
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Public surface ───────────────────────────────────────────────────────────

export const HARNESS_TARGETS: HarnessTarget[] = ['codex', 'openclaw', 'hermes', 'agents-md'];

export function planHarness(target: HarnessTarget, env: HarnessEnv, opts: { uninstall?: boolean }): HarnessPlan {
  const exec = env.exec ?? defaultExec;
  if (target === 'agents-md') {
    const path = join(env.projectDir, 'AGENTS.md');
    const exists = existsSync(path);
    return {
      target,
      detected: true,
      actions: [opts.uninstall
        ? `remove the managed section from ${path}`
        : `${exists ? 'update' : 'create'} ${path} with a managed shadowing section (~0.5 KiB)`],
    };
  }
  const spec = CLI_ADAPTERS.find(a => a.target === target)!;
  return planCliAdapter(spec, exec, opts.uninstall ?? false);
}

export function applyHarness(target: HarnessTarget, env: HarnessEnv, opts: { uninstall?: boolean; dryRun?: boolean }): HarnessApplyResult {
  const exec = env.exec ?? defaultExec;
  if (target === 'agents-md') {
    return applyAgentsMd(env, opts);
  }
  const spec = CLI_ADAPTERS.find(a => a.target === target)!;
  if (opts.dryRun) {
    const plan = planCliAdapter(spec, exec, opts.uninstall ?? false);
    return {
      target,
      applied: false,
      messages: plan.actions.map(a => `dry run — would ${a}`),
      manualSnippet: plan.manualSnippet,
    };
  }
  return applyCliAdapter(spec, exec, opts.uninstall ?? false);
}

/** Which frameworks look present on this machine (CLI on PATH or config dir). */
export function detectHarnesses(env: HarnessEnv): Record<HarnessTarget, boolean> {
  const exec = env.exec ?? defaultExec;
  const home = env.homeDir ?? homedir();
  return {
    'codex': commandExists(exec, 'codex') || existsSync(join(home, '.codex')),
    'openclaw': commandExists(exec, 'openclaw') || existsSync(join(home, '.openclaw')),
    'hermes': commandExists(exec, 'hermes') || existsSync(join(home, '.hermes')),
    'agents-md': existsSync(join(env.projectDir, 'AGENTS.md')),
  };
}
