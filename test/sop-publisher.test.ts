import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildSkillMd, skillNameForSOP, skillPathForTarget, parameterizeContent,
  planSkillPublish, planAgentsMdIndex, applyPublishPlan, buildAgentsMdIndex,
} from '../src/sop-publisher.js';
import { Anonymizer } from '../src/anonymizer.js';
import { getDefaultConfig } from '../src/config.js';
import type { SOP } from '../src/types.js';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const anonymizer = new Anonymizer(getDefaultConfig().anonymization);

function makeSOP(overrides?: Partial<SOP>): SOP {
  return {
    id: 'abc123def4567890',
    task_id: 'task1',
    title: 'Deploy the Billing Service',
    description: 'Reliably deploy the billing service to production.',
    content_md: '# Deploy the Billing Service\n## Objective\nDeploy safely.\n## Steps\n### Step 1: Build\nRun `npm run build`.',
    version: 2,
    status: 'approved',
    ai_generated: true,
    reviewed_at: null,
    exported_at: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

let projectDir: string;

beforeEach(() => { projectDir = mkdtempSync(join(tmpdir(), 'shadowing-publish-')); });
afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

describe('approval gate (non-negotiable)', () => {
  for (const status of ['draft', 'reviewed', 'archived'] as const) {
    it(`rejects publishing a ${status} SOP`, () => {
      expect(() => buildSkillMd(makeSOP({ status }), [], anonymizer))
        .toThrowError(/only approved SOPs/);
    });
  }
});

describe('buildSkillMd — agentskills.io compliance', () => {
  it('produces valid frontmatter with name and action-oriented description', () => {
    const skill = buildSkillMd(makeSOP(), ['devops', 'deployment'], anonymizer);
    expect(skill.startsWith('---\n')).toBe(true);
    const frontmatter = skill.split('---')[1]!;
    expect(frontmatter).toContain('name: deploy-the-billing-service');
    expect(frontmatter).toMatch(/description: Use when the task is:/);
    expect(skill).toContain('### Step 1: Build');
    expect(skill).toContain('#devops');
  });

  it('redacts PII/secrets from the published artifact', () => {
    const sop = makeSOP({
      content_md: '# T\n## Steps\nMail jane.doe@example.org, token ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8, host 10.0.0.5',
    });
    const skill = buildSkillMd(sop, [], anonymizer);
    expect(skill).not.toContain('jane.doe@example.org');
    expect(skill).not.toContain('ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');
    expect(skill).not.toContain('10.0.0.5');
  });

  it('derives safe kebab-case skill names', () => {
    expect(skillNameForSOP(makeSOP({ title: 'Reset User‘s Password — (Admin!)' })))
      .toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(skillNameForSOP(makeSOP({ title: '!!!' }))).toBe('sop-abc123de');
  });
});

describe('parameterizeContent — conservative literal lifting', () => {
  it('lifts explicit ports with a parameters table entry', () => {
    const { content, parameters } = parameterizeContent('Open http://localhost:3847/api and localhost:3847 again');
    expect(content).toContain('localhost:{{port_1}}');
    expect(content).not.toContain('3847');
    expect(parameters).toEqual([{ name: 'port_1', example: '3847', kind: 'port' }]);
  });

  it('lifts git branch names', () => {
    const { content, parameters } = parameterizeContent('Run git checkout -b feature/billing-fix then push');
    expect(content).toContain('git checkout -b {{branch_1}}');
    expect(parameters[0]).toMatchObject({ kind: 'branch', example: 'feature/billing-fix' });
  });

  it('leaves ordinary numbers and words alone', () => {
    const text = 'Wait 30 seconds, check version 2.1.0, port is configurable';
    expect(parameterizeContent(text).content).toBe(text);
  });
});

describe('skill paths per target', () => {
  it('maps targets to their documented roots (Hermes: global only — no project root)', () => {
    const opts = { projectDir: '/p', homeDir: '/h' };
    expect(skillPathForTarget('claude', 's', opts)).toBe('/p/.claude/skills/s/SKILL.md');
    expect(skillPathForTarget('agents', 's', opts)).toBe('/p/.agents/skills/s/SKILL.md');
    expect(skillPathForTarget('hermes', 's', opts)).toBe('/h/.hermes/skills/s/SKILL.md');
  });
});

describe('plan + apply', () => {
  it('plans a create, applies it, re-plan is unchanged (idempotent)', () => {
    const sop = makeSOP();
    const plan = planSkillPublish(sop, [], anonymizer, 'claude', { projectDir });
    expect(plan.before).toBeNull();
    applyPublishPlan(plan);
    expect(existsSync(plan.path)).toBe(true);

    const again = planSkillPublish(sop, [], anonymizer, 'claude', { projectDir });
    expect(again.before).toBe(again.after);
  });
});

describe('AGENTS.md index — managed block with size budget', () => {
  it('writes an index, preserves foreign content, idempotent on re-plan', () => {
    writeFileSync(join(projectDir, 'AGENTS.md'), '# My rules\n', 'utf8');
    const entries = [{ title: 'Deploy Billing', description: 'How to deploy.', skillName: 'deploy-billing' }];

    const plan = planAgentsMdIndex(projectDir, entries);
    applyPublishPlan(plan);

    const content = readFileSync(join(projectDir, 'AGENTS.md'), 'utf8');
    expect(content).toContain('# My rules');
    expect(content).toContain('BEGIN shadowing-sops');
    expect(content).toContain('**Deploy Billing**');
    expect(content).toContain('`deploy-billing`');

    const again = planAgentsMdIndex(projectDir, entries);
    expect(again.before).toBe(again.after);
  });

  it('index stays an index: entries are one-liners, section respects the 2 KiB budget', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      title: `SOP number ${i} with a fairly long title for the test`,
      description: 'x'.repeat(300),
      skillName: `sop-${i}`,
    }));
    const section = buildAgentsMdIndex(many);
    expect(Buffer.byteLength(section, 'utf8')).toBeLessThanOrEqual(2048);
    expect(section).not.toContain('x'.repeat(200)); // descriptions truncated
  });

  it('replaces the managed block without duplicating on update', () => {
    const plan1 = planAgentsMdIndex(projectDir, [{ title: 'A', description: 'a', skillName: 'a' }]);
    applyPublishPlan(plan1);
    const plan2 = planAgentsMdIndex(projectDir, [
      { title: 'A', description: 'a', skillName: 'a' },
      { title: 'B', description: 'b', skillName: 'b' },
    ]);
    applyPublishPlan(plan2);

    const content = readFileSync(join(projectDir, 'AGENTS.md'), 'utf8');
    expect(content.match(/BEGIN shadowing-sops/g)).toHaveLength(1);
    expect(content).toContain('**B**');
  });
});
