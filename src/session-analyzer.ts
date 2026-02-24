/**
 * Session Analyzer — the agentic core of shadowing.
 *
 * Converts raw observation sessions into structured tasks and SOPs.
 * Uses Claude to:
 * 1. Cluster observed actions into logical task groups
 * 2. Infer task titles and descriptions from action patterns
 * 3. Generate SOPs from each detected task
 *
 * Pipeline: ObservationSession → ActionCluster[] → Task[] → SOP[]
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ShadowingConfig, Task, ObservedAction } from './types.js';
import type { ShadowingDB } from './db.js';
import { SOPGenerationError } from './sop-generator.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ActionCluster {
  title: string;
  description: string;
  actions: ObservedAction[];
  start_time: string;
  end_time: string;
  duration_seconds: number;
  complexity: number; // 1-5
}

export interface AnalysisResult {
  session_id: string;
  clusters: ActionCluster[];
  tasks_created: Task[];
  sops_generated: Array<{ task_id: string; sop_id: string; title: string }>;
  summary: string;
}

// ── Silence-based Clustering ────────────────────────────────────────────────

/**
 * Pre-cluster actions by silence gaps.
 * If there's a gap > threshold between consecutive actions, start a new group.
 */
export function clusterBySilence(
  actions: ObservedAction[],
  silenceThresholdSeconds: number = 300, // 5 min default
): ObservedAction[][] {
  if (actions.length === 0) return [];

  // Sort by start time ascending
  const sorted = [...actions].sort(
    (a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
  );

  const groups: ObservedAction[][] = [[sorted[0]!]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;

    const prevEnd = new Date(prev.ended_at).getTime();
    const currStart = new Date(curr.started_at).getTime();
    const gapSeconds = (currStart - prevEnd) / 1000;

    if (gapSeconds > silenceThresholdSeconds) {
      groups.push([curr]);
    } else {
      groups[groups.length - 1]!.push(curr);
    }
  }

  return groups;
}

/**
 * Summarize a group of actions for the LLM prompt.
 */
export function summarizeActionGroup(actions: ObservedAction[]): string {
  const lines: string[] = [];

  for (const action of actions) {
    const time = action.started_at.substring(11, 19); // HH:mm:ss
    const dur = action.duration_seconds > 0 ? ` (${action.duration_seconds}s)` : '';

    if (action.source === 'shell' && action.command) {
      lines.push(`[${time}] Shell${dur}: ${action.command}`);
    } else if (action.source === 'file' && action.file_path) {
      lines.push(`[${time}] File${dur}: ${action.window_title ?? action.file_path}`);
    } else if (action.source === 'git' && action.command) {
      lines.push(`[${time}] Git${dur}: ${action.command}`);
    } else if (action.source === 'window') {
      const app = action.app_name ?? 'unknown';
      const title = action.window_title ?? '';
      lines.push(`[${time}] Window${dur}: ${app} — ${title}`);
    } else if (action.source === 'manual') {
      lines.push(`[${time}] Note${dur}: ${action.window_title ?? ''}`);
    }
  }

  return lines.join('\n');
}

// ── Session Analyzer ────────────────────────────────────────────────────────

export class SessionAnalyzer {
  private client: Anthropic;

  constructor(
    private config: ShadowingConfig,
    private db: ShadowingDB,
  ) {
    if (!process.env['ANTHROPIC_API_KEY']) {
      throw new SOPGenerationError(
        'ANTHROPIC_API_KEY ist nicht gesetzt.',
        'missing_api_key', false,
      );
    }
    this.client = new Anthropic();
  }

  /**
   * Analyze a completed observation session:
   * 1. Load all actions
   * 2. Pre-cluster by silence gaps
   * 3. Ask Claude to identify tasks from clusters
   * 4. Create tasks in DB
   * 5. Generate SOPs for each task
   */
  async analyzeSession(sessionId: string): Promise<AnalysisResult> {
    const session = this.db.getObservationSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} nicht gefunden.`);

    // Load all actions chronologically
    const actions = this.db.getActionTimeline(sessionId);
    if (actions.length === 0) {
      return {
        session_id: sessionId,
        clusters: [],
        tasks_created: [],
        sops_generated: [],
        summary: 'Keine Aktionen in der Session.',
      };
    }

    // Pre-cluster by silence gaps (5 min)
    const rawGroups = clusterBySilence(actions, 300);

    // Build activity summary for Claude
    const groupSummaries = rawGroups.map((group, i) => {
      const first = group[0]!;
      const last = group[group.length - 1]!;
      const durationSec = Math.floor(
        (new Date(last.ended_at).getTime() - new Date(first.started_at).getTime()) / 1000,
      );
      return `--- Aktivitätsblock ${i + 1} (${durationSec}s, ${group.length} Aktionen) ---\n${summarizeActionGroup(group)}`;
    });

    const fullSummary = groupSummaries.join('\n\n');

    // Ask Claude to identify tasks
    const clusters = await this.identifyTasks(fullSummary, rawGroups);

    // Create tasks and generate SOPs
    const tasks_created: Task[] = [];
    const sops_generated: Array<{ task_id: string; sop_id: string; title: string }> = [];

    for (const cluster of clusters) {
      // Create task
      const task = this.db.createTask(cluster.title, cluster.description);
      const completed = this.db.completeTask(task.id);
      tasks_created.push(completed);

      // Generate SOP from task + observation context
      try {
        const sopResult = await this.generateSOPFromCluster(completed, cluster);
        const sop = this.db.createSOP(completed.id, {
          title: sopResult.title,
          description: sopResult.description,
          content_md: sopResult.content_md,
          tags: sopResult.tags,
        });

        if (completed.duration_seconds) {
          this.db.logExecution(sop.id, {
            duration_seconds: completed.duration_seconds,
            complexity_rating: cluster.complexity,
          });
        }

        sops_generated.push({
          task_id: completed.id,
          sop_id: sop.id,
          title: sopResult.title,
        });
      } catch {
        // SOP generation failed for this cluster — task still exists
      }
    }

    return {
      session_id: sessionId,
      clusters,
      tasks_created,
      sops_generated,
      summary: `${clusters.length} Task(s) erkannt, ${sops_generated.length} SOP(s) generiert.`,
    };
  }

  /**
   * Ask Claude to identify distinct tasks from action groups.
   */
  private async identifyTasks(
    activitySummary: string,
    rawGroups: ObservedAction[][],
  ): Promise<ActionCluster[]> {
    const lang = this.config.sop_generation.sop_language === 'de' ? 'Deutsch' : 'English';

    const systemPrompt = `Du bist ein Workflow-Analyst. Du erhältst eine Liste von beobachteten Aktionen
eines Mitarbeiters (Shell-Befehle, aktive Fenster, Dateioperationen, Git-Aktionen).

Deine Aufgabe:
1. Erkenne logisch zusammengehörende Arbeitsabläufe (Tasks)
2. Fasse jeden Task in einem kurzen, beschreibenden Titel zusammen
3. Beschreibe was der Mitarbeiter gemacht hat
4. Bewerte die Komplexität (1=trivial, 5=sehr komplex)

REGELN:
- Antworte in ${lang}
- Fasse ähnliche Aktionen zu einem Task zusammen (z.B. mehrere git-Befehle = ein Deployment-Task)
- Ignoriere triviale Aktionen (ls, cd, clear) wenn sie nicht Teil eines größeren Workflows sind
- Ein Task sollte mindestens 2-3 zusammenhängende Aktionen haben
- Titel sollen prozessbeschreibend sein, z.B. "SAP-Datenexport durchführen", "Code-Review und Merge"

Antworte NUR mit einem JSON-Array:
\`\`\`json
[
  {
    "title": "Task-Titel",
    "description": "Was wurde gemacht und warum",
    "action_blocks": [0, 1],
    "complexity": 3
  }
]
\`\`\`

"action_blocks" ist ein Array der Aktivitätsblock-Nummern (0-basiert) die zu diesem Task gehören.`;

    try {
      const response = await this.client.messages.create({
        model: this.config.sop_generation.model,
        max_tokens: 2048,
        temperature: 0.2,
        system: systemPrompt,
        messages: [{ role: 'user', content: activitySummary }],
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('');

      return this.parseTaskIdentification(text, rawGroups);
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        throw new SOPGenerationError('API-Rate-Limit erreicht.', 'rate_limited', true, 429);
      }
      if (err instanceof Anthropic.AuthenticationError) {
        throw new SOPGenerationError('API-Key ungültig.', 'auth_failed', false, 401);
      }
      throw err;
    }
  }

  private parseTaskIdentification(text: string, rawGroups: ObservedAction[][]): ActionCluster[] {
    const jsonMatch = text.match(/```json\s*\n?([\s\S]*?)\n?```/);
    if (!jsonMatch?.[1]) return [];

    let parsed: Array<{
      title: string;
      description: string;
      action_blocks: number[];
      complexity: number;
    }>;

    try {
      parsed = JSON.parse(jsonMatch[1]) as typeof parsed;
    } catch {
      return [];
    }

    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(item => item.title && item.action_blocks?.length > 0)
      .map(item => {
        const actions = item.action_blocks
          .filter(idx => idx >= 0 && idx < rawGroups.length)
          .flatMap(idx => rawGroups[idx]!);

        if (actions.length === 0) return null;

        const sorted = [...actions].sort(
          (a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
        );
        const first = sorted[0]!;
        const last = sorted[sorted.length - 1]!;
        const durationSeconds = Math.floor(
          (new Date(last.ended_at).getTime() - new Date(first.started_at).getTime()) / 1000,
        );

        return {
          title: item.title,
          description: item.description,
          actions,
          start_time: first.started_at,
          end_time: last.ended_at,
          duration_seconds: durationSeconds,
          complexity: Math.min(5, Math.max(1, item.complexity ?? 3)),
        };
      })
      .filter((c): c is ActionCluster => c !== null);
  }

  /**
   * Generate SOP using both task info and observation details.
   */
  private async generateSOPFromCluster(
    task: Task,
    cluster: ActionCluster,
  ): Promise<{ title: string; description: string; content_md: string; tags: string[] }> {
    const lang = this.config.sop_generation.sop_language === 'de' ? 'Deutsch' : 'English';
    const actionSummary = summarizeActionGroup(cluster.actions);

    const systemPrompt = `Du bist ein SOP-Analyst. Erstelle eine Standard Operating Procedure (SOP) in ${lang}.

Du erhältst:
1. Einen erkannten Task-Titel und -Beschreibung
2. Die tatsächlich beobachteten Aktionen (Shell-Befehle, Fenster, Dateien)

Erstelle eine SOP die den BEOBACHTETEN Workflow in wiederverwendbare Schritte überführt.

REGELN:
1. Markdown-Struktur:
   # [SOP-Titel]
   ## Ziel
   ## Voraussetzungen
   ## Schritte
   ### Schritt 1: [Bezeichnung]
   ...
   ## Erwartetes Ergebnis
   ## Hinweise
2. Leite die Schritte aus den TATSÄCHLICHEN Aktionen ab, nicht aus Vermutungen
3. Generalisiere spezifische Pfade und Parameter zu Platzhaltern
4. Enthält KEINE personenbezogenen Daten oder firmeninternen Geheimnisse

Am Ende, füge Tags hinzu:
\`\`\`json
{"tags": ["tag1", "tag2", ...]}
\`\`\``;

    const userPrompt = `Task: ${task.title}
Beschreibung: ${cluster.description}
Dauer: ${cluster.duration_seconds}s
Komplexität: ${cluster.complexity}/5

Beobachtete Aktionen:
${actionSummary}`;

    const response = await this.client.messages.create({
      model: this.config.sop_generation.model,
      max_tokens: this.config.sop_generation.max_tokens,
      temperature: this.config.sop_generation.temperature,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('');

    // Parse response (same logic as SOPGenerator)
    let tags: string[] = [];
    let content_md = text;

    const tagMatch = text.match(/```json\s*\n?\{[\s\S]*?"tags"\s*:\s*\[[\s\S]*?\]\s*\}\s*\n?```/);
    if (tagMatch) {
      try {
        const jsonStr = tagMatch[0].replace(/```json\s*\n?/, '').replace(/\n?```/, '');
        const parsed = JSON.parse(jsonStr) as { tags: string[] };
        tags = parsed.tags.map(t => t.toLowerCase().replace(/^#/, ''));
      } catch { /* no tags */ }
      content_md = text.replace(tagMatch[0], '').trim();
    }

    const titleMatch = content_md.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1]!.trim() : task.title;

    const goalMatch = content_md.match(/##\s+Ziel\s*\n([\s\S]*?)(?=\n##|\n$)/);
    const description = goalMatch ? goalMatch[1]!.trim() : cluster.description;

    return { title, description, content_md, tags };
  }
}
