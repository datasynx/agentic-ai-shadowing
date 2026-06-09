/**
 * Shared SOP response parsing logic (text-mode fallback).
 *
 * Extracts title, description, content_md, and tags from Claude's
 * Markdown+JSON response format. Used by SOPGenerator (as fallback when
 * structured tool output is unavailable) and SessionAnalyzer.
 *
 * Parsing is lenient (CRLF, unfenced JSON, trailing prose) and LOUD:
 * every fallback to a default value is logged as a warning so silent
 * quality degradation is visible (#25).
 */

import { getLogger } from './logger.js';

const log = getLogger('sop-parser');

export interface ParsedSOPResponse {
  title: string;
  description: string;
  content_md: string;
  tags: string[];
}

export function parseSOPResponse(text: string, fallbackTitle: string, fallbackDescription = ''): ParsedSOPResponse {
  const normalized = text.replace(/\r\n/g, '\n');
  let tags: string[] = [];
  let content_md = normalized;

  // Primary: fenced ```json block containing a tags array.
  // Lenient: any fenced block (```/```json5/...) with the same shape.
  const jsonMatch =
    normalized.match(/```json\s*\n?\{[\s\S]*?"tags"\s*:\s*\[[\s\S]*?\]\s*\}\s*\n?```/) ??
    normalized.match(/```\w*\s*\n?\{[\s\S]*?"tags"\s*:\s*\[[\s\S]*?\]\s*\}\s*\n?```/);

  if (jsonMatch) {
    try {
      const jsonStr = jsonMatch[0].replace(/```\w*\s*\n?/, '').replace(/\n?```/, '');
      const parsed = JSON.parse(jsonStr) as { tags: string[] };
      tags = normalizeTags(parsed.tags);
    } catch {
      log.warn('Tags JSON block found but unparseable — SOP will have no tags');
    }
    content_md = normalized.replace(jsonMatch[0], '').trim();
  } else {
    // Last resort: bare (unfenced) JSON object with a tags array
    const bareMatch = normalized.match(/\{[^{}]*"tags"\s*:\s*\[[^\]]*\][^{}]*\}/);
    if (bareMatch) {
      try {
        const parsed = JSON.parse(bareMatch[0]) as { tags: string[] };
        tags = normalizeTags(parsed.tags);
        content_md = normalized.replace(bareMatch[0], '').trim();
      } catch { /* fall through to the no-tags warning below */ }
    }
  }

  if (tags.length === 0) {
    log.warn('No tags found in SOP response');
  }

  const titleMatch = content_md.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1]!.trim() : fallbackTitle;
  if (!titleMatch) {
    log.warn('No title heading found in SOP response — using task title as fallback', {
      fallback_title: fallbackTitle,
    });
  }

  const goalMatch = content_md.match(/##\s+Objective\s*\n([\s\S]*?)(?=\n##|\n$)/);
  const description = goalMatch ? goalMatch[1]!.trim() : fallbackDescription;

  return { title, description, content_md, tags };
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter((t): t is string => typeof t === 'string')
    .map(t => t.toLowerCase().replace(/^#/, '').trim())
    .filter(t => t.length > 0);
}
