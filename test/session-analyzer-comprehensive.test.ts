import { describe, it, expect } from 'vitest';
import { clusterBySilence, summarizeActionGroup } from '../src/session-analyzer.js';
import type { ObservedAction } from '../src/types.js';

function makeAction(overrides: Partial<ObservedAction> = {}): ObservedAction {
  return {
    id: 'test-' + Math.random().toString(36).slice(2),
    session_id: 'session-1',
    source: 'shell',
    app_name: null,
    window_title: null,
    command: 'ls',
    file_path: null,
    metadata: null,
    started_at: '2024-01-01 12:00:00',
    ended_at: '2024-01-01 12:00:10',
    duration_seconds: 10,
    ...overrides,
  };
}

describe('clusterBySilence — Comprehensive', () => {
  it('returns empty for empty actions', () => {
    expect(clusterBySilence([])).toEqual([]);
  });

  it('single action returns one cluster', () => {
    const actions = [makeAction()];
    const clusters = clusterBySilence(actions);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(1);
  });

  it('groups consecutive actions within threshold', () => {
    const actions = [
      makeAction({ started_at: '2024-01-01 12:00:00', ended_at: '2024-01-01 12:00:10' }),
      makeAction({ started_at: '2024-01-01 12:00:15', ended_at: '2024-01-01 12:00:20' }),
      makeAction({ started_at: '2024-01-01 12:00:25', ended_at: '2024-01-01 12:00:30' }),
    ];
    const clusters = clusterBySilence(actions, 60); // 60s threshold
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(3);
  });

  it('splits on silence gaps exceeding threshold', () => {
    const actions = [
      makeAction({ started_at: '2024-01-01 12:00:00', ended_at: '2024-01-01 12:00:10' }),
      makeAction({ started_at: '2024-01-01 12:10:00', ended_at: '2024-01-01 12:10:10' }), // 10 min gap
    ];
    const clusters = clusterBySilence(actions, 300); // 5 min threshold
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toHaveLength(1);
    expect(clusters[1]).toHaveLength(1);
  });

  it('creates multiple clusters for multiple gaps', () => {
    const actions = [
      makeAction({ started_at: '2024-01-01 12:00:00', ended_at: '2024-01-01 12:00:10' }),
      makeAction({ started_at: '2024-01-01 12:00:20', ended_at: '2024-01-01 12:00:30' }), // Same cluster
      makeAction({ started_at: '2024-01-01 12:10:00', ended_at: '2024-01-01 12:10:10' }), // Gap → new cluster
      makeAction({ started_at: '2024-01-01 12:20:00', ended_at: '2024-01-01 12:20:10' }), // Gap → new cluster
    ];
    const clusters = clusterBySilence(actions, 300);
    expect(clusters).toHaveLength(3);
    expect(clusters[0]).toHaveLength(2);
    expect(clusters[1]).toHaveLength(1);
    expect(clusters[2]).toHaveLength(1);
  });

  it('sorts unsorted actions by start time', () => {
    const actions = [
      makeAction({ started_at: '2024-01-01 12:10:00', ended_at: '2024-01-01 12:10:10', command: 'second' }),
      makeAction({ started_at: '2024-01-01 12:00:00', ended_at: '2024-01-01 12:00:10', command: 'first' }),
    ];
    const clusters = clusterBySilence(actions, 600);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]![0]!.command).toBe('first');
    expect(clusters[0]![1]!.command).toBe('second');
  });

  it('uses default threshold of 300 seconds', () => {
    const actions = [
      makeAction({ started_at: '2024-01-01 12:00:00', ended_at: '2024-01-01 12:00:10' }),
      makeAction({ started_at: '2024-01-01 12:04:00', ended_at: '2024-01-01 12:04:10' }), // Within 5 min
      makeAction({ started_at: '2024-01-01 12:10:00', ended_at: '2024-01-01 12:10:10' }), // Over 5 min gap
    ];
    const clusters = clusterBySilence(actions); // Default threshold
    expect(clusters).toHaveLength(2);
  });

  it('handles very small threshold', () => {
    const actions = [
      makeAction({ started_at: '2024-01-01 12:00:00', ended_at: '2024-01-01 12:00:10' }),
      makeAction({ started_at: '2024-01-01 12:00:15', ended_at: '2024-01-01 12:00:20' }),
    ];
    const clusters = clusterBySilence(actions, 1); // 1 second
    expect(clusters).toHaveLength(2);
  });

  it('handles exact threshold boundary', () => {
    const actions = [
      makeAction({ started_at: '2024-01-01 12:00:00', ended_at: '2024-01-01 12:00:00' }),
      makeAction({ started_at: '2024-01-01 12:05:00', ended_at: '2024-01-01 12:05:00' }), // Exactly 300s
    ];
    // Gap of exactly 300s is NOT > threshold, so should be same cluster
    const clusters = clusterBySilence(actions, 300);
    expect(clusters).toHaveLength(1);
  });
});

describe('summarizeActionGroup — Comprehensive', () => {
  it('formats shell commands', () => {
    const actions = [
      makeAction({ source: 'shell', command: 'git status', started_at: '2024-01-01 12:00:00', duration_seconds: 2 }),
    ];
    const summary = summarizeActionGroup(actions);
    expect(summary).toContain('Shell');
    expect(summary).toContain('git status');
    expect(summary).toContain('2s');
  });

  it('formats window events', () => {
    const actions = [
      makeAction({ source: 'window', app_name: 'VS Code', window_title: 'app.ts', started_at: '2024-01-01 14:30:00', duration_seconds: 60 }),
    ];
    const summary = summarizeActionGroup(actions);
    expect(summary).toContain('Window');
    expect(summary).toContain('VS Code');
    expect(summary).toContain('app.ts');
    expect(summary).toContain('14:30:00');
  });

  it('formats file events', () => {
    const actions = [
      makeAction({ source: 'file', file_path: '/src/app.ts', window_title: 'Modified app.ts', started_at: '2024-01-01 12:00:00', duration_seconds: 0 }),
    ];
    const summary = summarizeActionGroup(actions);
    expect(summary).toContain('File');
    expect(summary).toContain('Modified app.ts');
  });

  it('formats file events with file_path fallback', () => {
    const actions = [
      makeAction({ source: 'file', file_path: '/src/app.ts', window_title: null, started_at: '2024-01-01 12:00:00', duration_seconds: 0 }),
    ];
    const summary = summarizeActionGroup(actions);
    expect(summary).toContain('/src/app.ts');
  });

  it('formats git events', () => {
    const actions = [
      makeAction({ source: 'git', command: 'git commit -m "fix bug"', started_at: '2024-01-01 12:00:00', duration_seconds: 3 }),
    ];
    const summary = summarizeActionGroup(actions);
    expect(summary).toContain('Git');
    expect(summary).toContain('git commit');
  });

  it('formats manual notes', () => {
    const actions = [
      makeAction({ source: 'manual', window_title: 'Investigating the issue', started_at: '2024-01-01 12:00:00', duration_seconds: 0 }),
    ];
    const summary = summarizeActionGroup(actions);
    expect(summary).toContain('Note');
    expect(summary).toContain('Investigating the issue');
  });

  it('handles actions with zero duration', () => {
    const actions = [
      makeAction({ source: 'shell', command: 'echo hi', started_at: '2024-01-01 12:00:00', duration_seconds: 0 }),
    ];
    const summary = summarizeActionGroup(actions);
    expect(summary).not.toContain('0s');
  });

  it('handles window event without app_name', () => {
    const actions = [
      makeAction({ source: 'window', app_name: null, window_title: 'Untitled', started_at: '2024-01-01 12:00:00', duration_seconds: 0 }),
    ];
    const summary = summarizeActionGroup(actions);
    expect(summary).toContain('unknown');
    expect(summary).toContain('Untitled');
  });

  it('handles manual note without title', () => {
    const actions = [
      makeAction({ source: 'manual', window_title: null, started_at: '2024-01-01 12:00:00', duration_seconds: 0 }),
    ];
    const summary = summarizeActionGroup(actions);
    expect(summary).toContain('Note');
  });

  it('formats multiple actions in chronological order', () => {
    const actions = [
      makeAction({ source: 'shell', command: 'cmd1', started_at: '2024-01-01 12:00:00', duration_seconds: 0 }),
      makeAction({ source: 'shell', command: 'cmd2', started_at: '2024-01-01 12:01:00', duration_seconds: 0 }),
      makeAction({ source: 'window', app_name: 'Chrome', window_title: 'Browser', started_at: '2024-01-01 12:02:00', duration_seconds: 0 }),
    ];
    const summary = summarizeActionGroup(actions);
    const lines = summary.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('cmd1');
    expect(lines[1]).toContain('cmd2');
    expect(lines[2]).toContain('Chrome');
  });

  it('handles empty actions array', () => {
    const summary = summarizeActionGroup([]);
    expect(summary).toBe('');
  });
});
