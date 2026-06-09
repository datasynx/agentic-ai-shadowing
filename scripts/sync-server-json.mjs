#!/usr/bin/env node
/**
 * Keep server.json (MCP Registry manifest) in lockstep with the release
 * version. Invoked by semantic-release (prepare step) with the next version;
 * server.json is then committed alongside package.json/CHANGELOG.md, so the
 * npm version and the registry listing can never drift (#32).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  process.stderr.write(`sync-server-json: invalid version argument: ${version ?? '(missing)'}\n`);
  process.exit(1);
}

const path = new URL('../server.json', import.meta.url);
const manifest = JSON.parse(readFileSync(path, 'utf8'));

manifest.version = version;
for (const pkg of manifest.packages ?? []) {
  pkg.version = version;
}

writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
process.stderr.write(`sync-server-json: server.json set to ${version}\n`);
