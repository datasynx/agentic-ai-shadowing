import Anthropic from '@anthropic-ai/sdk';
import type { ShadowingConfig, Task, SOP } from './types.js';
import type { ShadowingDB } from './db.js';
import { formatDuration } from './task-manager.js';
import { loadJGFFile, loadCartographyGraph, buildFocusedContext } from './cartography.js';

export class SOPGenerationError extends Error {
  constructor(
    message: string,
    public readonly code: 'missing_api_key' | 'auth_failed' | 'rate_limited' | 'api_error' | 'parse_error' | 'unknown',
    public readonly retryable: boolean,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'SOPGenerationError';
  }
}

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
    const lang = this.config.sop_generation.sop_language === 'de' ? 'Deutsch' : 'English';

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
    try {
      const response = await this.client.messages.create({
        model: this.config.sop_generation.model,
        max_tokens: this.config.sop_generation.max_tokens,
        temperature: this.config.sop_generation.temperature,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

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
          'API rate limit reached. Try again in a few minutes.',
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

    try {
      return this.parseResponse(text, task.title);
    } catch (err) {
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
    // Extract tags JSON block
    let tags: string[] = [];
    let content_md = text;

    const jsonMatch = text.match(/```json\s*\n?\{[\s\S]*?"tags"\s*:\s*\[[\s\S]*?\]\s*\}\s*\n?```/);
    if (jsonMatch) {
      try {
        const jsonStr = jsonMatch[0].replace(/```json\s*\n?/, '').replace(/\n?```/, '');
        const parsed = JSON.parse(jsonStr) as { tags: string[] };
        tags = parsed.tags.map(t => t.toLowerCase().replace(/^#/, ''));
      } catch {
        // JSON parse failed — no tags
      }
      content_md = text.replace(jsonMatch[0], '').trim();
    }

    // Extract title from first heading
    const titleMatch = content_md.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1]!.trim() : fallbackTitle;

    // Extract description from "## Objective" section
    const goalMatch = content_md.match(/##\s+(?:Ziel|Objective)\s*\n([\s\S]*?)(?=\n##|\n$)/);
    const description = goalMatch ? goalMatch[1]!.trim() : '';

    return { title, description, content_md, tags };
  }
}

export function buildSOPPreview(title: string, tags: string[], stepCount: number): string {
  const tagStr = tags.map(t => `#${t}`).join(' ');
  return `  Title: "${title}"\n  Steps: ${stepCount}\n  Tags: ${tagStr || '(none)'}`;
}

export function countSteps(contentMd: string): number {
  const matches = contentMd.match(/^###\s+(?:Schritt|Step)\s+\d/gm);
  return matches ? matches.length : 0;
}
