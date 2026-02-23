import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkCartographyInstalled,
  locateJGFFile,
  ensureCartography,
} from '../src/cartography-check.js';

const TEST_DIR = join(tmpdir(), `carto-check-test-${Date.now()}`);
const JGF_FILENAME = 'cartography-graph.jgf.json';

const validJGF = {
  graph: {
    directed: true,
    nodes: {
      sap: { label: 'SAP ERP', metadata: { type: 'erp' } },
      db: { label: 'PostgreSQL', metadata: { type: 'database' } },
    },
    edges: [
      { source: 'sap', target: 'db', relation: 'stores data' },
    ],
  },
};

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ok */ }
});

describe('checkCartographyInstalled', () => {
  it('returns a result object with installed, packagePath, and jgfPath fields', () => {
    const result = checkCartographyInstalled();
    expect(result).toHaveProperty('installed');
    expect(result).toHaveProperty('packagePath');
    expect(result).toHaveProperty('jgfPath');
    expect(typeof result.installed).toBe('boolean');
  });

  it('detects package when it exists in node_modules', () => {
    // Create a fake package in a temp node_modules
    const fakeNodeModules = join(TEST_DIR, 'node_modules', '@datasynx', 'agentic-ai-cartography');
    mkdirSync(fakeNodeModules, { recursive: true });
    writeFileSync(join(fakeNodeModules, 'package.json'), JSON.stringify({ name: '@datasynx/agentic-ai-cartography', version: '0.3.0' }));

    // Save and mock cwd
    const originalCwd = process.cwd;
    process.cwd = () => TEST_DIR;

    try {
      const result = checkCartographyInstalled();
      // The filesystem fallback should find it
      expect(result.installed).toBe(true);
      expect(result.packagePath).toBe(fakeNodeModules);
    } finally {
      process.cwd = originalCwd;
    }
  });
});

describe('locateJGFFile', () => {
  it('finds JGF file in datasynx-output directory', () => {
    const outputDir = join(TEST_DIR, 'datasynx-output');
    mkdirSync(outputDir, { recursive: true });
    const jgfPath = join(outputDir, JGF_FILENAME);
    writeFileSync(jgfPath, JSON.stringify(validJGF));

    const originalCwd = process.cwd;
    process.cwd = () => TEST_DIR;

    try {
      const found = locateJGFFile(null);
      expect(found).toBe(jgfPath);
    } finally {
      process.cwd = originalCwd;
    }
  });

  it('finds JGF file in package directory', () => {
    const pkgDir = join(TEST_DIR, 'pkg');
    mkdirSync(pkgDir, { recursive: true });
    const jgfPath = join(pkgDir, JGF_FILENAME);
    writeFileSync(jgfPath, JSON.stringify(validJGF));

    // Use a cwd without any JGF files so only package path is found
    const emptyCwd = join(TEST_DIR, 'empty');
    mkdirSync(emptyCwd, { recursive: true });
    const originalCwd = process.cwd;
    process.cwd = () => emptyCwd;

    try {
      const found = locateJGFFile(pkgDir);
      expect(found).toBe(jgfPath);
    } finally {
      process.cwd = originalCwd;
    }
  });

  it('finds JGF file in current working directory', () => {
    const jgfPath = join(TEST_DIR, JGF_FILENAME);
    writeFileSync(jgfPath, JSON.stringify(validJGF));

    const originalCwd = process.cwd;
    process.cwd = () => TEST_DIR;

    try {
      const found = locateJGFFile(null);
      expect(found).toBe(jgfPath);
    } finally {
      process.cwd = originalCwd;
    }
  });

  it('returns null when JGF file does not exist anywhere', () => {
    const emptyCwd = join(TEST_DIR, 'empty');
    mkdirSync(emptyCwd, { recursive: true });
    const originalCwd = process.cwd;
    process.cwd = () => emptyCwd;

    try {
      const found = locateJGFFile(null);
      expect(found).toBeNull();
    } finally {
      process.cwd = originalCwd;
    }
  });

  it('prioritizes datasynx-output over cwd', () => {
    // Create JGF in both locations
    const outputDir = join(TEST_DIR, 'datasynx-output');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, JGF_FILENAME), JSON.stringify(validJGF));
    writeFileSync(join(TEST_DIR, JGF_FILENAME), JSON.stringify(validJGF));

    const originalCwd = process.cwd;
    process.cwd = () => TEST_DIR;

    try {
      const found = locateJGFFile(null);
      expect(found).toBe(join(outputDir, JGF_FILENAME));
    } finally {
      process.cwd = originalCwd;
    }
  });
});

describe('ensureCartography', () => {
  it('throws when cartography package is not installed', () => {
    // Use a temp dir with no node_modules
    const emptyCwd = join(TEST_DIR, 'empty');
    mkdirSync(emptyCwd, { recursive: true });
    const originalCwd = process.cwd;
    process.cwd = () => emptyCwd;

    // Mock createRequire to fail
    const originalExitCode = process.exitCode;

    try {
      expect(() => ensureCartography()).toThrow('Cartography package not installed');
      expect(process.exitCode).toBe(1);
    } finally {
      process.cwd = originalCwd;
      process.exitCode = originalExitCode;
    }
  });

  it('returns result when cartography is installed', () => {
    // Create fake package
    const fakeNodeModules = join(TEST_DIR, 'node_modules', '@datasynx', 'agentic-ai-cartography');
    mkdirSync(fakeNodeModules, { recursive: true });
    writeFileSync(join(fakeNodeModules, 'package.json'), JSON.stringify({ name: '@datasynx/agentic-ai-cartography', version: '0.3.0' }));

    const originalCwd = process.cwd;
    process.cwd = () => TEST_DIR;

    try {
      const result = ensureCartography();
      expect(result.installed).toBe(true);
      expect(result.packagePath).toBe(fakeNodeModules);
    } finally {
      process.cwd = originalCwd;
    }
  });

  it('includes jgfPath when JGF file exists alongside package', () => {
    // Create fake package + JGF file
    const fakeNodeModules = join(TEST_DIR, 'node_modules', '@datasynx', 'agentic-ai-cartography');
    mkdirSync(fakeNodeModules, { recursive: true });
    writeFileSync(join(fakeNodeModules, 'package.json'), JSON.stringify({ name: '@datasynx/agentic-ai-cartography', version: '0.3.0' }));

    const outputDir = join(TEST_DIR, 'datasynx-output');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, JGF_FILENAME), JSON.stringify(validJGF));

    const originalCwd = process.cwd;
    process.cwd = () => TEST_DIR;

    try {
      const result = ensureCartography();
      expect(result.installed).toBe(true);
      expect(result.jgfPath).toBe(join(outputDir, JGF_FILENAME));
    } finally {
      process.cwd = originalCwd;
    }
  });
});
