import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ShadowingDB } from '../src/db.js';
import {
  classifyToolAction, buildActionDescription, isGitCommand, processHookEvent,
} from '../src/hook-handler.js';
import type { HookEvent } from '../src/hook-handler.js';

describe('classifyToolAction — Comprehensive', () => {
  it('classifies Bash as shell/command-execution', () => {
    const result = classifyToolAction('Bash');
    expect(result.source).toBe('shell');
    expect(result.category).toBe('command-execution');
  });

  it('classifies bash (lowercase)', () => {
    expect(classifyToolAction('bash').source).toBe('shell');
  });

  it('classifies Shell', () => {
    expect(classifyToolAction('Shell').source).toBe('shell');
  });

  it('classifies Terminal', () => {
    expect(classifyToolAction('Terminal').source).toBe('shell');
  });

  it('classifies Edit as file/file-operation', () => {
    const result = classifyToolAction('Edit');
    expect(result.source).toBe('file');
    expect(result.category).toBe('file-operation');
  });

  it('classifies Write as file', () => {
    expect(classifyToolAction('Write').source).toBe('file');
  });

  it('classifies Read as file', () => {
    expect(classifyToolAction('Read').source).toBe('file');
  });

  it('classifies NotebookEdit as file', () => {
    expect(classifyToolAction('NotebookEdit').source).toBe('file');
  });

  it('classifies Glob as file/code-search', () => {
    const result = classifyToolAction('Glob');
    expect(result.source).toBe('file');
    expect(result.category).toBe('code-search');
  });

  it('classifies Grep as file/code-search', () => {
    expect(classifyToolAction('Grep').category).toBe('code-search');
  });

  it('classifies WebFetch as manual/web-research', () => {
    const result = classifyToolAction('WebFetch');
    expect(result.source).toBe('manual');
    expect(result.category).toBe('web-research');
  });

  it('classifies WebSearch as manual/web-research', () => {
    expect(classifyToolAction('WebSearch').category).toBe('web-research');
  });

  it('classifies Task as manual/task-management', () => {
    expect(classifyToolAction('Task').category).toBe('task-management');
  });

  it('classifies TodoWrite as manual/task-management', () => {
    expect(classifyToolAction('TodoWrite').category).toBe('task-management');
  });

  it('classifies unknown tool as manual/other', () => {
    const result = classifyToolAction('SomeCustomTool');
    expect(result.source).toBe('manual');
    expect(result.category).toBe('other');
  });
});

describe('buildActionDescription — Comprehensive', () => {
  it('describes Bash with command', () => {
    const desc = buildActionDescription('Bash', { command: 'npm test' });
    expect(desc).toBe('npm test');
  });

  it('truncates long Bash commands', () => {
    const longCmd = 'x'.repeat(250);
    const desc = buildActionDescription('Bash', { command: longCmd });
    expect(desc.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(desc).toContain('...');
  });

  it('describes Edit with file_path', () => {
    const desc = buildActionDescription('Edit', { file_path: '/src/app.ts' });
    expect(desc).toBe('Edit: /src/app.ts');
  });

  it('describes Write with file_path', () => {
    const desc = buildActionDescription('Write', { file_path: '/src/new.ts' });
    expect(desc).toBe('Write: /src/new.ts');
  });

  it('describes Read with file_path', () => {
    const desc = buildActionDescription('Read', { file_path: '/src/old.ts' });
    expect(desc).toBe('Read: /src/old.ts');
  });

  it('describes Glob with pattern', () => {
    const desc = buildActionDescription('Glob', { pattern: '**/*.ts' });
    expect(desc).toBe('File search: **/*.ts');
  });

  it('describes Grep with pattern', () => {
    const desc = buildActionDescription('Grep', { pattern: 'TODO' });
    expect(desc).toBe('Code search: TODO');
  });

  it('describes WebFetch with url', () => {
    const desc = buildActionDescription('WebFetch', { url: 'https://api.example.com' });
    expect(desc).toBe('Web fetch: https://api.example.com');
  });

  it('describes WebSearch with query', () => {
    const desc = buildActionDescription('WebSearch', { query: 'node.js streams' });
    expect(desc).toBe('Web search: node.js streams');
  });

  it('describes Task with description', () => {
    const desc = buildActionDescription('Task', { description: 'Run tests' });
    expect(desc).toBe('Sub-agent: Run tests');
  });

  it('falls back to JSON for unknown tools', () => {
    const desc = buildActionDescription('CustomTool', { foo: 'bar' });
    expect(desc).toContain('CustomTool');
    expect(desc).toContain('foo');
  });

  it('truncates long fallback JSON', () => {
    const desc = buildActionDescription('X', { data: 'y'.repeat(200) });
    expect(desc.length).toBeLessThanOrEqual(200);
  });

  it('handles empty input object', () => {
    const desc = buildActionDescription('Bash', {});
    expect(typeof desc).toBe('string');
  });
});

describe('isGitCommand — Comprehensive', () => {
  it('returns true for git commands in Bash', () => {
    expect(isGitCommand('Bash', { command: 'git status' })).toBe(true);
    expect(isGitCommand('Bash', { command: 'git commit -m "fix"' })).toBe(true);
    expect(isGitCommand('Bash', { command: 'git push origin main' })).toBe(true);
  });

  it('returns true for gh commands in Bash', () => {
    expect(isGitCommand('Bash', { command: 'gh pr create' })).toBe(true);
    expect(isGitCommand('Bash', { command: 'gh issue list' })).toBe(true);
  });

  it('returns false for non-git Bash commands', () => {
    expect(isGitCommand('Bash', { command: 'npm test' })).toBe(false);
    expect(isGitCommand('Bash', { command: 'ls -la' })).toBe(false);
  });

  it('returns false for non-Bash tools', () => {
    expect(isGitCommand('Edit', { command: 'git status' })).toBe(false);
    expect(isGitCommand('Read', { command: 'git log' })).toBe(false);
  });

  it('handles missing command', () => {
    expect(isGitCommand('Bash', {})).toBe(false);
  });

  it('handles git with leading whitespace', () => {
    expect(isGitCommand('Bash', { command: '  git status' })).toBe(true);
  });
});

describe('processHookEvent — Comprehensive', () => {
  let db: ShadowingDB;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shadow-hook-'));
    db = new ShadowingDB(join(tmpDir, 'test.db'));
    db.initialize();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates session if none exists', () => {
    const event: HookEvent = {
      event: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    };
    processHookEvent(db, event);

    const session = db.getActiveObservationSession();
    expect(session).not.toBeNull();
    expect(session!.title).toBe('Claude Code Hook Session');
  });

  it('logs PostToolUse actions', () => {
    const event: HookEvent = {
      event: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    };
    processHookEvent(db, event);

    const session = db.getActiveObservationSession()!;
    const actions = db.getObservedActions(session.id);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.source).toBe('shell');
    expect(actions[0]!.command).toBe('npm test');
  });

  it('classifies git commands in Bash correctly', () => {
    processHookEvent(db, {
      event: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
    });

    const session = db.getActiveObservationSession()!;
    const actions = db.getObservedActions(session.id);
    expect(actions[0]!.source).toBe('git');
  });

  it('logs file operations with file_path', () => {
    processHookEvent(db, {
      event: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/src/app.ts', old_string: 'old', new_string: 'new' },
    });

    const session = db.getActiveObservationSession()!;
    const actions = db.getObservedActions(session.id);
    expect(actions[0]!.source).toBe('file');
    expect(actions[0]!.file_path).toBe('/src/app.ts');
  });

  it('handles Stop event', () => {
    processHookEvent(db, {
      event: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
    });
    processHookEvent(db, {
      event: 'Stop',
      stop_reason: 'end_turn',
    });

    const session = db.getActiveObservationSession()!;
    const actions = db.getObservedActions(session.id);
    const stopAction = actions.find(a => a.window_title?.includes('session ended'));
    expect(stopAction).toBeDefined();
    expect(stopAction!.source).toBe('manual');
  });

  it('handles SessionStart event', () => {
    processHookEvent(db, { event: 'SessionStart' });
    const session = db.getActiveObservationSession();
    expect(session).not.toBeNull();
  });

  it('ignores PreToolUse events', () => {
    processHookEvent(db, {
      event: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    const session = db.getActiveObservationSession();
    expect(session).toBeNull();
  });

  it('skips PostToolUse without tool_name', () => {
    processHookEvent(db, { event: 'PostToolUse' });
    const session = db.getActiveObservationSession()!;
    // Session was created but no action logged
    const actions = db.getObservedActions(session.id);
    expect(actions).toHaveLength(0);
  });

  it('reuses existing active session', () => {
    const existing = db.startObservationSession('Existing Session');
    processHookEvent(db, {
      event: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    const session = db.getActiveObservationSession()!;
    expect(session.id).toBe(existing.id);
  });

  it('logs app_name as "Claude Code"', () => {
    processHookEvent(db, {
      event: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/test.ts' },
    });

    const session = db.getActiveObservationSession()!;
    const actions = db.getObservedActions(session.id);
    expect(actions[0]!.app_name).toBe('Claude Code');
  });

  it('handles path input as file_path fallback', () => {
    processHookEvent(db, {
      event: 'PostToolUse',
      tool_name: 'Glob',
      tool_input: { pattern: '*.ts', path: '/src' },
    });

    const session = db.getActiveObservationSession()!;
    const actions = db.getObservedActions(session.id);
    expect(actions[0]!.file_path).toBe('/src');
  });
});
