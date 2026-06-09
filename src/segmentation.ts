/**
 * Task-boundary auto-segmentation (#29).
 *
 * Heuristics over an observed-action timeline that SUGGEST where one task
 * ended and the next began. Suggestions are surfaced in `shadowing analyze`;
 * they never split sessions silently — explicit start/stop markers always win.
 */

import type { ObservedAction } from './types.js';

export interface BoundarySuggestion {
  /** Index into the (chronologically sorted) action list where the new task starts. */
  index: number;
  at: string;
  reason: 'idle_gap' | 'branch_switch' | 'cwd_change';
  detail: string;
}

export interface SegmentationOptions {
  /** Idle minutes between consecutive actions that suggest a boundary (default 15). */
  idleGapMinutes?: number;
}

const BRANCH_RE = /\bgit\s+(?:checkout|switch)\s+(?:-b\s+|-c\s+)?([\w./-]+)/;
const CD_RE = /(?:^|&&|;)\s*cd\s+([^\s;&|]+)/;

/** Top-level project root of a path (first two segments of an absolute path). */
function projectRoot(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(0, 3).join('/');
}

export function suggestTaskBoundaries(actions: ObservedAction[], opts?: SegmentationOptions): BoundarySuggestion[] {
  const idleGapMs = (opts?.idleGapMinutes ?? 15) * 60_000;
  const sorted = [...actions].sort((a, b) => a.started_at.localeCompare(b.started_at));
  const suggestions: BoundarySuggestion[] = [];

  let currentBranch: string | null = null;
  let currentRoot: string | null = null;

  for (let i = 0; i < sorted.length; i++) {
    const action = sorted[i]!;

    // 1. Idle gap between the previous action's end and this action's start
    if (i > 0) {
      const prev = sorted[i - 1]!;
      const gapMs = new Date(action.started_at + 'Z').getTime() - new Date(prev.ended_at + 'Z').getTime();
      if (gapMs >= idleGapMs) {
        suggestions.push({
          index: i,
          at: action.started_at,
          reason: 'idle_gap',
          detail: `${Math.round(gapMs / 60_000)} min of inactivity`,
        });
      }
    }

    if (!action.command) continue;

    // 2. Git branch switch
    const branchMatch = BRANCH_RE.exec(action.command);
    if (branchMatch) {
      const branch = branchMatch[1]!;
      if (currentBranch !== null && branch !== currentBranch && branch !== '-') {
        suggestions.push({
          index: i,
          at: action.started_at,
          reason: 'branch_switch',
          detail: `${currentBranch} → ${branch}`,
        });
      }
      currentBranch = branch === '-' ? currentBranch : branch;
    }

    // 3. cd into a different project root
    const cdMatch = CD_RE.exec(action.command);
    if (cdMatch) {
      const target = cdMatch[1]!;
      if (target.startsWith('/') || target.startsWith('~')) {
        const root = projectRoot(target.replace(/^~/, '/home'));
        if (currentRoot !== null && root !== currentRoot) {
          suggestions.push({
            index: i,
            at: action.started_at,
            reason: 'cwd_change',
            detail: `${currentRoot} → ${root}`,
          });
        }
        currentRoot = root;
      }
    }
  }

  // Deduplicate: one suggestion per index (idle gap wins as strongest signal)
  const byIndex = new Map<number, BoundarySuggestion>();
  for (const s of suggestions) {
    const existing = byIndex.get(s.index);
    if (!existing || (existing.reason !== 'idle_gap' && s.reason === 'idle_gap')) {
      byIndex.set(s.index, s);
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}
