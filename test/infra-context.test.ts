import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildInfraGraph, formatInfraGraph, listProjectFiles } from '../src/infra-context.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), `shadowing-infra-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Infra Context — package.json', () => {
  it('extracts project info from package.json', () => {
    writeFileSync(join(TEST_DIR, 'package.json'), JSON.stringify({
      name: 'my-app',
      version: '1.0.0',
      description: 'Test app',
      scripts: { build: 'tsc', test: 'vitest' },
      dependencies: { 'better-sqlite3': '^10.0.0' },
    }));

    const graph = buildInfraGraph(TEST_DIR);

    expect(graph.nodes.length).toBeGreaterThanOrEqual(1);

    // Should find the project node
    const projectNode = graph.nodes.find(n => n.name === 'my-app');
    expect(projectNode).toBeDefined();
    expect(projectNode!.source).toBe('package.json');

    // Should find SQLite from dependency
    const dbNode = graph.nodes.find(n => n.name === 'SQLite');
    expect(dbNode).toBeDefined();
    expect(dbNode!.type).toBe('database');

    // Should find scripts as tools
    const buildScript = graph.nodes.find(n => n.name === 'npm:build');
    expect(buildScript).toBeDefined();
    expect(buildScript!.type).toBe('tool');
  });

  it('detects Redis from dependencies', () => {
    writeFileSync(join(TEST_DIR, 'package.json'), JSON.stringify({
      name: 'redis-app',
      dependencies: { 'ioredis': '^5.0.0' },
    }));

    const graph = buildInfraGraph(TEST_DIR);
    const redisNode = graph.nodes.find(n => n.name === 'Redis');
    expect(redisNode).toBeDefined();
    expect(redisNode!.type).toBe('cache');
  });

  it('handles missing package.json', () => {
    const graph = buildInfraGraph(TEST_DIR);
    expect(graph.nodes).toHaveLength(0);
  });
});

describe('Infra Context — docker-compose', () => {
  it('parses docker-compose.yml services', () => {
    writeFileSync(join(TEST_DIR, 'docker-compose.yml'), `
services:
  api:
    image: node:20
    depends_on:
      - postgres
      - redis
  postgres:
    image: postgres:16
  redis:
    image: redis:7
`);

    const graph = buildInfraGraph(TEST_DIR);

    const apiNode = graph.nodes.find(n => n.name === 'api');
    expect(apiNode).toBeDefined();
    expect(apiNode!.type).toBe('api');

    const pgNode = graph.nodes.find(n => n.name === 'postgres');
    expect(pgNode).toBeDefined();
    expect(pgNode!.type).toBe('database');

    const redisNode = graph.nodes.find(n => n.name === 'redis');
    expect(redisNode).toBeDefined();
    expect(redisNode!.type).toBe('cache');

    // Check edges (depends_on)
    expect(graph.edges.length).toBeGreaterThanOrEqual(2);
    expect(graph.edges.find(e => e.source === 'api' && e.target === 'postgres')).toBeDefined();
    expect(graph.edges.find(e => e.source === 'api' && e.target === 'redis')).toBeDefined();
  });

  it('extracts image metadata', () => {
    writeFileSync(join(TEST_DIR, 'docker-compose.yml'), `
services:
  web:
    image: nginx:latest
`);

    const graph = buildInfraGraph(TEST_DIR);
    const webNode = graph.nodes.find(n => n.name === 'web');
    expect(webNode).toBeDefined();
    expect(webNode!.metadata['image']).toBe('nginx:latest');
  });
});

describe('Infra Context — .env files', () => {
  it('detects database from DATABASE_URL', () => {
    writeFileSync(join(TEST_DIR, '.env'), `
# Database
DATABASE_URL=postgres://user:pass@localhost/mydb
SECRET_KEY=abc123
`);

    const graph = buildInfraGraph(TEST_DIR);
    const pgNode = graph.nodes.find(n => n.name === 'PostgreSQL');
    expect(pgNode).toBeDefined();
    expect(pgNode!.type).toBe('database');
  });

  it('detects Redis from REDIS_URL', () => {
    writeFileSync(join(TEST_DIR, '.env.example'), `
REDIS_URL=redis://localhost:6379
`);

    const graph = buildInfraGraph(TEST_DIR);
    const redisNode = graph.nodes.find(n => n.name === 'Redis');
    expect(redisNode).toBeDefined();
  });
});

describe('Infra Context — Makefile', () => {
  it('extracts Makefile targets', () => {
    writeFileSync(join(TEST_DIR, 'Makefile'), `
build:
\ttsc

test:
\tvitest

deploy:
\tkubectl apply -f k8s/
`);

    const graph = buildInfraGraph(TEST_DIR);
    const buildTarget = graph.nodes.find(n => n.name === 'make:build');
    expect(buildTarget).toBeDefined();
    expect(buildTarget!.type).toBe('tool');

    const deployTarget = graph.nodes.find(n => n.name === 'make:deploy');
    expect(deployTarget).toBeDefined();
  });
});

describe('Infra Context — Procfile', () => {
  it('extracts Procfile entries', () => {
    writeFileSync(join(TEST_DIR, 'Procfile'), `web: node dist/server.js
worker: node dist/worker.js`);

    const graph = buildInfraGraph(TEST_DIR);
    const webNode = graph.nodes.find(n => n.name === 'web');
    expect(webNode).toBeDefined();
    expect(webNode!.type).toBe('frontend');

    const workerNode = graph.nodes.find(n => n.name === 'worker');
    expect(workerNode).toBeDefined();
  });
});

describe('Infra Context — deduplication', () => {
  it('deduplicates nodes by name:type', () => {
    // Both package.json and .env find Redis
    writeFileSync(join(TEST_DIR, 'package.json'), JSON.stringify({
      name: 'test',
      dependencies: { ioredis: '^5.0.0' },
    }));
    writeFileSync(join(TEST_DIR, '.env'), 'REDIS_URL=redis://localhost:6379');

    const graph = buildInfraGraph(TEST_DIR);
    const redisNodes = graph.nodes.filter(n => n.name === 'Redis');
    expect(redisNodes).toHaveLength(1);
  });
});

describe('formatInfraGraph', () => {
  it('produces human-readable output', () => {
    const graph = {
      nodes: [
        { name: 'my-app', type: 'api' as const, source: 'package.json', metadata: {} },
        { name: 'PostgreSQL', type: 'database' as const, source: '.env', metadata: {} },
      ],
      edges: [
        { source: 'my-app', target: 'PostgreSQL', relation: 'uses' },
      ],
    };

    const text = formatInfraGraph(graph);
    expect(text).toContain('[api]');
    expect(text).toContain('my-app');
    expect(text).toContain('[database]');
    expect(text).toContain('PostgreSQL');
    expect(text).toContain('[relationships]');
    expect(text).toContain('→');
  });
});

describe('listProjectFiles', () => {
  it('lists files in directory', () => {
    writeFileSync(join(TEST_DIR, 'file1.txt'), 'hello');
    writeFileSync(join(TEST_DIR, 'file2.ts'), 'export {}');

    const files = listProjectFiles(TEST_DIR);
    expect(files).toContain('file1.txt');
    expect(files).toContain('file2.ts');
  });

  it('handles non-existent directory', () => {
    const files = listProjectFiles('/nonexistent/path');
    expect(files).toHaveLength(0);
  });
});
