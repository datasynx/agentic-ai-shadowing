/**
 * Shared SOP response parsing logic.
 *
 * Extracts title, description, content_md, and tags from Claude's
 * Markdown+JSON response format. Used by both SOPGenerator and SessionAnalyzer.
 */

export interface ParsedSOPResponse {
  title: string;
  description: string;
  content_md: string;
  tags: string[];
}

export function parseSOPResponse(text: string, fallbackTitle: string, fallbackDescription = ''): ParsedSOPResponse {
  let tags: string[] = [];
  let content_md = text;

  const jsonMatch = text.match(/```json\s*\n?\{[\s\S]*?"tags"\s*:\s*\[[\s\S]*?\]\s*\}\s*\n?```/);
  if (jsonMatch) {
    try {
      const jsonStr = jsonMatch[0].replace(/```json\s*\n?/, '').replace(/\n?```/, '');
      const parsed = JSON.parse(jsonStr) as { tags: string[] };
      tags = parsed.tags.map(t => t.toLowerCase().replace(/^#/, ''));
    } catch { /* no tags */ }
    content_md = text.replace(jsonMatch[0], '').trim();
  }

  const titleMatch = content_md.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1]!.trim() : fallbackTitle;

  const goalMatch = content_md.match(/##\s+Objective\s*\n([\s\S]*?)(?=\n##|\n$)/);
  const description = goalMatch ? goalMatch[1]!.trim() : fallbackDescription;

  return { title, description, content_md, tags };
}
