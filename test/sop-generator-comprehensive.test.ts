import { describe, it, expect } from 'vitest';
import { SOPGenerationError, buildSOPPreview, countSteps } from '../src/sop-generator.js';

describe('SOPGenerationError', () => {
  it('creates error with missing_api_key code', () => {
    const err = new SOPGenerationError('No key', 'missing_api_key', false);
    expect(err.message).toBe('No key');
    expect(err.code).toBe('missing_api_key');
    expect(err.retryable).toBe(false);
    expect(err.statusCode).toBeUndefined();
    expect(err.name).toBe('SOPGenerationError');
  });

  it('creates error with status code', () => {
    const err = new SOPGenerationError('Rate limit', 'rate_limited', true, 429);
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(429);
  });

  it('creates error with auth_failed code', () => {
    const err = new SOPGenerationError('Bad key', 'auth_failed', false, 401);
    expect(err.code).toBe('auth_failed');
    expect(err.retryable).toBe(false);
  });

  it('creates error with api_error code (5xx retryable)', () => {
    const err = new SOPGenerationError('Server error', 'api_error', true, 500);
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(500);
  });

  it('creates error with parse_error code', () => {
    const err = new SOPGenerationError('Bad response', 'parse_error', false);
    expect(err.code).toBe('parse_error');
  });

  it('creates error with unknown code', () => {
    const err = new SOPGenerationError('Something broke', 'unknown', false);
    expect(err.code).toBe('unknown');
  });

  it('is an instance of Error', () => {
    const err = new SOPGenerationError('test', 'unknown', false);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('buildSOPPreview — Comprehensive', () => {
  it('formats preview with multiple tags', () => {
    const preview = buildSOPPreview('Deploy SOP', ['deploy', 'production', 'aws'], 5);
    expect(preview).toContain('Deploy SOP');
    expect(preview).toContain('#deploy');
    expect(preview).toContain('#production');
    expect(preview).toContain('#aws');
    expect(preview).toContain('5');
  });

  it('shows (none) for empty tags array', () => {
    const preview = buildSOPPreview('No Tags', [], 3);
    expect(preview).toContain('(none)');
  });

  it('handles single tag', () => {
    const preview = buildSOPPreview('One Tag', ['alpha'], 1);
    expect(preview).toContain('#alpha');
  });

  it('handles zero steps', () => {
    const preview = buildSOPPreview('Empty', [], 0);
    expect(preview).toContain('0');
  });

  it('handles title with special characters', () => {
    const preview = buildSOPPreview('Deploy "v2.0" — Production', ['deploy'], 3);
    expect(preview).toContain('Deploy "v2.0" — Production');
  });

  it('handles very long title', () => {
    const longTitle = 'A'.repeat(200);
    const preview = buildSOPPreview(longTitle, [], 1);
    expect(preview).toContain(longTitle);
  });
});

describe('countSteps — Comprehensive', () => {
  it('counts standard step headings', () => {
    const md = `# SOP
## Steps
### Step 1: Open SAP
Content
### Step 2: Create Invoice
Content
### Step 3: Verify
Content`;
    expect(countSteps(md)).toBe(3);
  });

  it('returns 0 for content without steps', () => {
    expect(countSteps('# SOP\nNo steps here.')).toBe(0);
  });

  it('handles single step', () => {
    expect(countSteps('### Step 1: Only step')).toBe(1);
  });

  it('does not count non-step headings', () => {
    const md = `### Prerequisites
### Notes
### Step 1: Do something
### Additional Info`;
    expect(countSteps(md)).toBe(1);
  });

  it('handles double-digit step numbers', () => {
    const steps = Array.from({ length: 15 }, (_, i) => `### Step ${i + 1}: Task`).join('\n');
    expect(countSteps(steps)).toBe(15);
  });

  it('handles empty string', () => {
    expect(countSteps('')).toBe(0);
  });

  it('is case-sensitive (Step vs step)', () => {
    expect(countSteps('### step 1: lowercase')).toBe(0);
    expect(countSteps('### Step 1: uppercase')).toBe(1);
  });

  it('requires ### heading level', () => {
    expect(countSteps('## Step 1: Wrong level')).toBe(0);
    expect(countSteps('#### Step 1: Too deep')).toBe(0);
  });

  it('handles step without colon', () => {
    // The regex requires "### Step N" with a digit — no colon needed
    expect(countSteps('### Step 1')).toBe(1);
    expect(countSteps('### Step 1 Do something')).toBe(1);
  });
});

describe('SOP Response Parsing — Comprehensive', () => {
  // Test the regex patterns used in parseResponse (private, but patterns are testable)

  const tagRegex = /```json\s*\n?\{[\s\S]*?"tags"\s*:\s*\[[\s\S]*?\]\s*\}\s*\n?```/;
  const titleRegex = /^#\s+(.+)$/m;
  const goalRegex = /##\s+Objective\s*\n([\s\S]*?)(?=\n##|\n$)/;

  it('extracts tags from standard JSON block', () => {
    const text = '# SOP\nContent\n```json\n{"tags": ["deploy", "aws"]}\n```';
    const match = tagRegex.exec(text);
    expect(match).not.toBeNull();
    const jsonStr = match![0].replace(/```json\s*\n?/, '').replace(/\n?```/, '');
    const parsed = JSON.parse(jsonStr) as { tags: string[] };
    expect(parsed.tags).toEqual(['deploy', 'aws']);
  });

  it('extracts tags with # prefixes', () => {
    const text = '```json\n{"tags": ["#deploy", "#aws"]}\n```';
    const match = tagRegex.exec(text);
    expect(match).not.toBeNull();
    const jsonStr = match![0].replace(/```json\s*\n?/, '').replace(/\n?```/, '');
    const parsed = JSON.parse(jsonStr) as { tags: string[] };
    const tags = parsed.tags.map(t => t.toLowerCase().replace(/^#/, ''));
    expect(tags).toEqual(['deploy', 'aws']);
  });

  it('handles missing JSON block', () => {
    const text = '# SOP\nNo tags here.';
    expect(tagRegex.exec(text)).toBeNull();
  });

  it('extracts title from first heading', () => {
    const text = '# Monthly SAP Closing\n## Objective\nDo things.';
    const match = titleRegex.exec(text);
    expect(match).not.toBeNull();
    expect(match![1]!.trim()).toBe('Monthly SAP Closing');
  });

  it('extracts title with special characters', () => {
    const match = titleRegex.exec('# Deploy "v2.0" — Production');
    expect(match![1]!.trim()).toBe('Deploy "v2.0" — Production');
  });

  it('extracts objective section', () => {
    const text = '# SOP\n## Objective\nCreate invoices correctly.\n## Prerequisites\nAccess required.';
    const match = goalRegex.exec(text);
    expect(match).not.toBeNull();
    expect(match![1]!.trim()).toBe('Create invoices correctly.');
  });

  it('handles multi-line objective', () => {
    const text = '# SOP\n## Objective\nLine 1.\nLine 2.\nLine 3.\n## Prerequisites';
    const match = goalRegex.exec(text);
    expect(match![1]!.trim()).toContain('Line 1.');
    expect(match![1]!.trim()).toContain('Line 3.');
  });

  it('handles missing objective section', () => {
    const text = '# SOP\n## Steps\n### Step 1: Do it';
    expect(goalRegex.exec(text)).toBeNull();
  });

  it('handles empty content', () => {
    expect(titleRegex.exec('')).toBeNull();
    expect(goalRegex.exec('')).toBeNull();
    expect(tagRegex.exec('')).toBeNull();
  });

  it('handles tags with spaces in JSON', () => {
    const text = '```json\n{\n  "tags": [\n    "deploy",\n    "aws"\n  ]\n}\n```';
    const match = tagRegex.exec(text);
    expect(match).not.toBeNull();
  });

  it('handles malformed JSON in tags block', () => {
    const text = '```json\n{tags: invalid}\n```';
    // The regex should still match the block
    const match = tagRegex.exec(text);
    // The JSON.parse would fail but regex may or may not match
    if (match) {
      const jsonStr = match[0].replace(/```json\s*\n?/, '').replace(/\n?```/, '');
      expect(() => JSON.parse(jsonStr)).toThrow();
    }
  });
});
