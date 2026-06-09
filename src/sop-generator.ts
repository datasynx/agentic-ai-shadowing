import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { ShadowingConfig, Task, SOP } from './types.js';
import type { ShadowingDB } from './db.js';
import { formatDuration } from './task-manager.js';
import { loadJGFFile, loadCartographyGraph, buildFocusedContext } from './cartography.js';
import { withRetry } from './retry.js';
import { parseSOPResponse, type ParsedSOPResponse } from './sop-parser.js';
import { createAnthropicClient } from './anthropic-client.js';
import { SOPGenerationError } from './errors.js';
import { getLogger } from './logger.js';

export { SOPGenerationError } from './errors.js';

const log = getLogger('sop-generator');

const DEFAULT_MAX_RESPONSE_BYTES = 512_000; // 500 KB
const SLOW_THRESHOLD_MS = 30_000;

// ── Structured output (tool use) ────────────────────────────────────────────
// The model fills a tool schema instead of us regex-parsing free text (#25).

const SOP_TOOL_NAME = 'emit_sop';

const SOPToolResultSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  content_md: z.string().min(1),
  tags: z.array(z.string()).default([]),
});

const SOP_TOOL_DEFINITION: Anthropic.Tool = {
  name: SOP_TOOL_NAME,
  description: 'Emit the finished Standard Operating Procedure as structured data.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Concise SOP title (no markdown heading marker)' },
      description: { type: 'string', description: 'One-paragraph objective of the SOP' },
      content_md: { type: 'string', description: 'Full SOP body in Markdown following the required structure' },
      tags: { type: 'array', items: { type: 'string' }, description: '3-8 lowercase tags (department, tool/system, process type, frequency, complexity)' },
    },
    required: ['title', 'content_md'],
  },
};

/** Minimal client surface so tests can inject a fake (production uses the real SDK client). */
export interface AnthropicLikeClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export class SOPGenerator {
  private client: AnthropicLikeClient;

  constructor(
    private config: ShadowingConfig,
    private db: ShadowingDB,
    client?: AnthropicLikeClient,
  ) {
    // Endpoint and credential env var are configurable for enterprise
    // gateways and local models (#26) — see createAnthropicClient.
    this.client = client ?? createAnthropicClient(config);
  }

  async generateSOP(task: Task): Promise<{ title: string; description: string; content_md: string; tags: string[] }> {
    const lang = this.config.sop_generation.sop_language === 'de' ? 'German' : 'English';
    const useStructured = this.config.sop_generation.use_structured_output !== false;

    const structureRules = `RULES:
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

Tag categories: Department/Function, Tool/System, Process type, Frequency, Complexity.
Generate 3-8 relevant tags (lowercase, without #).`;

    const systemPrompt = useStructured
      ? `You are an SOP analyst. The employee has just completed a task.
Create a precise, reusable Standard Operating Procedure (SOP) in ${lang}.

${structureRules}

Return the result by calling the ${SOP_TOOL_NAME} tool.`
      : `You are an SOP analyst. The employee has just completed a task.
Create a precise, reusable Standard Operating Procedure (SOP) in ${lang}.

${structureRules}

At the end of the response, add a JSON block with tags:
\`\`\`json
{"tags": ["tag1", "tag2", ...]}
\`\`\``;

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
    let structured: ParsedSOPResponse | null = null;
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
          ...(useStructured ? {
            tools: [SOP_TOOL_DEFINITION],
            tool_choice: { type: 'tool' as const, name: SOP_TOOL_NAME },
          } : {}),
        }),
      );

      inputTokens = response.usage?.input_tokens ?? 0;
      outputTokens = response.usage?.output_tokens ?? 0;

      text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('');

      if (useStructured) {
        structured = this.extractStructuredSOP(response);
        if (!structured) {
          // Fall back to text parsing below — loud, never silent (#25)
          log.warn('No valid structured tool output in response — falling back to text parsing', {
            task_id: task.id,
          });
        }
      }
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
    const responseBytes = Buffer.byteLength(structured ? structured.content_md : text, 'utf-8');
    if (responseBytes > maxBytes) {
      throw new SOPGenerationError(
        `API response exceeds size limit (${responseBytes} bytes > ${maxBytes} bytes)`,
        'response_too_large', false,
      );
    }

    try {
      const result = structured ?? this.parseResponse(text, task.title);

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

  /**
   * Extract and validate the structured tool-use result.
   * Returns null (→ text-parsing fallback) when the block is missing or invalid.
   */
  private extractStructuredSOP(response: Anthropic.Message): ParsedSOPResponse | null {
    const toolBlock = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === SOP_TOOL_NAME,
    );
    if (!toolBlock) return null;

    const validated = SOPToolResultSchema.safeParse(toolBlock.input);
    if (!validated.success) {
      log.warn('Structured SOP output failed schema validation', {
        issues: validated.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
      return null;
    }

    const { title, description, content_md, tags } = validated.data;
    return {
      title: title.trim(),
      description: description.trim(),
      content_md: content_md.trim(),
      tags: tags.map(t => t.toLowerCase().replace(/^#/, '').trim()).filter(t => t.length > 0),
    };
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
