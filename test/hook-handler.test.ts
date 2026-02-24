import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShadowingDB } from '../src/db.js';
import {
  processHookEvent,
  classifyToolAction,
  buildActionDescription,
  isGitCommand,
} from '../src/hook-handler.js';
import type { HookEvent } from '../src/hook-handler.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `shadowing-hook-test-${Date.now()}.db`);
let db: ShadowingDB;

beforeEach(() => {
  db = new ShadowingDB(DB_PATH);
  db.initialize();
});

afterEach(() => {
  db.close();
  try { unlinkSync(DB_PATH); } catch { /* ok */ }
});

// ── classifyToolAction ──────────────────────────────────────────────────────

describe('classifyToolAction', () => {
  it('classifies Bash as shell/command-execution', () => {
    expect(classifyToolAction('Bash')).toEqual({ source: 'shell', category: 'command-execution' });
  });

  it('classifies Edit as file/file-operation', () => {
    expect(classifyToolAction('Edit')).toEqual({ source: 'file', category: 'file-operation' });
  });

  it('classifies Write as file/file-operation', () => {
    expect(classifyToolAction('Write')).toEqual({ source: 'file', category: 'file-operation' });
  });

  it('classifies Read as file/file-operation', () => {
    expect(classifyToolAction('Read')).toEqual({ source: 'file', category: 'file-operation' });
  });

  it('classifies Glob as file/code-search', () => {
    expect(classifyToolAction('Glob')).toEqual({ source: 'file', category: 'code-search' });
  });

  it('classifies Grep as file/code-search', () => {
    expect(classifyToolAction('Grep')).toEqual({ source: 'file', category: 'code-search' });
  });

  it('classifies WebFetch as manual/web-research', () => {
    expect(classifyToolAction('WebFetch')).toEqual({ source: 'manual', category: 'web-research' });
  });

  it('classifies WebSearch as manual/web-research', () => {
    expect(classifyToolAction('WebSearch')).toEqual({ source: 'manual', category: 'web-research' });
  });

  it('classifies Task as manual/task-management', () => {
    expect(classifyToolAction('Task')).toEqual({ source: 'manual', category: 'task-management' });
  });

  it('classifies TodoWrite as manual/task-management', () => {
    expect(classifyToolAction('TodoWrite')).toEqual({ source: 'manual', category: 'task-management' });
  });

  it('classifies unknown tools as manual/other', () => {
    expect(classifyToolAction('CustomTool')).toEqual({ source: 'manual', category: 'other' });
  });

  it('is case-insensitive', () => {
    expect(classifyToolAction('bash')).toEqual({ source: 'shell', category: 'command-execution' });
    expect(classifyToolAction('EDIT')).toEqual({ source: 'file', category: 'file-operation' });
  });
});

// ── buildActionDescription ──────────────────────────────────────────────────

describe('buildActionDescription', () => {
  it('formats Bash commands', () => {
    expect(buildActionDescription('Bash', { command: 'npm test' }))
      .toBe('npm test');
  });

  it('truncates long Bash commands', () => {
    const longCmd = 'x'.repeat(300);
    const result = buildActionDescription('Bash', { command: longCmd });
    expect(result.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(result).toContain('...');
  });

  it('formats Read actions', () => {
    expect(buildActionDescription('Read', { file_path: '/src/main.ts' }))
      .toBe('Lesen: /src/main.ts');
  });

  it('formats Edit actions', () => {
    expect(buildActionDescription('Edit', { file_path: '/src/main.ts' }))
      .toBe('Bearbeiten: /src/main.ts');
  });

  it('formats Write actions', () => {
    expect(buildActionDescription('Write', { file_path: '/src/new.ts' }))
      .toBe('Schreiben: /src/new.ts');
  });

  it('formats Glob actions', () => {
    expect(buildActionDescription('Glob', { pattern: '**/*.ts' }))
      .toBe('Dateisuche: **/*.ts');
  });

  it('formats Grep actions', () => {
    expect(buildActionDescription('Grep', { pattern: 'TODO' }))
      .toBe('Code-Suche: TODO');
  });

  it('formats WebFetch actions', () => {
    expect(buildActionDescription('WebFetch', { url: 'https://example.com' }))
      .toBe('Web-Fetch: https://example.com');
  });

  it('formats WebSearch actions', () => {
    expect(buildActionDescription('WebSearch', { query: 'TypeScript MCP' }))
      .toBe('Web-Suche: TypeScript MCP');
  });

  it('formats Task actions', () => {
    expect(buildActionDescription('Task', { description: 'Find config files' }))
      .toBe('Subagent: Find config files');
  });

  it('falls back to JSON for unknown tools', () => {
    const result = buildActionDescription('CustomTool', { foo: 'bar' });
    expect(result).toContain('CustomTool:');
    expect(result).toContain('bar');
  });
});

// ── isGitCommand ────────────────────────────────────────────────────────────

describe('isGitCommand', () => {
  it('detects git commands in Bash', () => {
    expect(isGitCommand('Bash', { command: 'git status' })).toBe(true);
    expect(isGitCommand('Bash', { command: 'git push origin main' })).toBe(true);
  });

  it('detects gh commands in Bash', () => {
    expect(isGitCommand('Bash', { command: 'gh pr create' })).toBe(true);
  });

  it('returns false for non-git Bash commands', () => {
    expect(isGitCommand('Bash', { command: 'npm test' })).toBe(false);
  });

  it('returns false for non-Bash tools', () => {
    expect(isGitCommand('Edit', { command: 'git status' })).toBe(false);
  });

  it('handles missing command', () => {
    expect(isGitCommand('Bash', {})).toBe(false);
  });
});

// ── processHookEvent ────────────────────────────────────────────────────────

describe('processHookEvent', () => {
  it('ignores PreToolUse events', () => {
    processHookEvent(db, {
      event: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    const session = db.getActiveObservationSession();
    expect(session).toBeNull();
  });

  it('creates session and logs PostToolUse event', () => {
    processHookEvent(db, {
      event: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });

    const session = db.getActiveObservationSession();
    expect(session).not.toBeNull();
    expect(session!.title).toBe('Claude Code Hook Session');

    const actions = db.getObservedActions(session!.id, {});
    expect(actions).toHaveLength(1);
    expect(actions[0]!.source).toBe('shell');
    expect(actions[0]!.command).toBe('npm test');
    expect(actions[0]!.app_name).toBe('Claude Code');
  });

  it('reuses existing active session', () => {
    processHookEvent(db, {
      event: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/src/a.ts' },
    });

    processHookEvent(db, {
      event: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/src/b.ts' },
    });

    const sessions = db.listObservationSessions();
    expect(sessions).toHaveLength(1);

    const actions = db.getObservedActions(sessions[0]!.id, {});
    expect(actions).toHaveLength(2);
  });

  it('classifies git commands in Bash as git source', () => {
    processHookEvent(db, {
      event: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "test"' },
    });

    const session = db.getActiveObservationSession()!;
    const actions = db.getObservedActions(session.id, {});
    expect(actions[0]!.source).toBe('git');
  });

  it('captures file_path for file operations', () => {
    processHookEvent(db, {
      event: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/home/user/src/main.ts', old_string: 'a', new_string: 'b' },
    });

    const session = db.getActiveObservationSession()!;
    const actions = db.getObservedActions(session.id, {});
    expect(actions[0]!.file_path).toBe('/home/user/src/main.ts');
    expect(actions[0]!.source).toBe('file');
  });

  it('logs Stop event as manual action', () => {
    // First create a session
    processHookEvent(db, {
      event: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
    });

    processHookEvent(db, {
      event: 'Stop',
      stop_reason: 'end_turn',
    });

    const session = db.getActiveObservationSession()!;
    const actions = db.getObservedActions(session.id, {});
    expect(actions).toHaveLength(2);
    const stopAction = actions.find(a => a.window_title?.includes('beendet'));
    expect(stopAction).toBeTruthy();
    expect(stopAction!.source).toBe('manual');
  });

  it('SessionStart ensures session exists', () => {
    processHookEvent(db, {
      event: 'SessionStart',
    });

    const session = db.getActiveObservationSession();
    expect(session).not.toBeNull();
  });

  it('stores metadata with tool name and category', () => {
    processHookEvent(db, {
      event: 'PostToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'TODO' },
    });

    const session = db.getActiveObservationSession()!;
    const actions = db.getObservedActions(session.id, {});
    const metadata = JSON.parse(actions[0]!.metadata!);
    expect(metadata.tool).toBe('Grep');
    expect(metadata.category).toBe('code-search');
  });

  it('skips PostToolUse without tool_name', () => {
    // Create session first
    db.startObservationSession('Test');

    processHookEvent(db, {
      event: 'PostToolUse',
    });

    const session = db.getActiveObservationSession()!;
    const actions = db.getObservedActions(session.id, {});
    expect(actions).toHaveLength(0);
  });
});
