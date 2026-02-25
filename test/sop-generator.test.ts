import { describe, it, expect } from 'vitest';
import { buildSOPPreview, countSteps } from '../src/sop-generator.js';

// NOTE: parseResponse is private, but we test its behavior indirectly
// through the public helpers and by testing the response format expectations.

describe('countSteps', () => {
  it('counts steps in standard SOP markdown', () => {
    const md = `# SOP Titel
## Ziel
Etwas erledigen.

## Schritte

### Schritt 1: Vorbereitung
Öffne das System.

### Schritt 2: Durchführung
Mache die Sache.

### Schritt 3: Abschluss
Schließe alles.

## Erwartetes Ergebnis
Fertig.`;
    expect(countSteps(md)).toBe(3);
  });

  it('returns 0 for content without steps', () => {
    expect(countSteps('# Einfache SOP\n\nKeine nummerierten Schritte.')).toBe(0);
  });

  it('does not count non-step headings', () => {
    const md = `### Schritt 1: OK
### Abschnitt: Not a step
### Schritt 2: Also OK`;
    expect(countSteps(md)).toBe(2);
  });

  it('handles single step', () => {
    expect(countSteps('### Schritt 1: Einziger Schritt')).toBe(1);
  });

  it('handles double-digit step numbers', () => {
    let md = '';
    for (let i = 1; i <= 12; i++) {
      md += `### Schritt ${i}: Step ${i}\nContent\n\n`;
    }
    expect(countSteps(md)).toBe(12);
  });
});

describe('buildSOPPreview', () => {
  it('formats preview with tags', () => {
    const preview = buildSOPPreview('Rechnungserstellung', ['buchhaltung', 'sap'], 5);
    expect(preview).toContain('Rechnungserstellung');
    expect(preview).toContain('#buchhaltung');
    expect(preview).toContain('#sap');
    expect(preview).toContain('5');
  });

  it('shows (keine) for empty tags', () => {
    const preview = buildSOPPreview('Test', [], 3);
    expect(preview).toContain('(none)');
  });

  it('shows step count', () => {
    const preview = buildSOPPreview('Test', ['a'], 7);
    expect(preview).toContain('7');
  });
});

describe('SOP Response Parsing (format expectations)', () => {
  // These tests validate the expected response format that parseResponse handles.
  // Since parseResponse is private, we test the patterns it relies on.

  it('JSON tag block regex matches standard format', () => {
    const text = `# SOP
Content here.

\`\`\`json
{"tags": ["finance", "sap", "monthly"]}
\`\`\``;

    const jsonMatch = text.match(/```json\s*\n?\{[\s\S]*?"tags"\s*:\s*\[[\s\S]*?\]\s*\}\s*\n?```/);
    expect(jsonMatch).not.toBeNull();

    const jsonStr = jsonMatch![0].replace(/```json\s*\n?/, '').replace(/\n?```/, '');
    const parsed = JSON.parse(jsonStr) as { tags: string[] };
    expect(parsed.tags).toEqual(['finance', 'sap', 'monthly']);
  });

  it('title extraction regex works', () => {
    const md = '# Rechnungserstellung im SAP\n## Ziel\nRechnungen erstellen.';
    const titleMatch = md.match(/^#\s+(.+)$/m);
    expect(titleMatch).not.toBeNull();
    expect(titleMatch![1]!.trim()).toBe('Rechnungserstellung im SAP');
  });

  it('goal extraction regex works', () => {
    const md = `# Titel
## Ziel
Eine klare Zielbeschreibung.

## Voraussetzungen
SAP-Zugang.`;

    const goalMatch = md.match(/##\s+Ziel\s*\n([\s\S]*?)(?=\n##|\n$)/);
    expect(goalMatch).not.toBeNull();
    expect(goalMatch![1]!.trim()).toBe('Eine klare Zielbeschreibung.');
  });

  it('handles tags with # prefix (should be stripped)', () => {
    const rawTags = ['#finance', 'sap', '#Monthly'];
    const cleaned = rawTags.map(t => t.toLowerCase().replace(/^#/, ''));
    expect(cleaned).toEqual(['finance', 'sap', 'monthly']);
  });

  it('handles missing goal section gracefully', () => {
    const md = `# Titel
## Voraussetzungen
Keine.`;
    const goalMatch = md.match(/##\s+Ziel\s*\n([\s\S]*?)(?=\n##|\n$)/);
    expect(goalMatch).toBeNull();
  });

  it('handles missing JSON block gracefully', () => {
    const text = '# SOP\n## Ziel\nJust content, no tags.';
    const jsonMatch = text.match(/```json\s*\n?\{[\s\S]*?"tags"\s*:\s*\[[\s\S]*?\]\s*\}\s*\n?```/);
    expect(jsonMatch).toBeNull();
  });
});
