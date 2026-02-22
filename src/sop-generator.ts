import Anthropic from '@anthropic-ai/sdk';
import type { ShadowingConfig, Task, SOP } from './types.js';
import type { ShadowingDB } from './db.js';
import { formatDuration } from './task-manager.js';
import { loadCartographyGraph, buildFocusedContext } from './cartography.js';

export class SOPGenerator {
  private client: Anthropic;

  constructor(
    private config: ShadowingConfig,
    private db: ShadowingDB,
  ) {
    this.client = new Anthropic();
  }

  async generateSOP(task: Task): Promise<{ title: string; description: string; content_md: string; tags: string[] }> {
    const lang = this.config.sop_generation.sop_language === 'de' ? 'Deutsch' : 'English';

    const systemPrompt = `Du bist ein SOP-Analyst. Der Mitarbeiter hat gerade einen Task abgeschlossen.
Erstelle eine präzise, wiederverwendbare Standard Operating Procedure (SOP) in ${lang}.

REGELN:
1. Schreibe die SOP in Markdown mit folgender Struktur:
   # [SOP-Titel]
   ## Ziel
   ## Voraussetzungen
   ## Schritte
   ### Schritt 1: [Bezeichnung]
   ...
   ## Erwartetes Ergebnis
   ## Hinweise
   ## Verknüpfte Systeme

2. Nummeriere alle Schritte eindeutig
3. Halte die Sprache klar und aktionsorientiert
4. Enthält KEINE personenbezogenen Daten
5. Enthält KEINE firmeninternen Geheimnisse — nur Prozessschritte

Am Ende der Antwort, füge einen JSON-Block mit Tags hinzu:
\`\`\`json
{"tags": ["tag1", "tag2", ...]}
\`\`\`

Tag-Kategorien: Abteilung/Funktion, Tool/System, Prozessart, Frequenz, Komplexität.
Generiere 3-8 relevante Tags (lowercase, ohne #).`;

    const durationStr = task.duration_seconds ? formatDuration(task.duration_seconds) : 'unbekannt';

    let userPrompt = `Task-Titel: ${task.title}`;
    if (task.description) userPrompt += `\nBeschreibung / Notizen:\n${task.description}`;
    userPrompt += `\nDauer: ${durationStr}`;

    // Cartography context
    if (this.config.sop_generation.include_cartography_context && this.config.cartography_graph_path) {
      const graph = loadCartographyGraph(this.config.cartography_graph_path);
      if (graph) {
        const context = buildFocusedContext(graph, task.title, task.description ?? undefined);
        userPrompt += `\n\n${context}`;
      }
    }

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

    return this.parseResponse(text, task.title);
  }

  async regenerateSOP(sopId: string): Promise<SOP> {
    const sop = this.db.getSOP(sopId);
    if (!sop) throw new Error(`SOP ${sopId} nicht gefunden.`);

    const task = this.db.getTask(sop.task_id);
    if (!task) throw new Error(`Task ${sop.task_id} nicht gefunden.`);

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

    // Extract description from "## Ziel" section
    const goalMatch = content_md.match(/##\s+Ziel\s*\n([\s\S]*?)(?=\n##|\n$)/);
    const description = goalMatch ? goalMatch[1]!.trim() : '';

    return { title, description, content_md, tags };
  }
}

export function buildSOPPreview(title: string, tags: string[], stepCount: number): string {
  const tagStr = tags.map(t => `#${t}`).join(' ');
  return `  Titel: "${title}"\n  Schritte: ${stepCount}\n  Tags: ${tagStr || '(keine)'}`;
}

export function countSteps(contentMd: string): number {
  const matches = contentMd.match(/^###\s+Schritt\s+\d/gm);
  return matches ? matches.length : 0;
}
