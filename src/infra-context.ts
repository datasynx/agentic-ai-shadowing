import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { InfraGraph, InfraNode, InfraEdge } from './types.js';

// ── Infrastructure Context Builder ───────────────────────────────────────────

/**
 * Scans a project directory and builds an infrastructure graph
 * from package.json, docker-compose.yml, .env files, Makefile, etc.
 */
export function buildInfraGraph(projectDir: string): InfraGraph {
  const nodes: InfraNode[] = [];
  const edges: InfraEdge[] = [];

  // Parse package.json
  const pkgNodes = parsePackageJson(join(projectDir, 'package.json'));
  nodes.push(...pkgNodes);

  // Parse docker-compose files
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const composePath = join(projectDir, name);
    if (existsSync(composePath)) {
      const { nodes: composeNodes, edges: composeEdges } = parseDockerCompose(composePath);
      nodes.push(...composeNodes);
      edges.push(...composeEdges);
    }
  }

  // Parse .env files
  const envNodes = parseEnvFiles(projectDir);
  nodes.push(...envNodes);

  // Parse Makefile targets
  const makePath = join(projectDir, 'Makefile');
  if (existsSync(makePath)) {
    const makeNodes = parseMakefile(makePath);
    nodes.push(...makeNodes);
  }

  // Parse Procfile (Heroku/Foreman)
  const procPath = join(projectDir, 'Procfile');
  if (existsSync(procPath)) {
    const procNodes = parseProcfile(procPath);
    nodes.push(...procNodes);
  }

  // Deduplicate nodes by name
  const seen = new Set<string>();
  const uniqueNodes = nodes.filter(n => {
    const key = `${n.name}:${n.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { nodes: uniqueNodes, edges };
}

// ── package.json Parser ──────────────────────────────────────────────────────

function parsePackageJson(path: string): InfraNode[] {
  if (!existsSync(path)) return [];

  try {
    const raw = readFileSync(path, 'utf8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const nodes: InfraNode[] = [];

    // Main project node
    const name = (pkg['name'] as string) ?? basename(join(path, '..'));
    nodes.push({
      name,
      type: 'api',
      source: 'package.json',
      metadata: {
        version: pkg['version'] ?? 'unknown',
        description: pkg['description'] ?? '',
      },
    });

    // Extract key dependencies as tool nodes
    const deps = { ...(pkg['dependencies'] as Record<string, string> ?? {}) };
    const devDeps = { ...(pkg['devDependencies'] as Record<string, string> ?? {}) };
    const allDeps = { ...deps, ...devDeps };

    // Identify databases and services from dependencies
    const dbMap: Record<string, { type: InfraNode['type']; label: string }> = {
      'better-sqlite3': { type: 'database', label: 'SQLite' },
      'sqlite3': { type: 'database', label: 'SQLite' },
      'pg': { type: 'database', label: 'PostgreSQL' },
      'mysql2': { type: 'database', label: 'MySQL' },
      'mongodb': { type: 'database', label: 'MongoDB' },
      'mongoose': { type: 'database', label: 'MongoDB' },
      'redis': { type: 'cache', label: 'Redis' },
      'ioredis': { type: 'cache', label: 'Redis' },
      'amqplib': { type: 'queue', label: 'RabbitMQ' },
      'bull': { type: 'queue', label: 'Redis Queue' },
      'kafkajs': { type: 'queue', label: 'Kafka' },
    };

    for (const [dep, info] of Object.entries(dbMap)) {
      if (dep in allDeps) {
        nodes.push({
          name: info.label,
          type: info.type,
          source: 'package.json',
          metadata: { package: dep, version: allDeps[dep] },
        });
      }
    }

    // Extract scripts as tools
    const scripts = pkg['scripts'] as Record<string, string> | undefined;
    if (scripts) {
      for (const [scriptName, scriptCmd] of Object.entries(scripts)) {
        nodes.push({
          name: `npm:${scriptName}`,
          type: 'tool',
          source: 'package.json',
          metadata: { command: scriptCmd },
        });
      }
    }

    return nodes;
  } catch {
    return [];
  }
}

// ── docker-compose Parser ────────────────────────────────────────────────────

/**
 * Simple YAML-like parser for docker-compose service names and depends_on.
 * Does NOT use a full YAML parser to avoid adding a dependency.
 */
function parseDockerCompose(path: string): { nodes: InfraNode[]; edges: InfraEdge[] } {
  const nodes: InfraNode[] = [];
  const edges: InfraEdge[] = [];

  try {
    const raw = readFileSync(path, 'utf8');
    const lines = raw.split('\n');

    let inServices = false;
    let currentService: string | null = null;
    let inDependsOn = false;
    let serviceIndent = 0;

    for (const line of lines) {
      const trimmedLeft = line.trimStart();
      const stripped = trimmedLeft.trimEnd();
      if (!stripped || stripped.startsWith('#')) continue;

      const indent = line.length - line.trimStart().length;

      // Top-level "services:" key
      if (stripped === 'services:' && indent === 0) {
        inServices = true;
        continue;
      }

      // Another top-level key ends services block
      if (inServices && indent === 0 && stripped.endsWith(':') && stripped !== 'services:') {
        inServices = false;
        currentService = null;
        continue;
      }

      if (!inServices) continue;

      // Service name: first indent level (typically indent=2), ends with :, no spaces
      // Only match at the service indent level, not deeper property keys
      if (indent > 0 && stripped.endsWith(':') && !stripped.slice(0, -1).includes(' ')) {
        // If we already have a service, this is only a new service if it's at the same indent level
        if (currentService === null || indent <= serviceIndent) {
          currentService = stripped.slice(0, -1);
          serviceIndent = indent;
          inDependsOn = false;

          const serviceType = inferServiceType(currentService);
          nodes.push({
            name: currentService,
            type: serviceType,
            source: basename(path),
            metadata: {},
          });
          continue;
        }
      }

      if (!currentService) continue;

      // Parse depends_on
      if (indent > serviceIndent && stripped === 'depends_on:') {
        inDependsOn = true;
        continue;
      }

      // New service-level key ends depends_on
      if (inDependsOn && indent <= serviceIndent + 2 && !stripped.startsWith('-')) {
        inDependsOn = false;
      }

      if (inDependsOn && stripped.startsWith('- ')) {
        const dep = stripped.substring(2).trim().replace(/:$/, '');
        edges.push({
          source: currentService,
          target: dep,
          relation: 'depends_on',
        });
      }

      // Parse image for metadata
      if (indent > serviceIndent) {
        const imageMatch = /^image:\s*(.+)$/.exec(stripped);
        if (imageMatch) {
          const existing = nodes.find(n => n.name === currentService);
          if (existing) {
            existing.metadata['image'] = imageMatch[1]!.trim();
          }
        }

        const portsMatch = /^-\s*"?(\d+):(\d+)"?/.exec(stripped);
        if (portsMatch) {
          const existing = nodes.find(n => n.name === currentService);
          if (existing) {
            const ports = (existing.metadata['ports'] as string[] ?? []);
            ports.push(`${portsMatch[1]}:${portsMatch[2]}`);
            existing.metadata['ports'] = ports;
          }
        }
      }
    }

    return { nodes, edges };
  } catch {
    return { nodes: [], edges: [] };
  }
}

function inferServiceType(name: string): InfraNode['type'] {
  const lower = name.toLowerCase();
  if (['postgres', 'postgresql', 'mysql', 'mariadb', 'mongo', 'mongodb', 'sqlite', 'db', 'database'].some(k => lower.includes(k))) return 'database';
  if (['redis', 'memcached', 'cache'].some(k => lower.includes(k))) return 'cache';
  if (['rabbitmq', 'kafka', 'nats', 'queue', 'broker'].some(k => lower.includes(k))) return 'queue';
  if (['nginx', 'traefik', 'caddy', 'web', 'frontend', 'ui'].some(k => lower.includes(k))) return 'frontend';
  if (['api', 'backend', 'server', 'app', 'worker'].some(k => lower.includes(k))) return 'api';
  return 'service';
}

// ── .env Parser ──────────────────────────────────────────────────────────────

function parseEnvFiles(projectDir: string): InfraNode[] {
  const nodes: InfraNode[] = [];
  const envFiles = ['.env', '.env.local', '.env.example', '.env.development', '.env.production'];

  for (const envFile of envFiles) {
    const envPath = join(projectDir, envFile);
    if (!existsSync(envPath)) continue;

    try {
      const raw = readFileSync(envPath, 'utf8');
      const vars = parseEnvContent(raw);

      // Extract service URLs from env vars
      for (const [key, value] of Object.entries(vars)) {
        const lowerKey = key.toLowerCase();
        if (lowerKey.includes('database_url') || lowerKey.includes('db_url')) {
          const dbType = inferDbTypeFromUrl(value);
          if (dbType) {
            nodes.push({
              name: dbType,
              type: 'database',
              source: envFile,
              metadata: { env_var: key },
            });
          }
        } else if (lowerKey.includes('redis_url') || lowerKey.includes('cache_url')) {
          nodes.push({
            name: 'Redis',
            type: 'cache',
            source: envFile,
            metadata: { env_var: key },
          });
        } else if (lowerKey.includes('amqp_url') || lowerKey.includes('rabbitmq_url')) {
          nodes.push({
            name: 'RabbitMQ',
            type: 'queue',
            source: envFile,
            metadata: { env_var: key },
          });
        }
      }
    } catch {
      // skip
    }
  }

  return nodes;
}

function parseEnvContent(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim().replace(/^["']|["']$/g, '');
      vars[key] = value;
    }
  }
  return vars;
}

function inferDbTypeFromUrl(url: string): string | null {
  if (url.startsWith('postgres')) return 'PostgreSQL';
  if (url.startsWith('mysql')) return 'MySQL';
  if (url.startsWith('mongodb')) return 'MongoDB';
  if (url.startsWith('sqlite')) return 'SQLite';
  return null;
}

// ── Makefile Parser ──────────────────────────────────────────────────────────

function parseMakefile(path: string): InfraNode[] {
  const nodes: InfraNode[] = [];

  try {
    const raw = readFileSync(path, 'utf8');
    const targetPattern = /^([a-zA-Z_][\w-]*):/gm;
    let match: RegExpExecArray | null;

    while ((match = targetPattern.exec(raw)) !== null) {
      nodes.push({
        name: `make:${match[1]}`,
        type: 'tool',
        source: 'Makefile',
        metadata: {},
      });
    }
  } catch {
    // skip
  }

  return nodes;
}

// ── Procfile Parser ──────────────────────────────────────────────────────────

function parseProcfile(path: string): InfraNode[] {
  const nodes: InfraNode[] = [];

  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex > 0) {
        const name = trimmed.substring(0, colonIndex).trim();
        const command = trimmed.substring(colonIndex + 1).trim();
        nodes.push({
          name,
          type: name === 'web' ? 'frontend' : 'api',
          source: 'Procfile',
          metadata: { command },
        });
      }
    }
  } catch {
    // skip
  }

  return nodes;
}

// ── Summary Builder ──────────────────────────────────────────────────────────

/**
 * Build a human-readable summary of the infrastructure graph.
 */
export function formatInfraGraph(graph: InfraGraph): string {
  const lines: string[] = [];
  const byType = new Map<string, InfraNode[]>();

  for (const node of graph.nodes) {
    if (!byType.has(node.type)) byType.set(node.type, []);
    byType.get(node.type)!.push(node);
  }

  for (const [type, nodes] of byType) {
    lines.push(`[${type}]`);
    for (const node of nodes) {
      const meta = Object.entries(node.metadata)
        .filter(([, v]) => typeof v === 'string' && v.length < 50)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      lines.push(`  ${node.name}${meta ? ` (${meta})` : ''} — from ${node.source}`);
    }
  }

  if (graph.edges.length > 0) {
    lines.push('\n[relationships]');
    for (const edge of graph.edges) {
      lines.push(`  ${edge.source} → ${edge.target} (${edge.relation})`);
    }
  }

  return lines.join('\n');
}

/**
 * List directory entries, returning just names. Used to scan for config files.
 */
export function listProjectFiles(projectDir: string): string[] {
  try {
    return readdirSync(projectDir, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => e.name);
  } catch {
    return [];
  }
}
