import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { SOPGenerator, type AnthropicLikeClient } from '../src/sop-generator.js';
import { createAnthropicClient } from '../src/anthropic-client.js';
import { SOPGenerationError } from '../src/errors.js';
import { ShadowingDB } from '../src/db.js';
import { getDefaultConfig } from '../src/config.js';
import type { ShadowingConfig, Task } from '../src/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `shadowing-sop-structured-${Date.now()}.db`);

let db: ShadowingDB;
let task: Task;

beforeEach(() => {
  db = new ShadowingDB(DB_PATH);
  db.initialize();
  task = db.createTask('Deploy the API service', 'Steps noted during work');
});

afterEach(() => {
  db.close();
  try { unlinkSync(DB_PATH); } catch { /* ok */ }
});

function makeMessage(content: Anthropic.ContentBlock[]): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content,
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 200 },
  } as Anthropic.Message;
}

function fakeClient(content: Anthropic.ContentBlock[], capture?: { params?: Anthropic.MessageCreateParamsNonStreaming }): AnthropicLikeClient {
  return {
    messages: {
      create: (params) => {
        if (capture) capture.params = params;
        return Promise.resolve(makeMessage(content));
      },
    },
  };
}

const TOOL_USE_BLOCK = {
  type: 'tool_use',
  id: 'toolu_1',
  name: 'emit_sop',
  input: {
    title: 'Deploy the API Service',
    description: 'Reliably deploy the API service to production.',
    content_md: '# Deploy the API Service\n## Objective\nReliably deploy.\n## Steps\n### Step 1: Build\nRun the build.',
    tags: ['#DevOps', 'deployment', '  ', 'CI'],
  },
} as unknown as Anthropic.ContentBlock;

describe('SOPGenerator — structured output (#25)', () => {
  it('uses the tool-use result on the happy path (no regex parsing)', async () => {
    const capture: { params?: Anthropic.MessageCreateParamsNonStreaming } = {};
    const gen = new SOPGenerator(getDefaultConfig(), db, fakeClient([TOOL_USE_BLOCK], capture));

    const result = await gen.generateSOP(task);

    expect(result.title).toBe('Deploy the API Service');
    expect(result.description).toBe('Reliably deploy the API service to production.');
    expect(result.content_md).toContain('### Step 1: Build');
    // Tags normalized: lowercase, '#' stripped, empties dropped
    expect(result.tags).toEqual(['devops', 'deployment', 'ci']);

    // Request actually asked for the tool
    expect(capture.params?.tools?.[0]?.name).toBe('emit_sop');
    expect(capture.params?.tool_choice).toEqual({ type: 'tool', name: 'emit_sop' });
  });

  it('falls back to text parsing when no tool_use block is present', async () => {
    const textBlock = {
      type: 'text',
      text: '# Fallback SOP\n## Objective\nParsed from text.\n\n```json\n{"tags": ["fallback"]}\n```',
      citations: null,
    } as unknown as Anthropic.ContentBlock;
    const gen = new SOPGenerator(getDefaultConfig(), db, fakeClient([textBlock]));

    const result = await gen.generateSOP(task);
    expect(result.title).toBe('Fallback SOP');
    expect(result.tags).toEqual(['fallback']);
  });

  it('falls back to text parsing when the tool input fails schema validation', async () => {
    const invalidToolBlock = {
      type: 'tool_use', id: 'toolu_2', name: 'emit_sop',
      input: { title: '', content_md: '' }, // violates min(1)
    } as unknown as Anthropic.ContentBlock;
    const textBlock = {
      type: 'text', text: '# Recovered Title\n## Objective\nx', citations: null,
    } as unknown as Anthropic.ContentBlock;
    const gen = new SOPGenerator(getDefaultConfig(), db, fakeClient([invalidToolBlock, textBlock]));

    const result = await gen.generateSOP(task);
    expect(result.title).toBe('Recovered Title');
  });

  it('does not send tools when use_structured_output is false', async () => {
    const config = getDefaultConfig();
    config.sop_generation.use_structured_output = false;
    const capture: { params?: Anthropic.MessageCreateParamsNonStreaming } = {};
    const textBlock = {
      type: 'text', text: '# Plain SOP\n## Objective\nx\n```json\n{"tags": ["plain"]}\n```', citations: null,
    } as unknown as Anthropic.ContentBlock;
    const gen = new SOPGenerator(config, db, fakeClient([textBlock], capture));

    const result = await gen.generateSOP(task);
    expect(result.title).toBe('Plain SOP');
    expect(capture.params?.tools).toBeUndefined();
    expect(capture.params?.system).toContain('JSON block');
  });
});

describe('createAnthropicClient — enterprise endpoint config (#26)', () => {
  const ENV_KEYS = ['ANTHROPIC_API_KEY', 'MY_GATEWAY_KEY'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function configWith(overrides: Partial<ShadowingConfig['sop_generation']>): ShadowingConfig {
    const config = getDefaultConfig();
    config.sop_generation = { ...config.sop_generation, ...overrides };
    return config;
  }

  it('throws a friendly error naming the configured env var when unset', () => {
    expect(() => createAnthropicClient(configWith({ api_key_env: 'MY_GATEWAY_KEY' })))
      .toThrowError(/MY_GATEWAY_KEY is not set/);
  });

  it('reads the credential from a custom env var', () => {
    process.env['MY_GATEWAY_KEY'] = 'test-key';
    const client = createAnthropicClient(configWith({ api_key_env: 'MY_GATEWAY_KEY' }));
    expect(client.apiKey).toBe('test-key');
  });

  it('passes base_url through to the SDK client', () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    const client = createAnthropicClient(configWith({ base_url: 'http://localhost:8080/v1' }));
    expect(client.baseURL).toBe('http://localhost:8080/v1');
  });

  it('keeps the SDK default endpoint when base_url is null', () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    const client = createAnthropicClient(configWith({ base_url: null }));
    expect(client.baseURL).toContain('api.anthropic.com');
  });

  it('SOPGenerator surfaces the missing-key error as SOPGenerationError', () => {
    expect(() => new SOPGenerator(getDefaultConfig(), db)).toThrowError(SOPGenerationError);
  });
});
