// ── Simple line-based diff (no external deps) ───────────────────────────────

export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffResult {
  lines: DiffLine[];
  addedCount: number;
  removedCount: number;
  unchangedCount: number;
}

/**
 * Compute a line-based diff between two texts using the Myers diff algorithm
 * (simplified LCS approach). Returns colored lines suitable for terminal output.
 */
export function diffTexts(oldText: string, newText: string): DiffResult {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const lcs = computeLCS(oldLines, newLines);
  const lines: DiffLine[] = [];

  let oi = 0;
  let ni = 0;
  let li = 0;
  let oldLineNum = 1;
  let newLineNum = 1;

  while (oi < oldLines.length || ni < newLines.length) {
    if (li < lcs.length && oi < oldLines.length && ni < newLines.length && oldLines[oi] === lcs[li] && newLines[ni] === lcs[li]) {
      lines.push({ type: 'unchanged', content: oldLines[oi]!, oldLine: oldLineNum, newLine: newLineNum });
      oi++; ni++; li++; oldLineNum++; newLineNum++;
    } else if (oi < oldLines.length && (li >= lcs.length || oldLines[oi] !== lcs[li])) {
      lines.push({ type: 'removed', content: oldLines[oi]!, oldLine: oldLineNum });
      oi++; oldLineNum++;
    } else if (ni < newLines.length && (li >= lcs.length || newLines[ni] !== lcs[li])) {
      lines.push({ type: 'added', content: newLines[ni]!, newLine: newLineNum });
      ni++; newLineNum++;
    }
  }

  return {
    lines,
    addedCount: lines.filter(l => l.type === 'added').length,
    removedCount: lines.filter(l => l.type === 'removed').length,
    unchangedCount: lines.filter(l => l.type === 'unchanged').length,
  };
}

/**
 * Format diff result for terminal output with ANSI colors.
 */
export function formatDiff(diff: DiffResult, contextLines = 3): string {
  const output: string[] = [];

  // Find ranges that contain changes, with context
  const changeIndices = diff.lines
    .map((l, i) => l.type !== 'unchanged' ? i : -1)
    .filter(i => i >= 0);

  if (changeIndices.length === 0) {
    return '  (no changes)\n';
  }

  // Build display ranges
  const ranges: Array<{ start: number; end: number }> = [];
  let rangeStart = Math.max(0, changeIndices[0]! - contextLines);
  let rangeEnd = Math.min(diff.lines.length - 1, changeIndices[0]! + contextLines);

  for (let i = 1; i < changeIndices.length; i++) {
    const idx = changeIndices[i]!;
    if (idx - contextLines <= rangeEnd + 1) {
      rangeEnd = Math.min(diff.lines.length - 1, idx + contextLines);
    } else {
      ranges.push({ start: rangeStart, end: rangeEnd });
      rangeStart = Math.max(0, idx - contextLines);
      rangeEnd = Math.min(diff.lines.length - 1, idx + contextLines);
    }
  }
  ranges.push({ start: rangeStart, end: rangeEnd });

  for (const range of ranges) {
    if (range.start > 0) output.push('  ...');
    for (let i = range.start; i <= range.end; i++) {
      const line = diff.lines[i]!;
      switch (line.type) {
        case 'added':
          output.push(`\x1b[32m+ ${line.content}\x1b[0m`);
          break;
        case 'removed':
          output.push(`\x1b[31m- ${line.content}\x1b[0m`);
          break;
        case 'unchanged':
          output.push(`  ${line.content}`);
          break;
      }
    }
    if (range.end < diff.lines.length - 1) output.push('  ...');
  }

  output.push('');
  output.push(`  \x1b[32m+${diff.addedCount}\x1b[0m / \x1b[31m-${diff.removedCount}\x1b[0m lines`);

  return output.join('\n') + '\n';
}

// ── LCS (Longest Common Subsequence) ─────────────────────────────────────────

function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;

  // DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack
  const result: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]!);
      i--; j--;
    } else if (dp[i - 1]![j]! > dp[i]![j - 1]!) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}
