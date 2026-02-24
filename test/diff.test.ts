import { describe, it, expect } from 'vitest';
import { diffTexts, formatDiff } from '../src/diff.js';

describe('diffTexts', () => {
  it('detects no changes in identical texts', () => {
    const result = diffTexts('hello\nworld', 'hello\nworld');
    expect(result.addedCount).toBe(0);
    expect(result.removedCount).toBe(0);
    expect(result.unchangedCount).toBe(2);
  });

  it('detects added lines', () => {
    const result = diffTexts('line1\nline3', 'line1\nline2\nline3');
    expect(result.addedCount).toBe(1);
    expect(result.removedCount).toBe(0);
    const added = result.lines.filter(l => l.type === 'added');
    expect(added[0]!.content).toBe('line2');
  });

  it('detects removed lines', () => {
    const result = diffTexts('line1\nline2\nline3', 'line1\nline3');
    expect(result.removedCount).toBe(1);
    expect(result.addedCount).toBe(0);
    const removed = result.lines.filter(l => l.type === 'removed');
    expect(removed[0]!.content).toBe('line2');
  });

  it('detects changed lines', () => {
    const result = diffTexts('old line', 'new line');
    expect(result.removedCount).toBe(1);
    expect(result.addedCount).toBe(1);
  });

  it('handles empty old text', () => {
    const result = diffTexts('', 'new content');
    expect(result.addedCount).toBe(1);
    expect(result.removedCount).toBe(1); // empty line removed
  });

  it('handles empty new text', () => {
    const result = diffTexts('old content', '');
    expect(result.removedCount).toBe(1);
    expect(result.addedCount).toBe(1); // empty line added
  });

  it('handles multi-line SOP changes', () => {
    const oldSOP = `# SOP: Rechnungserstellung
## Ziel
Rechnungen erstellen.

## Schritte
### Schritt 1: SAP öffnen
Melde dich im SAP an.

### Schritt 2: Rechnung anlegen
Lege eine neue Rechnung an.`;

    const newSOP = `# SOP: Rechnungserstellung
## Ziel
Rechnungen korrekt erstellen und prüfen.

## Schritte
### Schritt 1: SAP öffnen
Melde dich im SAP an.

### Schritt 2: Rechnung anlegen
Lege eine neue Rechnung an.

### Schritt 3: Rechnung prüfen
Prüfe die Rechnung auf Korrektheit.`;

    const result = diffTexts(oldSOP, newSOP);
    expect(result.addedCount).toBeGreaterThan(0);
    expect(result.unchangedCount).toBeGreaterThan(0);
    // The goal line changed
    const removed = result.lines.filter(l => l.type === 'removed');
    expect(removed.some(l => l.content.includes('Rechnungen erstellen.'))).toBe(true);
    const added = result.lines.filter(l => l.type === 'added');
    expect(added.some(l => l.content.includes('korrekt erstellen'))).toBe(true);
  });
});

describe('formatDiff', () => {
  it('returns no-change message for identical texts', () => {
    const result = diffTexts('same', 'same');
    const formatted = formatDiff(result);
    expect(formatted).toContain('keine Änderungen');
  });

  it('uses ANSI colors for changes', () => {
    const result = diffTexts('old', 'new');
    const formatted = formatDiff(result);
    expect(formatted).toContain('\x1b[31m'); // red for removed
    expect(formatted).toContain('\x1b[32m'); // green for added
  });

  it('shows change statistics', () => {
    const result = diffTexts('a\nb\nc', 'a\nB\nc');
    const formatted = formatDiff(result);
    expect(formatted).toContain('+1');
    expect(formatted).toContain('-1');
    expect(formatted).toContain('Zeilen');
  });

  it('respects context lines parameter', () => {
    const old = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const newText = old.replace('line 10', 'CHANGED');
    const result = diffTexts(old, newText);

    const formatted1 = formatDiff(result, 1);
    const formatted5 = formatDiff(result, 5);
    expect(formatted5.length).toBeGreaterThan(formatted1.length);
  });
});
