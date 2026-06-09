import { describe, it, expect } from 'vitest';
import { suggestTaskBoundaries } from '../src/segmentation.js';
import type { ObservedAction } from '../src/types.js';

let counter = 0;
function action(overrides: Partial<ObservedAction>): ObservedAction {
  counter++;
  return {
    id: `a${counter}`,
    session_id: 's1',
    source: 'shell',
    app_name: null,
    window_title: null,
    command: null,
    file_path: null,
    metadata: null,
    started_at: '2026-06-09 10:00:00',
    ended_at: '2026-06-09 10:00:00',
    duration_seconds: 0,
    ...overrides,
  };
}

describe('suggestTaskBoundaries — synthetic timelines (#29)', () => {
  it('suggests a boundary after an idle gap (default 15 min)', () => {
    const actions = [
      action({ started_at: '2026-06-09 10:00:00', ended_at: '2026-06-09 10:05:00' }),
      action({ started_at: '2026-06-09 10:25:00', ended_at: '2026-06-09 10:26:00' }),
    ];
    const result = suggestTaskBoundaries(actions);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ index: 1, reason: 'idle_gap' });
    expect(result[0]!.detail).toContain('20 min');
  });

  it('does not flag gaps below the threshold', () => {
    const actions = [
      action({ started_at: '2026-06-09 10:00:00', ended_at: '2026-06-09 10:05:00' }),
      action({ started_at: '2026-06-09 10:10:00', ended_at: '2026-06-09 10:11:00' }),
    ];
    expect(suggestTaskBoundaries(actions)).toHaveLength(0);
  });

  it('respects a custom idle threshold', () => {
    const actions = [
      action({ started_at: '2026-06-09 10:00:00', ended_at: '2026-06-09 10:00:30' }),
      action({ started_at: '2026-06-09 10:06:00', ended_at: '2026-06-09 10:06:30' }),
    ];
    expect(suggestTaskBoundaries(actions, { idleGapMinutes: 5 })).toHaveLength(1);
  });

  it('suggests a boundary on git branch switches (but not the first branch seen)', () => {
    const actions = [
      action({ command: 'git checkout feature/login', started_at: '2026-06-09 10:00:00', ended_at: '2026-06-09 10:00:00' }),
      action({ command: 'npm test', started_at: '2026-06-09 10:01:00', ended_at: '2026-06-09 10:01:00' }),
      action({ command: 'git switch feature/billing', started_at: '2026-06-09 10:02:00', ended_at: '2026-06-09 10:02:00' }),
    ];
    const result = suggestTaskBoundaries(actions);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ index: 2, reason: 'branch_switch' });
    expect(result[0]!.detail).toBe('feature/login → feature/billing');
  });

  it('suggests a boundary when cd-ing into a different project root', () => {
    const actions = [
      action({ command: 'cd /home/jane/projects/api', started_at: '2026-06-09 10:00:00', ended_at: '2026-06-09 10:00:00' }),
      action({ command: 'cd /home/jane/projects/api/src', started_at: '2026-06-09 10:01:00', ended_at: '2026-06-09 10:01:00' }),
      action({ command: 'cd /home/jane/clients/acme', started_at: '2026-06-09 10:02:00', ended_at: '2026-06-09 10:02:00' }),
    ];
    const result = suggestTaskBoundaries(actions);
    expect(result.filter(r => r.reason === 'cwd_change')).toHaveLength(1);
  });

  it('returns an empty list for empty or single-action sessions', () => {
    expect(suggestTaskBoundaries([])).toEqual([]);
    expect(suggestTaskBoundaries([action({})])).toEqual([]);
  });

  it('deduplicates: idle gap wins when multiple signals hit the same index', () => {
    const actions = [
      action({ command: 'git checkout main', started_at: '2026-06-09 10:00:00', ended_at: '2026-06-09 10:00:00' }),
      action({ command: 'git checkout feature/x', started_at: '2026-06-09 11:00:00', ended_at: '2026-06-09 11:00:00' }),
    ];
    const result = suggestTaskBoundaries(actions);
    expect(result).toHaveLength(1);
    expect(result[0]!.reason).toBe('idle_gap');
  });
});
