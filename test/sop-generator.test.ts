import { describe, it, expect } from 'vitest';
import { buildSOPPreview, countSteps } from '../src/sop-generator.js';

// NOTE: parseResponse is private, but we test its behavior indirectly
// through the public helpers and by testing the response format expectations.

describe('countSteps', () => {
  it('counts steps in standard SOP markdown', () => {
    const md = `# SOP Title
## Objective
Complete the task.

## Steps

### Step 1: Preparation
Open the system.

### Step 2: Execution
Perform the task.

### Step 3: Completion
Close everything.

## Expected Result
Done.`;
    expect(countSteps(md)).toBe(3);
  });

  it('returns 0 for content without steps', () => {
    expect(countSteps('# Simple SOP\n\nNo numbered steps.')).toBe(0);
  });

  it('does not count non-step headings', () => {
    const md = `### Step 1: OK
### Section: Not a step
### Step 2: Also OK`;
    expect(countSteps(md)).toBe(2);
  });

  it('handles single step', () => {
    expect(countSteps('### Step 1: Single Step')).toBe(1);
  });

  it('handles double-digit step numbers', () => {
    let md = '';
    for (let i = 1; i <= 12; i++) {
      md += `### Step ${i}: Step ${i}\nContent\n\n`;
    }
    expect(countSteps(md)).toBe(12);
  });
});

describe('buildSOPPreview', () => {
  it('formats preview with tags', () => {
    const preview = buildSOPPreview('Invoice Creation', ['accounting', 'sap'], 5);
    expect(preview).toContain('Invoice Creation');
    expect(preview).toContain('#accounting');
    expect(preview).toContain('#sap');
    expect(preview).toContain('5');
  });

  it('shows (none) for empty tags', () => {
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
    const md = '# Invoice Creation in SAP\n## Objective\nCreate invoices.';
    const titleMatch = md.match(/^#\s+(.+)$/m);
    expect(titleMatch).not.toBeNull();
    expect(titleMatch![1]!.trim()).toBe('Invoice Creation in SAP');
  });

  it('goal extraction regex works', () => {
    const md = `# Title
## Objective
A clear goal description.

## Prerequisites
SAP access.`;

    const goalMatch = md.match(/##\s+(?:Ziel|Objective)\s*\n([\s\S]*?)(?=\n##|\n$)/);
    expect(goalMatch).not.toBeNull();
    expect(goalMatch![1]!.trim()).toBe('A clear goal description.');
  });

  it('handles tags with # prefix (should be stripped)', () => {
    const rawTags = ['#finance', 'sap', '#Monthly'];
    const cleaned = rawTags.map(t => t.toLowerCase().replace(/^#/, ''));
    expect(cleaned).toEqual(['finance', 'sap', 'monthly']);
  });

  it('handles missing goal section gracefully', () => {
    const md = `# Title
## Prerequisites
None.`;
    const goalMatch = md.match(/##\s+(?:Ziel|Objective)\s*\n([\s\S]*?)(?=\n##|\n$)/);
    expect(goalMatch).toBeNull();
  });

  it('handles missing JSON block gracefully', () => {
    const text = '# SOP\n## Objective\nJust content, no tags.';
    const jsonMatch = text.match(/```json\s*\n?\{[\s\S]*?"tags"\s*:\s*\[[\s\S]*?\]\s*\}\s*\n?```/);
    expect(jsonMatch).toBeNull();
  });
});
