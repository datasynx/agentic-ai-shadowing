import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadCartographyGraph,
  buildGraphContext,
  buildFocusedContext,
  findRelevantNodes,
} from '../src/cartography.js';
import type { CartographyGraph } from '../src/cartography.js';

const GRAPH_PATH = join(tmpdir(), `test-graph-${Date.now()}.json`);

const testGraph: CartographyGraph = {
  nodes: [
    { id: 'sap', label: 'SAP ERP', type: 'erp', metadata: { description: 'Enterprise Resource Planning' } },
    { id: 'crm', label: 'Salesforce CRM', type: 'crm', metadata: { description: 'Customer Relationship Management' } },
    { id: 'jira', label: 'Jira', type: 'project-management' },
    { id: 'slack', label: 'Slack', type: 'communication' },
    { id: 'db', label: 'PostgreSQL', type: 'database' },
  ],
  edges: [
    { source: 'sap', target: 'db', label: 'stores data' },
    { source: 'crm', target: 'sap', label: 'syncs orders' },
    { source: 'jira', target: 'slack', label: 'notifications' },
  ],
  metadata: { version: '1.0' },
};

beforeEach(() => {
  writeFileSync(GRAPH_PATH, JSON.stringify(testGraph), 'utf8');
});

afterEach(() => {
  try { unlinkSync(GRAPH_PATH); } catch { /* ok */ }
});

describe('loadCartographyGraph', () => {
  it('loads and parses a valid graph file', () => {
    const graph = loadCartographyGraph(GRAPH_PATH);
    expect(graph).not.toBeNull();
    expect(graph!.nodes).toHaveLength(5);
    expect(graph!.edges).toHaveLength(3);
  });

  it('returns null for missing file', () => {
    expect(loadCartographyGraph('/nonexistent/path.json')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const badPath = join(tmpdir(), `bad-graph-${Date.now()}.json`);
    writeFileSync(badPath, 'not json', 'utf8');
    expect(loadCartographyGraph(badPath)).toBeNull();
    try { unlinkSync(badPath); } catch { /* ok */ }
  });

  it('returns null for invalid schema', () => {
    const badPath = join(tmpdir(), `bad-schema-${Date.now()}.json`);
    writeFileSync(badPath, JSON.stringify({ foo: 'bar' }), 'utf8');
    expect(loadCartographyGraph(badPath)).toBeNull();
    try { unlinkSync(badPath); } catch { /* ok */ }
  });
});

describe('buildGraphContext', () => {
  it('includes all node types', () => {
    const ctx = buildGraphContext(testGraph);
    expect(ctx).toContain('[erp]');
    expect(ctx).toContain('[crm]');
    expect(ctx).toContain('SAP ERP');
    expect(ctx).toContain('Salesforce CRM');
  });

  it('includes edges', () => {
    const ctx = buildGraphContext(testGraph);
    expect(ctx).toContain('SAP ERP → PostgreSQL');
    expect(ctx).toContain('stores data');
  });

  it('includes metadata descriptions', () => {
    const ctx = buildGraphContext(testGraph);
    expect(ctx).toContain('Enterprise Resource Planning');
  });

  it('truncates at maxLength', () => {
    const ctx = buildGraphContext(testGraph, 50);
    expect(ctx.length).toBeLessThanOrEqual(80); // 50 + "...(gekürzt)" suffix
    expect(ctx).toContain('gekürzt');
  });
});

describe('findRelevantNodes', () => {
  it('finds nodes matching keywords', () => {
    const nodes = findRelevantNodes(testGraph, ['sap', 'erp']);
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes.some(n => n.id === 'sap')).toBe(true);
  });

  it('matches by label', () => {
    const nodes = findRelevantNodes(testGraph, ['salesforce']);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.id).toBe('crm');
  });

  it('returns empty for no matches', () => {
    const nodes = findRelevantNodes(testGraph, ['mongodb', 'redis']);
    expect(nodes).toHaveLength(0);
  });

  it('is case-insensitive', () => {
    const nodes = findRelevantNodes(testGraph, ['JIRA']);
    expect(nodes).toHaveLength(1);
  });
});

describe('buildFocusedContext', () => {
  it('returns focused context for matching task', () => {
    const ctx = buildFocusedContext(testGraph, 'SAP Rechnung erstellen');
    expect(ctx).toContain('SAP ERP');
    expect(ctx).toContain('Relevante Systeme');
  });

  it('includes related edges for matching nodes', () => {
    const ctx = buildFocusedContext(testGraph, 'SAP Bestellung anlegen');
    expect(ctx).toContain('PostgreSQL'); // connected via edge
  });

  it('falls back to general context for no matches', () => {
    const ctx = buildFocusedContext(testGraph, 'xyz');
    expect(ctx).toContain('Verfügbare Systeme'); // general fallback
  });

  it('uses description for matching', () => {
    const ctx = buildFocusedContext(
      testGraph,
      'Slack Benachrichtigungen konfigurieren',
    );
    expect(ctx).toContain('Slack');
  });
});
