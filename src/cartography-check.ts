import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { getConfigDir } from './config.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CartographyCheckResult {
  installed: boolean;
  packagePath: string | null;
  jgfPath: string | null;
}

const JGF_FILENAME = 'cartography-graph.jgf.json';
const CARTOGRAPHY_PACKAGE = '@datasynx/agentic-ai-cartography';

// ── Package Detection ────────────────────────────────────────────────────────

export function checkCartographyInstalled(): CartographyCheckResult {
  let packagePath: string | null = null;

  // Strategy 1: createRequire (ESM-compatible, follows Node resolution)
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve(`${CARTOGRAPHY_PACKAGE}/package.json`);
    packagePath = join(pkgJsonPath, '..');
  } catch {
    // Not found via require.resolve
  }

  // Strategy 2: Direct filesystem check (handles edge cases)
  if (!packagePath) {
    const candidates = [
      join(process.cwd(), 'node_modules', ...CARTOGRAPHY_PACKAGE.split('/')),
      join(process.cwd(), '..', 'node_modules', ...CARTOGRAPHY_PACKAGE.split('/')),
    ];
    for (const candidate of candidates) {
      if (existsSync(join(candidate, 'package.json'))) {
        packagePath = candidate;
        break;
      }
    }
  }

  const jgfPath = locateJGFFile(packagePath);

  return { installed: packagePath !== null, packagePath, jgfPath };
}

// ── JGF File Location ────────────────────────────────────────────────────────

export function locateJGFFile(packagePath: string | null): string | null {
  const candidates: string[] = [];

  // 1. Default cartography export path: ./datasynx-output/cartography-graph.jgf.json
  candidates.push(resolve(process.cwd(), 'datasynx-output', JGF_FILENAME));

  // 2. Package directory (if installed)
  if (packagePath) {
    candidates.push(join(packagePath, JGF_FILENAME));
    candidates.push(join(packagePath, 'datasynx-output', JGF_FILENAME));
  }

  // 3. Current working directory
  candidates.push(resolve(process.cwd(), JGF_FILENAME));

  // 4. Config directory (~/.datasynx/shadowing/)
  candidates.push(join(getConfigDir(), JGF_FILENAME));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

// ── Guard Function ───────────────────────────────────────────────────────────

export function ensureCartography(): CartographyCheckResult {
  const result = checkCartographyInstalled();

  if (!result.installed) {
    process.stderr.write(
      `agentic-ai-cartography is not installed.\n` +
      `Shadowing uses the nodes from agentic-ai-cartography as a foundation.\n` +
      `Please install it with:\n\n` +
      `  npm install @datasynx/agentic-ai-cartography\n\n`,
    );
    process.exitCode = 1;
    throw new Error('Cartography package not installed');
  }

  return result;
}
