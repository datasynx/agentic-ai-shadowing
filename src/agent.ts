import Anthropic from '@anthropic-ai/sdk';
import type { ShadowConfig, CartographyDB, TaskRow, SOPRow } from './types.js';

// ── runShadowCycle ──────────────────────────────────────────────────────────
// Analyzes the diff between two system snapshots using Claude Haiku.
// Called only when the snapshot has changed.

export async function runShadowCycle(
  config: ShadowConfig,
  db: CartographyDB,
  sessionId: string,
  prevSnapshot: string,
  currSnapshot: string,
  onOutput?: (msg: unknown) => void,
): Promise<void> {
  const client = new Anthropic();

  const systemPrompt = `You are a system monitoring agent. Analyze the diff between two system snapshots.
Find:
- New/closed TCP connections → report as connection_open / connection_close events
- New/terminated processes → report as process_start / process_end events
- Window focus changes → report as window_focus events
- Tool switches → report as tool_switch events

Respond with a JSON array of events. Each event:
{ "eventType": "...", "process": "...", "pid": number, "target": "host:port" (optional), "port": number (optional) }

target = host:port ONLY. Be concise and efficient. If no changes detected, return [].`;

  const userPrompt = prevSnapshot
    ? `Previous snapshot:\n${prevSnapshot}\n\nCurrent snapshot:\n${currSnapshot}`
    : `Initial snapshot:\n${currSnapshot}`;

  try {
    const response = await client.messages.create({
      model: config.shadowModel,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('');

    if (onOutput) onOutput({ type: 'analysis', text });

    // Parse events from response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const events = JSON.parse(jsonMatch[0]) as Array<{
          eventType: string;
          process: string;
          pid: number;
          target?: string;
          port?: number;
        }>;

        for (const event of events) {
          db.saveEvent(sessionId, {
            eventType: event.eventType as 'process_start',
            process: event.process,
            pid: event.pid,
            target: event.target,
            port: event.port,
          });
        }
      } catch {
        // JSON parse failed — non-fatal
      }
    }
  } catch (err) {
    process.stderr.write(`⚠ Shadow cycle API error: ${err}\n`);
  }
}

// ── SOP Generation ──────────────────────────────────────────────────────────

export async function generateSOPs(
  db: CartographyDB,
  sessionId: string,
): Promise<number> {
  const tasks = db.getTasks(sessionId).filter(t => t.status === 'completed');
  if (tasks.length === 0) return 0;

  const clusters = clusterTasks(tasks);
  const client = new Anthropic();
  let sopCount = 0;

  for (const cluster of clusters) {
    const taskDescriptions = cluster
      .map(t => {
        const steps = JSON.parse(t.steps) as string[];
        const services = JSON.parse(t.involvedServices) as string[];
        return `- ${t.description ?? 'Unnamed task'}\n  Steps: ${steps.join(', ') || 'none'}\n  Services: ${services.join(', ') || 'none'}`;
      })
      .join('\n');

    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 2048,
        system: `You generate Standard Operating Procedures (SOPs) from observed task patterns.
Output a single JSON object:
{
  "title": "...",
  "description": "...",
  "steps": [{ "order": 1, "instruction": "...", "tool": "...", "target": "...", "notes": "..." }],
  "involvedSystems": ["..."],
  "estimatedDuration": "~N minutes",
  "frequency": "X times daily",
  "confidence": 0.0-1.0
}`,
        messages: [{
          role: 'user',
          content: `Generate an SOP from these ${cluster.length} related tasks:\n${taskDescriptions}`,
        }],
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('');

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const sop = JSON.parse(jsonMatch[0]) as Omit<SOPRow, 'id' | 'sessionId' | 'createdAt'>;
        db.insertSOP(sessionId, sop);
        sopCount++;
      }
    } catch (err) {
      process.stderr.write(`⚠ SOP generation error: ${err}\n`);
    }
  }

  return sopCount;
}

// ── Task Clustering ─────────────────────────────────────────────────────────
// Groups tasks by overlapping involvedServices (simple overlap clustering).

export function clusterTasks(tasks: TaskRow[]): TaskRow[][] {
  if (tasks.length === 0) return [];

  const clusters: TaskRow[][] = [];
  const assigned = new Set<string>();

  for (const task of tasks) {
    if (assigned.has(task.id)) continue;

    const cluster: TaskRow[] = [task];
    assigned.add(task.id);

    const taskServices = new Set(JSON.parse(task.involvedServices) as string[]);

    for (const other of tasks) {
      if (assigned.has(other.id)) continue;

      const otherServices = JSON.parse(other.involvedServices) as string[];
      const hasOverlap = otherServices.some(s => taskServices.has(s));

      if (hasOverlap) {
        cluster.push(other);
        assigned.add(other.id);
        for (const s of otherServices) taskServices.add(s);
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}
