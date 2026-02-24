import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

// ── Cartography Graph Schema (internal array format) ─────────────────────────

const NodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const EdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  label: z.string().optional(),
  type: z.string().optional(),
});

const GraphSchema = z.object({
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
  metadata: z.record(z.unknown()).optional(),
});

export type CartographyNode = z.infer<typeof NodeSchema>;
export type CartographyEdge = z.infer<typeof EdgeSchema>;
export type CartographyGraph = z.infer<typeof GraphSchema>;

// ── JGF (JSON Graph Format) Schema ──────────────────────────────────────────

const JGFNodeSchema = z.object({
  label: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const JGFEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  relation: z.string().optional(),
  label: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const JGFGraphSchema = z.object({
  graph: z.object({
    type: z.string().optional(),
    label: z.string().optional(),
    directed: z.boolean().optional(),
    nodes: z.record(JGFNodeSchema),
    edges: z.array(JGFEdgeSchema).optional().default([]),
    metadata: z.record(z.unknown()).optional(),
  }),
});

function convertJGFToCartographyGraph(jgf: z.infer<typeof JGFGraphSchema>): CartographyGraph {
  const nodes: CartographyNode[] = Object.entries(jgf.graph.nodes).map(([id, node]) => ({
    id,
    label: node.label ?? id,
    type: (node.metadata?.['type'] as string) ?? undefined,
    metadata: node.metadata,
  }));

  const edges: CartographyEdge[] = jgf.graph.edges.map(edge => ({
    source: edge.source,
    target: edge.target,
    label: edge.relation ?? edge.label,
    type: (edge.metadata?.['type'] as string) ?? undefined,
  }));

  return { nodes, edges, metadata: jgf.graph.metadata };
}

// ── Load & Parse ─────────────────────────────────────────────────────────────

/**
 * Load a JGF file (cartography-graph.jgf.json) — tries JGF format first,
 * falls back to the internal {nodes[], edges[]} format.
 */
export function loadJGFFile(path: string): CartographyGraph | null {
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw) as unknown;

    // Try JGF format first
    const jgfResult = JGFGraphSchema.safeParse(data);
    if (jgfResult.success) {
      return convertJGFToCartographyGraph(jgfResult.data);
    }

    // Fallback to internal {nodes[], edges[]} format
    const graphResult = GraphSchema.safeParse(data);
    if (graphResult.success) {
      return graphResult.data;
    }

    return null;
  } catch {
    return null;
  }
}

export function loadCartographyGraph(path: string): CartographyGraph | null {
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw);
    return GraphSchema.parse(data);
  } catch {
    return null;
  }
}

// ── Context Builder for SOP Generation ───────────────────────────────────────

/**
 * Builds a concise text summary of the cartography graph
 * suitable for inclusion in the SOP generation prompt.
 */
export function buildGraphContext(graph: CartographyGraph, maxLength = 2000): string {
  const lines: string[] = [];

  // Group nodes by type
  const nodesByType = new Map<string, CartographyNode[]>();
  for (const node of graph.nodes) {
    const type = node.type ?? 'unbekannt';
    if (!nodesByType.has(type)) nodesByType.set(type, []);
    nodesByType.get(type)!.push(node);
  }

  lines.push('Verfügbare Systeme und Komponenten:');
  for (const [type, nodes] of nodesByType) {
    lines.push(`\n[${type}]`);
    for (const node of nodes) {
      lines.push(`  - ${node.label}${node.metadata?.['description'] ? `: ${node.metadata['description']}` : ''}`);
    }
  }

  // Add relationships
  if (graph.edges.length > 0) {
    lines.push('\nBeziehungen:');
    const nodeMap = new Map(graph.nodes.map(n => [n.id, n.label]));
    for (const edge of graph.edges) {
      const src = nodeMap.get(edge.source) ?? edge.source;
      const tgt = nodeMap.get(edge.target) ?? edge.target;
      const label = edge.label ? ` (${edge.label})` : '';
      lines.push(`  ${src} → ${tgt}${label}`);
    }
  }

  const text = lines.join('\n');
  return text.length > maxLength ? text.substring(0, maxLength) + '\n...(gekürzt)' : text;
}

/**
 * Find relevant nodes based on keywords from task title/description.
 */
export function findRelevantNodes(
  graph: CartographyGraph,
  keywords: string[],
): CartographyNode[] {
  const lowerKeywords = keywords.map(k => k.toLowerCase());
  return graph.nodes.filter(node => {
    const text = `${node.label} ${node.type ?? ''} ${JSON.stringify(node.metadata ?? {})}`.toLowerCase();
    return lowerKeywords.some(kw => text.includes(kw));
  });
}

/**
 * Build focused context only for nodes related to the task.
 */
export function buildFocusedContext(
  graph: CartographyGraph,
  taskTitle: string,
  taskDescription?: string,
): string {
  // Extract keywords from title and description
  const text = `${taskTitle} ${taskDescription ?? ''}`;
  const keywords = text
    .toLowerCase()
    .split(/[\s,.\-/]+/)
    .filter(w => w.length > 2);

  const relevant = findRelevantNodes(graph, keywords);

  if (relevant.length === 0) {
    return buildGraphContext(graph, 1000); // fallback: general overview
  }

  const lines = ['Relevante Systeme für diesen Task:'];
  const nodeIds = new Set(relevant.map(n => n.id));

  for (const node of relevant) {
    lines.push(`  - ${node.label} (${node.type ?? 'system'})`);
  }

  // Add edges between relevant nodes
  const relevantEdges = graph.edges.filter(
    e => nodeIds.has(e.source) || nodeIds.has(e.target)
  );

  if (relevantEdges.length > 0) {
    const nodeMap = new Map(graph.nodes.map(n => [n.id, n.label]));
    lines.push('\nZugehörige Verbindungen:');
    for (const edge of relevantEdges) {
      const src = nodeMap.get(edge.source) ?? edge.source;
      const tgt = nodeMap.get(edge.target) ?? edge.target;
      lines.push(`  ${src} → ${tgt}${edge.label ? ` (${edge.label})` : ''}`);
    }
  }

  return lines.join('\n');
}
