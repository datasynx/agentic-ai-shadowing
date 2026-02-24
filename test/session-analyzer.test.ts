import { describe, it, expect } from 'vitest';
import { clusterBySilence, summarizeActionGroup } from '../src/session-analyzer.js';
import type { ObservedAction } from '../src/types.js';

// ── Helper: create mock actions ─────────────────────────────────────────────

function makeAction(overrides: Partial<ObservedAction> & { started_at: string; ended_at: string }): ObservedAction {
  return {
    id: Math.random().toString(16).substring(2, 18),
    session_id: 'test-session',
    source: 'window',
    started_at: overrides.started_at,
    ended_at: overrides.ended_at,
    duration_seconds: Math.floor(
      (new Date(overrides.ended_at).getTime() - new Date(overrides.started_at).getTime()) / 1000,
    ),
    created_at: overrides.started_at,
    ...overrides,
  };
}

// ── clusterBySilence ────────────────────────────────────────────────────────

describe('clusterBySilence', () => {
  it('returns empty array for empty input', () => {
    expect(clusterBySilence([])).toEqual([]);
  });

  it('returns single group when no silence gap', () => {
    const actions = [
      makeAction({ started_at: '2025-01-01T10:00:00Z', ended_at: '2025-01-01T10:01:00Z' }),
      makeAction({ started_at: '2025-01-01T10:01:30Z', ended_at: '2025-01-01T10:02:00Z' }),
      makeAction({ started_at: '2025-01-01T10:02:30Z', ended_at: '2025-01-01T10:03:00Z' }),
    ];

    const groups = clusterBySilence(actions, 300);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it('splits groups at silence gap', () => {
    const actions = [
      // Group 1: 10:00 - 10:02
      makeAction({ started_at: '2025-01-01T10:00:00Z', ended_at: '2025-01-01T10:01:00Z' }),
      makeAction({ started_at: '2025-01-01T10:01:30Z', ended_at: '2025-01-01T10:02:00Z' }),
      // 10 minute gap
      // Group 2: 10:12 - 10:14
      makeAction({ started_at: '2025-01-01T10:12:00Z', ended_at: '2025-01-01T10:13:00Z' }),
      makeAction({ started_at: '2025-01-01T10:13:30Z', ended_at: '2025-01-01T10:14:00Z' }),
    ];

    const groups = clusterBySilence(actions, 300); // 5 min threshold
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(2);
    expect(groups[1]).toHaveLength(2);
  });

  it('handles single action', () => {
    const actions = [
      makeAction({ started_at: '2025-01-01T10:00:00Z', ended_at: '2025-01-01T10:01:00Z' }),
    ];

    const groups = clusterBySilence(actions, 300);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(1);
  });

  it('sorts actions by start time', () => {
    // Provide actions out of order
    const actions = [
      makeAction({ started_at: '2025-01-01T10:05:00Z', ended_at: '2025-01-01T10:06:00Z' }),
      makeAction({ started_at: '2025-01-01T10:00:00Z', ended_at: '2025-01-01T10:01:00Z' }),
      makeAction({ started_at: '2025-01-01T10:02:00Z', ended_at: '2025-01-01T10:03:00Z' }),
    ];

    const groups = clusterBySilence(actions, 300);
    expect(groups).toHaveLength(1);
    // All should be in same group (within 5 min of each other)
    expect(groups[0]).toHaveLength(3);
    // Verify sorted order
    expect(new Date(groups[0]![0]!.started_at).getTime())
      .toBeLessThan(new Date(groups[0]![1]!.started_at).getTime());
  });

  it('respects custom silence threshold', () => {
    const actions = [
      makeAction({ started_at: '2025-01-01T10:00:00Z', ended_at: '2025-01-01T10:01:00Z' }),
      // 2 minute gap
      makeAction({ started_at: '2025-01-01T10:03:00Z', ended_at: '2025-01-01T10:04:00Z' }),
    ];

    // With 60s threshold, should split
    const groups60 = clusterBySilence(actions, 60);
    expect(groups60).toHaveLength(2);

    // With 300s threshold, should not split
    const groups300 = clusterBySilence(actions, 300);
    expect(groups300).toHaveLength(1);
  });

  it('creates multiple groups with multiple gaps', () => {
    const actions = [
      makeAction({ started_at: '2025-01-01T09:00:00Z', ended_at: '2025-01-01T09:05:00Z' }),
      // 10 min gap
      makeAction({ started_at: '2025-01-01T09:15:00Z', ended_at: '2025-01-01T09:20:00Z' }),
      // 10 min gap
      makeAction({ started_at: '2025-01-01T09:30:00Z', ended_at: '2025-01-01T09:35:00Z' }),
    ];

    const groups = clusterBySilence(actions, 300);
    expect(groups).toHaveLength(3);
  });
});

// ── summarizeActionGroup ────────────────────────────────────────────────────

describe('summarizeActionGroup', () => {
  it('formats shell actions', () => {
    const actions = [
      makeAction({
        source: 'shell',
        started_at: '2025-01-01T10:00:00Z',
        ended_at: '2025-01-01T10:00:05Z',
        command: 'git status',
        duration_seconds: 5,
      }),
    ];

    const summary = summarizeActionGroup(actions);
    expect(summary).toContain('[10:00:00]');
    expect(summary).toContain('Shell');
    expect(summary).toContain('(5s)');
    expect(summary).toContain('git status');
  });

  it('formats file actions', () => {
    const actions = [
      makeAction({
        source: 'file',
        started_at: '2025-01-01T14:30:00Z',
        ended_at: '2025-01-01T14:30:00Z',
        file_path: '/home/user/project/src/main.ts',
        duration_seconds: 0,
      }),
    ];

    const summary = summarizeActionGroup(actions);
    expect(summary).toContain('[14:30:00]');
    expect(summary).toContain('File');
    expect(summary).toContain('/home/user/project/src/main.ts');
  });

  it('formats git actions', () => {
    const actions = [
      makeAction({
        source: 'git',
        started_at: '2025-01-01T11:00:00Z',
        ended_at: '2025-01-01T11:00:02Z',
        command: 'git commit -m "fix: something"',
        duration_seconds: 2,
      }),
    ];

    const summary = summarizeActionGroup(actions);
    expect(summary).toContain('Git');
    expect(summary).toContain('git commit');
  });

  it('formats window actions', () => {
    const actions = [
      makeAction({
        source: 'window',
        started_at: '2025-01-01T12:00:00Z',
        ended_at: '2025-01-01T12:05:00Z',
        app_name: 'VS Code',
        window_title: 'main.ts — VS Code',
        duration_seconds: 300,
      }),
    ];

    const summary = summarizeActionGroup(actions);
    expect(summary).toContain('Window');
    expect(summary).toContain('VS Code');
    expect(summary).toContain('main.ts');
  });

  it('formats manual notes', () => {
    const actions = [
      makeAction({
        source: 'manual',
        started_at: '2025-01-01T15:00:00Z',
        ended_at: '2025-01-01T15:00:00Z',
        window_title: 'Reviewed the PR changes',
        duration_seconds: 0,
      }),
    ];

    const summary = summarizeActionGroup(actions);
    expect(summary).toContain('Note');
    expect(summary).toContain('Reviewed the PR changes');
  });

  it('handles empty actions', () => {
    const summary = summarizeActionGroup([]);
    expect(summary).toBe('');
  });

  it('joins multiple actions with newlines', () => {
    const actions = [
      makeAction({
        source: 'shell',
        started_at: '2025-01-01T10:00:00Z',
        ended_at: '2025-01-01T10:00:01Z',
        command: 'cd /project',
        duration_seconds: 1,
      }),
      makeAction({
        source: 'shell',
        started_at: '2025-01-01T10:00:05Z',
        ended_at: '2025-01-01T10:00:06Z',
        command: 'npm run test',
        duration_seconds: 1,
      }),
    ];

    const summary = summarizeActionGroup(actions);
    const lines = summary.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('cd /project');
    expect(lines[1]).toContain('npm run test');
  });

  it('uses window_title as fallback for file actions', () => {
    const actions = [
      makeAction({
        source: 'file',
        started_at: '2025-01-01T10:00:00Z',
        ended_at: '2025-01-01T10:00:00Z',
        window_title: 'Editing: main.ts',
        file_path: '/path/main.ts',
        duration_seconds: 0,
      }),
    ];

    const summary = summarizeActionGroup(actions);
    // window_title should take precedence over file_path
    expect(summary).toContain('Editing: main.ts');
  });

  it('omits duration when 0 seconds', () => {
    const actions = [
      makeAction({
        source: 'shell',
        started_at: '2025-01-01T10:00:00Z',
        ended_at: '2025-01-01T10:00:00Z',
        command: 'echo hello',
        duration_seconds: 0,
      }),
    ];

    const summary = summarizeActionGroup(actions);
    expect(summary).not.toContain('(0s)');
    expect(summary).toContain('Shell:');
  });
});
