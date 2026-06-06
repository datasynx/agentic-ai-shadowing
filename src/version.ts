import { readFileSync } from 'node:fs';

/**
 * Resolve the package version from package.json at runtime.
 *
 * The CLI (`--version`) and the MCP server (`serverInfo.version`) used to
 * hardcode "0.1.0", which drifted out of sync with the actually published
 * version (see issue #12). Reading from package.json keeps every surface
 * consistent automatically. package.json sits one directory above both
 * `src/` (dev via tsx) and `dist/` (built), so the relative URL resolves in
 * both cases.
 */
export function getPackageVersion(): string {
  try {
    const url = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
