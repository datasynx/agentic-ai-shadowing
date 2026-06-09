import { describe, it, expect } from 'vitest';
import { parseSOPResponse } from '../src/sop-parser.js';

const SOP_BODY = '# Reset User Password\n## Objective\nReset a locked account.\n## Steps\n### Step 1: Open admin panel\nDo it.';

describe('parseSOPResponse — lenient fallback parsing (#25)', () => {
  it('parses the canonical format (fenced json block at the end)', () => {
    const result = parseSOPResponse(`${SOP_BODY}\n\n\`\`\`json\n{"tags": ["it-support", "Identity"]}\n\`\`\``, 'fallback');
    expect(result.title).toBe('Reset User Password');
    expect(result.description).toBe('Reset a locked account.');
    expect(result.tags).toEqual(['it-support', 'identity']);
    expect(result.content_md).not.toContain('```json');
  });

  it('tolerates CRLF line endings', () => {
    const crlf = `${SOP_BODY}\r\n\r\n\`\`\`json\r\n{"tags": ["windows"]}\r\n\`\`\``.replace(/\n/g, '\r\n');
    const result = parseSOPResponse(crlf, 'fallback');
    expect(result.title).toBe('Reset User Password');
    expect(result.tags).toEqual(['windows']);
  });

  it('tolerates trailing prose after the json block', () => {
    const result = parseSOPResponse(
      `${SOP_BODY}\n\n\`\`\`json\n{"tags": ["ops"]}\n\`\`\`\n\nLet me know if you need anything else!`,
      'fallback',
    );
    expect(result.tags).toEqual(['ops']);
  });

  it('tolerates a fence without the json language tag', () => {
    const result = parseSOPResponse(`${SOP_BODY}\n\n\`\`\`\n{"tags": ["bare-fence"]}\n\`\`\``, 'fallback');
    expect(result.tags).toEqual(['bare-fence']);
  });

  it('finds a bare unfenced tags object', () => {
    const result = parseSOPResponse(`${SOP_BODY}\n\n{"tags": ["unfenced"]}`, 'fallback');
    expect(result.tags).toEqual(['unfenced']);
    expect(result.content_md).not.toContain('"tags"');
  });

  it('returns empty tags (not a crash) when no JSON exists', () => {
    const result = parseSOPResponse(SOP_BODY, 'fallback');
    expect(result.tags).toEqual([]);
    expect(result.title).toBe('Reset User Password');
  });

  it('uses the fallback title when no heading exists', () => {
    const result = parseSOPResponse('Just prose, no heading.', 'Task Title');
    expect(result.title).toBe('Task Title');
  });

  it('drops non-string and empty tags', () => {
    const result = parseSOPResponse(`${SOP_BODY}\n\n\`\`\`json\n{"tags": ["ok", "", "#Stripped", 42]}\n\`\`\``, 'fallback');
    expect(result.tags).toEqual(['ok', 'stripped']);
  });
});
