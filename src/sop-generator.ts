import Anthropic from '@anthropic-ai/sdk';
import type { ShadowingConfig, Task, SOP } from './types.js';
import type { ShadowingDB } from './db.js';
import { formatDuration } from './task-manager.js';
import { loadJGFFile, loadCartographyGraph, buildFocusedContext } from './cartography.js';
import { withRetry } from './retry.js';
import { parseSOPResponse } from './sop-parser.js';
import { SOPGenerationError } from './errors.js';
import { getLogger } from './logger.js';

export { SOPGenerationError } from './errors.js';

const log = getLogger('sop-generator');

const DEFAULT_MAX_RESPONSE_BYTES = 512_000; // 500 KB
const SLOW_THRESHOLD_MS = 30_000;

export class SOPGenerator {
  private client: Anthropic;

  constructor(
    private config: ShadowingConfig,
    private db: ShadowingDB,
  ) {
    if (!process.env['ANTHROPIC_API_KEY']) {
      throw new SOPGenerationError(
        'ANTHROPIC_API_KEY is not set.\n' +
        'Export your API key:\n\n' +
        '  export ANTHROPIC_API_KEY=sk-ant-...\n',
        'missing_api_key',
        false,
      );
    }
    this.client = new Anthropic();
  }

  async generateSOP(task: Task): Promise<{ title: string; description: string; content_md: string; tags: string[] }> {
    const lang = this.config.sop_generation.sop_language === 'de' ? 'German' : 'English';

    const systemPrompt = `You are an SOP analyst. The employee has just completed a task.
Create a precise, reusable Standard Operating Procedure (SOP) in ${lang}.

RULES:
1. Write the SOP in Markdown with the following structure:
   # [SOP Title]
   ## Objective
   ## Prerequisites
   ## Steps
   ### Step 1: [Description]
   ...
   ## Expected Result
   ## Notes
   ## Related Systems

2. Number all steps uniquely
3. Keep the language clear and action-oriented
4. Do NOT include any personally identifiable information
5. Do NOT include any company secrets — only process steps

At the end of the response, add a JSON block with tags:
\`\`\`json
{"tags": ["tag1", "tag2", ...]}
\`\`\`

Tag categories: Department/Function, Tool/System, Process type, Frequency, Complexity.
Generate 3-8 relevant tags (lowercase, without #).`;

    const durationStr = task.duration_seconds ? formatDuration(task.duration_seconds) : 'unknown';

    let userPrompt = `Task title: ${task.title}`;
    if (task.description) userPrompt += `\nDescription / Notes:\n${task.description}`;
    userPrompt += `\nDuration: ${durationStr}`;

    // Cartography context (JGF format preferred)
    if (this.config.sop_generation.include_cartography_context && this.config.cartography_graph_path) {
      const graph = loadJGFFile(this.config.cartography_graph_path)
                 ?? loadCartographyGraph(this.config.cartography_graph_path);
      if (graph) {
        const context = buildFocusedContext(graph, task.title, task.description ?? undefined);
        userPrompt += `\n\n${context}`;
      }
    }

    let text: string;
    let inputTokens = 0;
    let outputTokens = 0;
    const startTime = performance.now();

    try {
      const response = await withRetry(() =>
        this.client.messages.create({
          model: this.config.sop_generation.model,
          max_tokens: this.config.sop_generation.max_tokens,
          temperature: this.config.sop_generation.temperature,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      );

      inputTokens = response.usage?.input_tokens ?? 0;
      outputTokens = response.usage?.output_tokens ?? 0;

      text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('');
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new SOPGenerationError(
          'API authentication failed. Check your ANTHROPIC_API_KEY.',
          'auth_failed', false, 401,
        );
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new SOPGenerationError(
          'API rate limit reached after retries. Try again in a few minutes.',
          'rate_limited', true, 429,
        );
      }
      if (err instanceof Anthropic.APIError) {
        throw new SOPGenerationError(
          `Claude API error (${err.status}): ${err.message}`,
          'api_error', err.status >= 500, err.status,
        );
      }
      throw new SOPGenerationError(
        `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        'unknown', false,
      );
    }

    const durationMs = Math.round(performance.now() - startTime);

    // Log API usage and performance
    log.info('Claude API call completed', {
      model: this.config.sop_generation.model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      duration_ms: durationMs,
    });

    if (durationMs > SLOW_THRESHOLD_MS) {
      log.warn('Slow SOP generation detected', { duration_ms: durationMs, task_id: task.id });
    }

    // Validate response size before DB persistence
    const maxBytes = DEFAULT_MAX_RESPONSE_BYTES;
    const responseBytes = Buffer.byteLength(text, 'utf-8');
    if (responseBytes > maxBytes) {
      throw new SOPGenerationError(
        `API response exceeds size limit (${responseBytes} bytes > ${maxBytes} bytes)`,
        'response_too_large', false,
      );
    }

    try {
      const result = this.parseResponse(text, task.title);

      // Log API usage to DB (non-blocking — don't fail SOP gen if this fails)
      try {
        this.db.logApiUsage({
          sop_id: undefined,
          model: this.config.sop_generation.model,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          duration_ms: durationMs,
        });
      } catch (e) {
        log.warn('Failed to log API usage', { error: e instanceof Error ? e.message : String(e) });
      }

      return result;
    } catch (err) {
      if (err instanceof SOPGenerationError) throw err;
      throw new SOPGenerationError(
        `Error parsing the API response: ${err instanceof Error ? err.message : String(err)}`,
        'parse_error', false,
      );
    }
  }

  async regenerateSOP(sopId: string): Promise<SOP> {
    const sop = this.db.getSOP(sopId);
    if (!sop) throw new Error(`SOP ${sopId} not found.`);

    const task = this.db.getTask(sop.task_id);
    if (!task) throw new Error(`Task ${sop.task_id} not found.`);

    const result = await this.generateSOP(task);

    return this.db.updateSOP(sopId, {
      title: result.title,
      description: result.description,
      content_md: result.content_md,
    });
  }

  private parseResponse(text: string, fallbackTitle: string): {
    title: string;
    description: string;
    content_md: string;
    tags: string[];
  } {
    return parseSOPResponse(text, fallbackTitle);
  }
}

export function buildSOPPreview(title: string, tags: string[], stepCount: number): string {
  const tagStr = tags.map(t => `#${t}`).join(' ');
  return `  Title: "${title}"\n  Steps: ${stepCount}\n  Tags: ${tagStr || '(none)'}`;
}

export function countSteps(contentMd: string): number {
  const matches = contentMd.match(/^###\s+Step\s+\d/gm);
  return matches ? matches.length : 0;
}
