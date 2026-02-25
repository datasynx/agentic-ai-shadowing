/**
 * Claude Code Hook Handler
 *
 * This script is invoked by Claude Code hooks to log actions into shadowing's
 * observation layer. It reads hook event data from stdin and logs it to the DB.
 *
 * Hook events from Claude Code:
 * - PreToolUse:  { tool_name, tool_input }
 * - PostToolUse: { tool_name, tool_input, tool_output }
 * - Stop:        { stop_reason, ... }
 *
 * Usage in .claude/settings.json:
 * {
 *   "hooks": {
 *     "PostToolUse": [{ "matcher": "*", "command": "npx shadowing hook" }],
 *     "Stop": [{ "matcher": "", "command": "npx shadowing hook --event stop" }]
 *   }
 * }
 */

import { existsSync } from 'node:fs';
import { ShadowingDB } from './db.js';
import { getDbPath } from './config.js';
import type { ActionSource } from './types.js';

// ── Hook Event Types ────────────────────────────────────────────────────────

export interface HookEvent {
  event: string;              // PreToolUse, PostToolUse, Stop, SessionStart
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  stop_reason?: string;
  session_id?: string;
}

// ── Tool Classification ─────────────────────────────────────────────────────

export function classifyToolAction(toolName: string): { source: ActionSource; category: string } {
  const name = toolName.toLowerCase();

  if (name === 'bash' || name === 'shell' || name === 'terminal') {
    return { source: 'shell', category: 'command-execution' };
  }
  if (name === 'edit' || name === 'write' || name === 'read' || name === 'notebookedit') {
    return { source: 'file', category: 'file-operation' };
  }
  if (name === 'glob' || name === 'grep') {
    return { source: 'file', category: 'code-search' };
  }
  if (name.includes('git') || name === 'bash') {
    return { source: 'git', category: 'version-control' };
  }
  if (name === 'webfetch' || name === 'websearch') {
    return { source: 'manual', category: 'web-research' };
  }
  if (name === 'task' || name === 'todowrite') {
    return { source: 'manual', category: 'task-management' };
  }
  return { source: 'manual', category: 'other' };
}

// ── Extract meaningful description from tool input ──────────────────────────

export function buildActionDescription(toolName: string, input: Record<string, unknown>): string {
  const name = toolName.toLowerCase();

  if (name === 'bash' && input['command']) {
    const cmd = input['command'] as string;
    // Truncate long commands
    return cmd.length > 200 ? cmd.substring(0, 200) + '...' : cmd;
  }
  if ((name === 'edit' || name === 'write' || name === 'read') && input['file_path']) {
    const action = name === 'read' ? 'Read' : name === 'edit' ? 'Edit' : 'Write';
    return `${action}: ${input['file_path'] as string}`;
  }
  if (name === 'glob' && input['pattern']) {
    return `File search: ${input['pattern'] as string}`;
  }
  if (name === 'grep' && input['pattern']) {
    return `Code search: ${input['pattern'] as string}`;
  }
  if (name === 'webfetch' && input['url']) {
    return `Web fetch: ${input['url'] as string}`;
  }
  if (name === 'websearch' && input['query']) {
    return `Web search: ${input['query'] as string}`;
  }
  if (name === 'task' && input['description']) {
    return `Sub-agent: ${input['description'] as string}`;
  }

  return `${toolName}: ${JSON.stringify(input).substring(0, 150)}`;
}

// ── Detect git commands in Bash tool calls ──────────────────────────────────

export function isGitCommand(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName.toLowerCase() !== 'bash') return false;
  const cmd = (input['command'] as string) ?? '';
  return /^\s*(git|gh)\s/.test(cmd);
}

// ── Process Hook Event ──────────────────────────────────────────────────────

export function processHookEvent(db: ShadowingDB, event: HookEvent): void {
  // Only process PostToolUse and Stop events
  if (event.event !== 'PostToolUse' && event.event !== 'Stop' && event.event !== 'SessionStart') {
    return;
  }

  // Get or create active observation session
  let session = db.getActiveObservationSession();
  if (!session) {
    session = db.startObservationSession('Claude Code Hook Session');
  }

  if (event.event === 'SessionStart') {
    // Just ensure session exists — already done above
    return;
  }

  if (event.event === 'Stop') {
    // Log a summary action for session end
    db.logObservedAction(session.id, {
      source: 'manual',
      window_title: `Claude Code session ended (${event.stop_reason ?? 'unknown'})`,
      metadata: { stop_reason: event.stop_reason },
    });
    return;
  }

  // PostToolUse — log the tool action
  if (!event.tool_name) return;

  const { source, category } = classifyToolAction(event.tool_name);
  const actualSource = isGitCommand(event.tool_name, event.tool_input ?? {}) ? 'git' as ActionSource : source;
  const description = buildActionDescription(event.tool_name, event.tool_input ?? {});

  const command = event.tool_name.toLowerCase() === 'bash'
    ? (event.tool_input?.['command'] as string) ?? undefined
    : undefined;

  const filePath = (event.tool_input?.['file_path'] as string)
    ?? (event.tool_input?.['path'] as string)
    ?? undefined;

  db.logObservedAction(session.id, {
    source: actualSource,
    app_name: 'Claude Code',
    window_title: description,
    command,
    file_path: filePath,
    metadata: {
      tool: event.tool_name,
      category,
      has_output: !!event.tool_output,
    },
  });
}

// ── CLI Entry Point ─────────────────────────────────────────────────────────

export async function runHookHandler(eventOverride?: string): Promise<void> {
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    // Silently exit if shadowing is not initialized — hooks should not fail
    return;
  }

  // Read stdin for hook data
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const stdin = Buffer.concat(chunks).toString().trim();

  let hookData: Record<string, unknown> = {};
  if (stdin) {
    try {
      hookData = JSON.parse(stdin) as Record<string, unknown>;
    } catch {
      // Non-JSON stdin — might be raw text from a hook
      hookData = { raw: stdin };
    }
  }

  const event: HookEvent = {
    event: eventOverride ?? (hookData['event'] as string) ?? 'PostToolUse',
    tool_name: hookData['tool_name'] as string | undefined,
    tool_input: hookData['tool_input'] as Record<string, unknown> | undefined,
    tool_output: hookData['tool_output'] as string | undefined,
    stop_reason: hookData['stop_reason'] as string | undefined,
    session_id: hookData['session_id'] as string | undefined,
  };

  const db = new ShadowingDB(dbPath);
  try {
    processHookEvent(db, event);
  } finally {
    db.close();
  }
}
