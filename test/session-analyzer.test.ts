import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { clusterBySilence, summarizeActionGroup, SessionAnalyzer } from '../src/session-analyzer.js';
import { ShadowingDB } from '../src/db.js';
import { getDefaultConfig } from '../src/config.js';
import type { ObservedAction } from '../src/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

// ── Helper: create mock actions ─────────────────────────────────────────────

function makeAction(overrides: Partial<ObservedAction> & { started_at: string; ended_at: string }): ObservedAction {
  return {
    id: Math.random().toString(16).substring(2, 18),
    session_id: 'test-session',
    source: 'window',
    started_at: overrides.started_at,
    ended_at: overrides.ended_at,
    duration_seconds: Math.floor(
      (new Date(overrides.ended_at).getTime() - new Date(overrides.started_at).getTime()) / 1000,
    ),
    created_at: overrides.started_at,
    ...overrides,
  };
}

// ── clusterBySilence ────────────────────────────────────────────────────────

describe('clusterBySilence', () => {
  it('returns empty array for empty input', () => {
    expect(clusterBySilence([])).toEqual([]);
  });

  it('returns single group when no silence gap', () => {
    const actions = [
      makeAction({ started_at: '2025-01-01T10:00:00Z', ended_at: '2025-01-01T10:01:00Z' }),
      makeAction({ started_at: '2025-01-01T10:01:30Z', ended_at: '2025-01-01T10:02:00Z' }),
      makeAction({ started_at: '2025-01-01T10:02:30Z', ended_at: '2025-01-01T10:03:00Z' }),
    ];

    const groups = clusterBySilence(actions, 300);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it('splits groups at silence gap', () => {
    const actions = [
      // Group 1: 10:00 - 10:02
      makeAction({ started_at: '2025-01-01T10:00:00Z', ended_at: '2025-01-01T10:01:00Z' }),
      makeAction({ started_at: '2025-01-01T10:01:30Z', ended_at: '2025-01-01T10:02:00Z' }),
      // 10 minute gap
      // Group 2: 10:12 - 10:14
      makeAction({ started_at: '2025-01-01T10:12:00Z', ended_at: '2025-01-01T10:13:00Z' }),
      makeAction({ started_at: '2025-01-01T10:13:30Z', ended_at: '2025-01-01T10:14:00Z' }),
    ];

    const groups = clusterBySilence(actions, 300); // 5 min threshold
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(2);
    expect(groups[1]).toHaveLength(2);
  });

  it('handles single action', () => {
    const actions = [
      makeAction({ started_at: '2025-01-01T10:00:00Z', ended_at: '2025-01-01T10:01:00Z' }),
    ];

    const groups = clusterBySilence(actions, 300);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(1);
  });

  it('sorts actions by start time', () => {
    // Provide actions out of order
    const actions = [
      makeAction({ started_at: '2025-01-01T10:05:00Z', ended_at: '2025-01-01T10:06:00Z' }),
      makeAction({ started_at: '2025-01-01T10:00:00Z', ended_at: '2025-01-01T10:01:00Z' }),
      makeAction({ started_at: '2025-01-01T10:02:00Z', ended_at: '2025-01-01T10:03:00Z' }),
    ];

    const groups = clusterBySilence(actions, 300);
    expect(groups).toHaveLength(1);
    // All should be in same group (within 5 min of each other)
    expect(groups[0]).toHaveLength(3);
    // Verify sorted order
    expect(new Date(groups[0]![0]!.started_at).getTime())
      .toBeLessThan(new Date(groups[0]![1]!.started_at).getTime());
  });

  it('respects custom silence threshold', () => {
    const actions = [
      makeAction({ started_at: '2025-01-01T10:00:00Z', ended_at: '2025-01-01T10:01:00Z' }),
      // 2 minute gap
      makeAction({ started_at: '2025-01-01T10:03:00Z', ended_at: '2025-01-01T10:04:00Z' }),
    ];

    // With 60s threshold, should split
    const groups60 = clusterBySilence(actions, 60);
    expect(groups60).toHaveLength(2);

    // With 300s threshold, should not split
    const groups300 = clusterBySilence(actions, 300);
    expect(groups300).toHaveLength(1);
  });

  it('creates multiple groups with multiple gaps', () => {
    const actions = [
      makeAction({ started_at: '2025-01-01T09:00:00Z', ended_at: '2025-01-01T09:05:00Z' }),
      // 10 min gap
      makeAction({ started_at: '2025-01-01T09:15:00Z', ended_at: '2025-01-01T09:20:00Z' }),
      // 10 min gap
      makeAction({ started_at: '2025-01-01T09:30:00Z', ended_at: '2025-01-01T09:35:00Z' }),
    ];

    const groups = clusterBySilence(actions, 300);
    expect(groups).toHaveLength(3);
  });
});

// ── summarizeActionGroup ────────────────────────────────────────────────────

describe('summarizeActionGroup', () => {
  it('formats shell actions', () => {
    const actions = [
      makeAction({
        source: 'shell',
        started_at: '2025-01-01T10:00:00Z',
        ended_at: '2025-01-01T10:00:05Z',
        command: 'git status',
        duration_seconds: 5,
      }),
    ];

    const summary = summarizeActionGroup(actions);
    expect(summary).toContain('[10:00:00]');
    expect(summary).toContain('Shell');
    expect(summary).toContain('(5s)');
    expect(summary).toContain('git status');
  });

  it('formats file actions', () => {
    const actions = [
      makeAction({
        source: 'file',
        started_at: '2025-01-01T14:30:00Z',
        ended_at: '2025-01-01T14:30:00Z',
        file_path: '/home/user/project/src/main.ts',
        duration_seconds: 0,
      }),
    ];

    const summary = summarizeActionGroup(actions);
    expect(summary).toContain('[14:30:00]');
    expect(summary).toContain('File');
    expect(summary).toContain('/home/user/project/src/main.ts');
  });

  it('formats git actions', () => {
    const actions = [
      makeAction({
        source: 'git',
        started_at: '2025-01-01T11:00:00Z',
        ended_at: '2025-01-01T11:00:02Z',
        command: 'git commit -m "fix: something"',
        duration_seconds: 2,
      }),
    ];

    const summary = summarizeActionGroup(actions);
    expect(summary).toContain('Git');
    expect(summary).toContain('git commit');
  });

  it('formats window actions', () => {
    const actions = [
      makeAction({
        source: 'window',
        started_at: '2025-01-01T12:00:00Z',
        ended_at: '2025-01-01T12:05:00Z',
        app_name: 'VS Code',
        window_title: 'main.ts — VS Code',
        duration_seconds: 300,
      }),
    ];

    const summary = summarizeActionGroup(actions);
    expect(summary).toContain('Window');
    expect(summary).toContain('VS Code');
    expect(summary).toContain('main.ts');
  });

  it('formats manual notes', () => {
    const actions = [
      makeAction({
        source: 'manual',
        started_at: '2025-01-01T15:00:00Z',
        ended_at: '2025-01-01T15:00:00Z',
        window_title: 'Reviewed the PR changes',
        duration_seconds: 0,
      }),
    ];

    const summary = summarizeActionGroup(actions);
    expect(summary).toContain('Note');
    expect(summary).toContain('Reviewed the PR changes');
  });

  it('handles empty actions', () => {
    const summary = summarizeActionGroup([]);
    expect(summary).toBe('');
  });

  it('joins multiple actions with newlines', () => {
    const actions = [
      makeAction({
        source: 'shell',
        started_at: '2025-01-01T10:00:00Z',
        ended_at: '2025-01-01T10:00:01Z',
        command: 'cd /project',
        duration_seconds: 1,
      }),
      makeAction({
        source: 'shell',
        started_at: '2025-01-01T10:00:05Z',
        ended_at: '2025-01-01T10:00:06Z',
        command: 'npm run test',
        duration_seconds: 1,
      }),
    ];

    const summary = summarizeActionGroup(actions);
    const lines = summary.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('cd /project');
    expect(lines[1]).toContain('npm run test');
  });

  it('uses window_title as fallback for file actions', () => {
    const actions = [
      makeAction({
        source: 'file',
        started_at: '2025-01-01T10:00:00Z',
        ended_at: '2025-01-01T10:00:00Z',
        window_title: 'Editing: main.ts',
        file_path: '/path/main.ts',
        duration_seconds: 0,
      }),
    ];

    const summary = summarizeActionGroup(actions);
    // window_title should take precedence over file_path
    expect(summary).toContain('Editing: main.ts');
  });

  it('omits duration when 0 seconds', () => {
    const actions = [
      makeAction({
        source: 'shell',
        started_at: '2025-01-01T10:00:00Z',
        ended_at: '2025-01-01T10:00:00Z',
        command: 'echo hello',
        duration_seconds: 0,
      }),
    ];

    const summary = summarizeActionGroup(actions);
    expect(summary).not.toContain('(0s)');
    expect(summary).toContain('Shell:');
  });
});

// ── analyzeSession — structured SOP output (#25 parity) ─────────────────────

describe('SessionAnalyzer.analyzeSession — structured output', () => {
  const DB_PATH = join(tmpdir(), `shadowing-session-analyzer-${Date.now()}.db`);
  let db: ShadowingDB;

  beforeEach(() => {
    db = new ShadowingDB(DB_PATH);
    db.initialize();
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(DB_PATH); } catch { /* ok */ }
  });

  function message(content: Anthropic.ContentBlock[]): Anthropic.Message {
    return {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
    };
  }

  const TASK_IDENTIFICATION_TEXT =
    '```json\n[{"title":"SAP export","description":"Export and send report","action_blocks":[0],"complexity":2}]\n```';

  function seedSession(): string {
    const session = db.startObservationSession('test');
    db.logObservedAction(session.id, { source: 'shell', command: 'sap-cli export --month 2026-05' });
    db.logObservedAction(session.id, { source: 'manual', window_title: 'sent report to management' });
    return session.id;
  }

  it('requests the emit_sop tool for SOP generation and uses its structured result', async () => {
    const sessionId = seedSession();
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];

    const fakeClient = {
      messages: {
        create: async (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
          calls.push(params);
          if (!params.tools?.length) {
            return message([{ type: 'text', text: TASK_IDENTIFICATION_TEXT, citations: null } as Anthropic.TextBlock]);
          }
          return message([{
            type: 'tool_use',
            id: 'toolu_test',
            name: 'emit_sop',
            input: {
              title: 'SOP: SAP Export',
              description: 'Monthly export procedure',
              content_md: '# SOP: SAP Export\n\n## Steps\n### Step 1: Run export',
              tags: ['sap', 'export', 'monthly'],
            },
          } as Anthropic.ToolUseBlock]);
        },
      },
    };

    const analyzer = new SessionAnalyzer(getDefaultConfig(), db, fakeClient);
    const result = await analyzer.analyzeSession(sessionId);

    expect(result.tasks_created).toHaveLength(1);
    expect(result.sops_generated).toHaveLength(1);

    // The SOP-generation call must force the emit_sop tool (structured output, #25)
    const sopCall = calls[1]!;
    expect(sopCall.tools?.map(t => t.name)).toEqual(['emit_sop']);
    expect(sopCall.tool_choice).toEqual({ type: 'tool', name: 'emit_sop' });

    const sop = db.getSOP(result.sops_generated[0]!.sop_id);
    expect(sop!.title).toBe('SOP: SAP Export');
    expect(sop!.content_md).toContain('### Step 1: Run export');
    expect(db.getTagsForSOP(sop!.id).map(t => t.name).sort()).toEqual(['export', 'monthly', 'sap']);
  });

  it('falls back to text parsing when the response carries no tool block', async () => {
    const sessionId = seedSession();
    let sawToolRequest = false;

    const fakeClient = {
      messages: {
        create: async (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
          if (!params.tools?.length) {
            return message([{ type: 'text', text: TASK_IDENTIFICATION_TEXT, citations: null } as Anthropic.TextBlock]);
          }
          sawToolRequest = true;
          // Model ignored the tool and answered as text (legacy / gateway behavior)
          return message([{
            type: 'text',
            text: '# SOP: Fallback\n\n## Steps\n### Step 1: Do it\n\n```json\n{"tags": ["fallback"]}\n```',
            citations: null,
          } as Anthropic.TextBlock]);
        },
      },
    };

    const analyzer = new SessionAnalyzer(getDefaultConfig(), db, fakeClient);
    const result = await analyzer.analyzeSession(sessionId);

    expect(sawToolRequest).toBe(true);
    expect(result.sops_generated).toHaveLength(1);
    const sop = db.getSOP(result.sops_generated[0]!.sop_id);
    expect(sop!.title).toBe('SOP: Fallback');
  });

  it('honors use_structured_output=false (plain text request, no tools)', async () => {
    const sessionId = seedSession();
    const config = getDefaultConfig();
    config.sop_generation.use_structured_output = false;
    const toolRequests: boolean[] = [];

    const fakeClient = {
      messages: {
        create: async (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
          toolRequests.push(Boolean(params.tools?.length));
          if (toolRequests.length === 1) {
            return message([{ type: 'text', text: TASK_IDENTIFICATION_TEXT, citations: null } as Anthropic.TextBlock]);
          }
          return message([{
            type: 'text',
            text: '# SOP: Plain\n\n## Steps\n### Step 1: Do it\n\n```json\n{"tags": ["plain"]}\n```',
            citations: null,
          } as Anthropic.TextBlock]);
        },
      },
    };

    const analyzer = new SessionAnalyzer(config, db, fakeClient);
    const result = await analyzer.analyzeSession(sessionId);

    expect(toolRequests).toEqual([false, false]);
    expect(result.sops_generated).toHaveLength(1);
  });
});
