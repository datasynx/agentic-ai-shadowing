/**
 * Publish approved SOPs into agent context (#28): SKILL.md directories
 * (agentskills.io standard — consumed by Claude Code, Codex, OpenClaw,
 * Hermes) and a managed AGENTS.md index section.
 *
 * Hard rules (non-negotiable, see issue #28):
 *  - Only SOPs with status `approved` are eligible (prompt-injection gate:
 *    generated content must be human-reviewed before it reaches agent
 *    context).
 *  - The anonymizer runs over everything written.
 *  - No silent writes: callers (CLI) must show the planned changes and
 *    confirm; this module only plans and applies.
 *  - AGENTS.md gets an INDEX only (titles + pointers) — Codex caps combined
 *    project docs at 32 KiB with silent drop, Hermes truncates at 20 K chars.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { SOP } from './types.js';
import type { Anonymizer } from './anonymizer.js';

export type PublishTarget = 'claude' | 'agents' | 'hermes';

export interface PublishPlan {
  path: string;
  before: string | null;
  after: string;
}

// ── Parameterization ─────────────────────────────────────────────────────────

export interface ParameterizedContent {
  content: string;
  parameters: Array<{ name: string; example: string; kind: string }>;
}

/**
 * Conservatively lift concrete literals into {{variables}} so a generated
 * skill generalizes beyond the recorded session. Only unambiguous patterns
 * are touched (explicit ports, git branch names after checkout/switch);
 * everything else stays literal — a wrong parameterization is worse than none.
 */
export function parameterizeContent(content: string): ParameterizedContent {
  const parameters: Array<{ name: string; example: string; kind: string }> = [];
  let result = content;

  const lift = (pattern: RegExp, kind: string): void => {
    const seen = new Map<string, string>();
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(result)) !== null) {
      const literal = match[1]!;
      if (literal.startsWith('-') || seen.has(literal)) continue;
      const name = `${kind}_${seen.size + 1}`;
      seen.set(literal, name);
      parameters.push({ name, example: literal, kind });
    }
    for (const [literal, name] of seen) {
      // Replace the captured literal only in its original context to avoid
      // touching unrelated occurrences of short strings.
      result = result.replace(
        new RegExp(`(?<=[\\s:=/'"\`(])${escapeRegExp(literal)}(?=[\\s'"\`).,;:/]|$)`, 'g'),
        `{{${name}}}`,
      );
    }
  };

  // Explicit port numbers in host:port (4-5 digits avoids years/versions)
  lift(/(?:localhost|127\.0\.0\.1|\[internal-ip\]|\[internal-system\]):(\d{4,5})\b/g, 'port');
  // Git branch names after checkout/switch
  lift(/git (?:checkout|switch)(?: -b| -c)? ([\w./-]+)/g, 'branch');

  return { content: result, parameters };
}

function parametersTable(parameters: ParameterizedContent['parameters']): string {
  if (parameters.length === 0) return '';
  const rows = parameters.map(p => `| \`{{${p.name}}}\` | ${p.kind} | \`${p.example}\` |`);
  return [
    '',
    '## Parameters',
    '',
    '| Variable | Kind | Example from recording |',
    '|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

// ── SKILL.md generation ──────────────────────────────────────────────────────

export function skillNameForSOP(sop: SOP): string {
  const slug = sop.title.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 48)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : `sop-${sop.id.substring(0, 8)}`;
}

/** agentskills.io-compliant SKILL.md: minimal frontmatter (name, description). */
export function buildSkillMd(sop: SOP, tags: string[], anonymizer: Anonymizer): string {
  if (sop.status !== 'approved') {
    throw new Error(`SOP "${sop.title}" is ${sop.status} — only approved SOPs can be published.`);
  }

  const safeTitle = anonymizer.anonymize(sop.title);
  const safeDescription = anonymizer.anonymize(sop.description ?? '').replace(/\s+/g, ' ').trim();
  const { content, parameters } = parameterizeContent(anonymizer.anonymize(sop.content_md));

  const description =
    `Use when the task is: ${safeTitle}. ${safeDescription}`.trim().substring(0, 500);

  return [
    '---',
    `name: ${skillNameForSOP(sop)}`,
    `description: ${description.replace(/\n/g, ' ')}`,
    '---',
    '',
    `<!-- Generated from SOP ${sop.id} (v${sop.version}) by @datasynx/agentic-ai-shadowing — re-publish to update -->`,
    '',
    content.trim(),
    parametersTable(parameters),
    tags.length > 0 ? `Tags: ${tags.map(t => `#${t}`).join(' ')}` : '',
    '',
  ].filter(line => line !== null).join('\n').replace(/\n{3,}/g, '\n\n');
}

export function skillPathForTarget(target: PublishTarget, skillName: string, opts: { projectDir: string; homeDir?: string }): string {
  switch (target) {
    case 'claude': return join(opts.projectDir, '.claude', 'skills', skillName, 'SKILL.md');
    // agentskills.io canonical project root — read natively by Codex
    case 'agents': return join(opts.projectDir, '.agents', 'skills', skillName, 'SKILL.md');
    // Hermes has no project-level skills root — global ~/.hermes/skills only
    case 'hermes': return join(opts.homeDir ?? homedir(), '.hermes', 'skills', skillName, 'SKILL.md');
  }
}

// ── AGENTS.md index (managed block) ──────────────────────────────────────────

const INDEX_BEGIN = '<!-- BEGIN shadowing-sops (managed by @datasynx/agentic-ai-shadowing — do not edit inside) -->';
const INDEX_END = '<!-- END shadowing-sops -->';
const INDEX_BUDGET_BYTES = 2048;

export interface IndexEntry { title: string; description: string; skillName: string }

export function buildAgentsMdIndex(entries: IndexEntry[]): string {
  const lines = [
    INDEX_BEGIN,
    '## Standard Operating Procedures (shadowing)',
    '',
  ];
  for (const entry of entries) {
    const oneliner = entry.description.replace(/\s+/g, ' ').trim().substring(0, 120);
    lines.push(`- **${entry.title}** — ${oneliner} (skill: \`${entry.skillName}\`)`);
  }
  lines.push('', INDEX_END);
  let section = lines.join('\n');

  // Hard size budget: drop oldest entries rather than evicting the user's
  // own instructions (Codex 32 KiB cap, silent drop).
  while (Buffer.byteLength(section, 'utf8') > INDEX_BUDGET_BYTES && entries.length > 1) {
    entries = entries.slice(1);
    return buildAgentsMdIndex(entries);
  }
  return section;
}

export function planAgentsMdIndex(projectDir: string, entries: IndexEntry[]): PublishPlan {
  const path = join(projectDir, 'AGENTS.md');
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const section = buildAgentsMdIndex(entries);
  const pattern = new RegExp(`\\n?${escapeRegExp(INDEX_BEGIN)}[\\s\\S]*?${escapeRegExp(INDEX_END)}\\n?`);

  let after: string;
  if (before === null) {
    after = section + '\n';
  } else if (pattern.test(before)) {
    after = before.replace(pattern, '\n' + section + '\n').replace(/^\n+/, '');
  } else {
    after = before.replace(/\n*$/, '\n\n') + section + '\n';
  }
  return { path, before, after };
}

// ── Plan/apply ───────────────────────────────────────────────────────────────

export function planSkillPublish(
  sop: SOP, tags: string[], anonymizer: Anonymizer, target: PublishTarget,
  opts: { projectDir: string; homeDir?: string },
): PublishPlan {
  const content = buildSkillMd(sop, tags, anonymizer);
  const path = skillPathForTarget(target, skillNameForSOP(sop), opts);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  return { path, before, after: content };
}

/** Write a plan to disk. Callers MUST have confirmed with the user first. */
export function applyPublishPlan(plan: PublishPlan): void {
  mkdirSync(dirname(plan.path), { recursive: true });
  writeFileSync(plan.path, plan.after, 'utf8');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
