import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadCartographyGraph,
  loadJGFFile,
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
    expect(ctx.length).toBeLessThanOrEqual(80); // 50 + "...(truncated)" suffix
    expect(ctx).toContain('truncated');
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
    const ctx = buildFocusedContext(testGraph, 'SAP Invoice Creation');
    expect(ctx).toContain('SAP ERP');
    expect(ctx).toContain('Relevant systems');
  });

  it('includes related edges for matching nodes', () => {
    const ctx = buildFocusedContext(testGraph, 'SAP Purchase Order');
    expect(ctx).toContain('PostgreSQL'); // connected via edge
  });

  it('falls back to general context for no matches', () => {
    const ctx = buildFocusedContext(testGraph, 'xyz');
    expect(ctx).toContain('Available systems'); // general fallback
  });

  it('uses description for matching', () => {
    const ctx = buildFocusedContext(
      testGraph,
      'Slack Notification Configuration',
    );
    expect(ctx).toContain('Slack');
  });
});

// ── JGF Format Tests ─────────────────────────────────────────────────────────

describe('loadJGFFile', () => {
  const JGF_PATH = join(tmpdir(), `test-jgf-${Date.now()}.json`);

  afterEach(() => {
    try { unlinkSync(JGF_PATH); } catch { /* ok */ }
  });

  it('loads and converts a valid JGF file', () => {
    const jgfData = {
      graph: {
        directed: true,
        nodes: {
          sap: { label: 'SAP ERP', metadata: { type: 'erp', description: 'Enterprise Resource Planning' } },
          db: { label: 'PostgreSQL', metadata: { type: 'database' } },
        },
        edges: [
          { source: 'sap', target: 'db', relation: 'stores data' },
        ],
      },
    };
    writeFileSync(JGF_PATH, JSON.stringify(jgfData), 'utf8');

    const graph = loadJGFFile(JGF_PATH);
    expect(graph).not.toBeNull();
    expect(graph!.nodes).toHaveLength(2);
    expect(graph!.nodes.find(n => n.id === 'sap')!.label).toBe('SAP ERP');
    expect(graph!.nodes.find(n => n.id === 'sap')!.type).toBe('erp');
    expect(graph!.nodes.find(n => n.id === 'db')!.label).toBe('PostgreSQL');
    expect(graph!.edges).toHaveLength(1);
    expect(graph!.edges[0]!.source).toBe('sap');
    expect(graph!.edges[0]!.target).toBe('db');
    expect(graph!.edges[0]!.label).toBe('stores data');
  });

  it('uses node ID as label when label is missing', () => {
    const jgfData = {
      graph: {
        nodes: {
          myservice: { metadata: { type: 'api' } },
        },
        edges: [],
      },
    };
    writeFileSync(JGF_PATH, JSON.stringify(jgfData), 'utf8');

    const graph = loadJGFFile(JGF_PATH);
    expect(graph).not.toBeNull();
    expect(graph!.nodes[0]!.id).toBe('myservice');
    expect(graph!.nodes[0]!.label).toBe('myservice');
  });

  it('handles JGF with empty edges', () => {
    const jgfData = {
      graph: {
        nodes: {
          a: { label: 'Node A' },
          b: { label: 'Node B' },
        },
      },
    };
    writeFileSync(JGF_PATH, JSON.stringify(jgfData), 'utf8');

    const graph = loadJGFFile(JGF_PATH);
    expect(graph).not.toBeNull();
    expect(graph!.nodes).toHaveLength(2);
    expect(graph!.edges).toHaveLength(0);
  });

  it('falls back to internal {nodes, edges} format', () => {
    writeFileSync(JGF_PATH, JSON.stringify(testGraph), 'utf8');

    const graph = loadJGFFile(JGF_PATH);
    expect(graph).not.toBeNull();
    expect(graph!.nodes).toHaveLength(5);
    expect(graph!.edges).toHaveLength(3);
  });

  it('returns null for invalid file', () => {
    writeFileSync(JGF_PATH, 'not json', 'utf8');
    expect(loadJGFFile(JGF_PATH)).toBeNull();
  });

  it('returns null for invalid schema', () => {
    writeFileSync(JGF_PATH, JSON.stringify({ foo: 'bar' }), 'utf8');
    expect(loadJGFFile(JGF_PATH)).toBeNull();
  });

  it('returns null for missing file', () => {
    expect(loadJGFFile('/nonexistent/path.json')).toBeNull();
  });

  it('converts JGF graph metadata', () => {
    const jgfData = {
      graph: {
        nodes: { a: { label: 'A' } },
        edges: [],
        metadata: { version: '2.0', scanned_at: '2026-01-01' },
      },
    };
    writeFileSync(JGF_PATH, JSON.stringify(jgfData), 'utf8');

    const graph = loadJGFFile(JGF_PATH);
    expect(graph).not.toBeNull();
    expect(graph!.metadata).toEqual({ version: '2.0', scanned_at: '2026-01-01' });
  });

  it('prefers relation over label for edge labels in JGF', () => {
    const jgfData = {
      graph: {
        nodes: { a: { label: 'A' }, b: { label: 'B' } },
        edges: [
          { source: 'a', target: 'b', relation: 'depends_on', label: 'fallback' },
        ],
      },
    };
    writeFileSync(JGF_PATH, JSON.stringify(jgfData), 'utf8');

    const graph = loadJGFFile(JGF_PATH);
    expect(graph!.edges[0]!.label).toBe('depends_on');
  });
});
