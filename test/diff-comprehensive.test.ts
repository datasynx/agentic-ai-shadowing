import { describe, it, expect } from 'vitest';
import { diffTexts, formatDiff } from '../src/diff.js';

describe('diffTexts — Comprehensive', () => {
  it('identical single-line texts have no changes', () => {
    const result = diffTexts('hello', 'hello');
    expect(result.addedCount).toBe(0);
    expect(result.removedCount).toBe(0);
    expect(result.unchangedCount).toBe(1);
  });

  it('identical multi-line texts have no changes', () => {
    const text = 'line1\nline2\nline3';
    const result = diffTexts(text, text);
    expect(result.addedCount).toBe(0);
    expect(result.removedCount).toBe(0);
    expect(result.unchangedCount).toBe(3);
  });

  it('detects single added line at end', () => {
    const result = diffTexts('a\nb', 'a\nb\nc');
    expect(result.addedCount).toBe(1);
    expect(result.removedCount).toBe(0);
    const added = result.lines.filter(l => l.type === 'added');
    expect(added[0]!.content).toBe('c');
  });

  it('detects single added line at start', () => {
    const result = diffTexts('b\nc', 'a\nb\nc');
    expect(result.addedCount).toBe(1);
    const added = result.lines.filter(l => l.type === 'added');
    expect(added[0]!.content).toBe('a');
  });

  it('detects single added line in middle', () => {
    const result = diffTexts('a\nc', 'a\nb\nc');
    expect(result.addedCount).toBe(1);
  });

  it('detects single removed line', () => {
    const result = diffTexts('a\nb\nc', 'a\nc');
    expect(result.removedCount).toBe(1);
    const removed = result.lines.filter(l => l.type === 'removed');
    expect(removed[0]!.content).toBe('b');
  });

  it('detects replaced line as remove+add', () => {
    const result = diffTexts('a\nold\nc', 'a\nnew\nc');
    expect(result.removedCount).toBe(1);
    expect(result.addedCount).toBe(1);
  });

  it('handles completely different texts', () => {
    const result = diffTexts('foo\nbar', 'baz\nqux');
    expect(result.removedCount).toBe(2);
    expect(result.addedCount).toBe(2);
    expect(result.unchangedCount).toBe(0);
  });

  it('handles both texts empty', () => {
    const result = diffTexts('', '');
    expect(result.addedCount).toBe(0);
    expect(result.removedCount).toBe(0);
    expect(result.unchangedCount).toBe(1); // One empty line
  });

  it('handles old text empty, new has content', () => {
    const result = diffTexts('', 'new');
    // Empty string splits to [''], so old has one empty line
    expect(result.lines.length).toBeGreaterThan(0);
  });

  it('handles new text empty, old has content', () => {
    const result = diffTexts('old', '');
    expect(result.lines.length).toBeGreaterThan(0);
  });

  it('assigns correct line numbers', () => {
    const result = diffTexts('a\nb\nc', 'a\nx\nc');
    for (const line of result.lines) {
      if (line.type === 'unchanged' || line.type === 'removed') {
        expect(line.oldLine).toBeDefined();
        expect(line.oldLine).toBeGreaterThan(0);
      }
      if (line.type === 'unchanged' || line.type === 'added') {
        expect(line.newLine).toBeDefined();
        expect(line.newLine).toBeGreaterThan(0);
      }
    }
  });

  it('handles large identical text efficiently', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const result = diffTexts(lines, lines);
    expect(result.unchangedCount).toBe(500);
    expect(result.addedCount).toBe(0);
  });

  it('handles multiple scattered changes', () => {
    const old = 'a\nb\nc\nd\ne\nf';
    const newText = 'a\nB\nc\nD\ne\nF';
    const result = diffTexts(old, newText);
    expect(result.removedCount).toBe(3);
    expect(result.addedCount).toBe(3);
    expect(result.unchangedCount).toBe(3);
  });

  it('handles trailing newlines', () => {
    const result = diffTexts('a\nb\n', 'a\nb\n');
    // Trailing \n creates an empty line at the end
    expect(result.unchangedCount).toBe(3); // 'a', 'b', ''
  });

  it('detects real SOP changes correctly', () => {
    const oldSOP = `# Invoice SOP
## Objective
Create invoices.
## Steps
### Step 1: Open SAP
Login.
### Step 2: Create
Fill form.`;

    const newSOP = `# Invoice SOP
## Objective
Create and validate invoices.
## Prerequisites
SAP access required.
## Steps
### Step 1: Open SAP
Login.
### Step 2: Create
Fill form.
### Step 3: Validate
Check for errors.`;

    const result = diffTexts(oldSOP, newSOP);
    expect(result.addedCount).toBeGreaterThan(0);
    expect(result.unchangedCount).toBeGreaterThan(0);
    expect(result.removedCount).toBeGreaterThan(0);
  });
});

describe('formatDiff — Comprehensive', () => {
  it('returns "(no changes)" for identical texts', () => {
    const result = diffTexts('same\ntext', 'same\ntext');
    const formatted = formatDiff(result);
    expect(formatted).toContain('no changes');
  });

  it('uses green ANSI for additions', () => {
    const result = diffTexts('a', 'a\nb');
    const formatted = formatDiff(result);
    expect(formatted).toContain('\x1b[32m');
  });

  it('uses red ANSI for removals', () => {
    const result = diffTexts('a\nb', 'a');
    const formatted = formatDiff(result);
    expect(formatted).toContain('\x1b[31m');
  });

  it('shows + and - with line content', () => {
    const result = diffTexts('old', 'new');
    const formatted = formatDiff(result);
    expect(formatted).toContain('+ new');
    expect(formatted).toContain('- old');
  });

  it('shows statistics line', () => {
    const result = diffTexts('a\nb', 'a\nc\nd');
    const formatted = formatDiff(result);
    expect(formatted).toContain('lines');
  });

  it('context=0 shows only changed lines', () => {
    const old = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    const newText = old.replace('line5', 'CHANGED');
    const result = diffTexts(old, newText);
    const formatted = formatDiff(result, 0);
    // Should have fewer lines than with default context
    const lines = formatted.split('\n').filter(l => l.trim().length > 0);
    expect(lines.length).toBeLessThan(10);
  });

  it('context=0 still shows ellipsis', () => {
    const old = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const newText = old.replace('line10', 'CHANGED');
    const result = diffTexts(old, newText);
    const formatted = formatDiff(result, 0);
    expect(formatted).toContain('...');
  });

  it('large context shows all lines around changes', () => {
    const old = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    const newText = old.replace('line5', 'CHANGED');
    const result = diffTexts(old, newText);
    const formatted = formatDiff(result, 100);
    // With context=100, all lines should be visible
    expect(formatted).toContain('line0');
    expect(formatted).toContain('line9');
  });

  it('handles multiple separated change regions', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i}`);
    const oldText = lines.join('\n');
    lines[5] = 'CHANGED5';
    lines[25] = 'CHANGED25';
    const newText = lines.join('\n');
    const result = diffTexts(oldText, newText);
    const formatted = formatDiff(result, 1);

    // Should have two separate sections with ellipsis between
    const ellipsisCount = (formatted.match(/\.\.\./g) || []).length;
    expect(ellipsisCount).toBeGreaterThanOrEqual(2);
  });
});
