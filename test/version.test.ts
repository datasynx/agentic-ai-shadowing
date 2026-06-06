import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPackageVersion } from '../src/version.js';

describe('getPackageVersion (issue #12)', () => {
  it('returns the version from package.json', () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { version: string };
    expect(getPackageVersion()).toBe(pkg.version);
  });

  it('returns a valid semver string', () => {
    expect(getPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('never returns the stale hardcoded 0.1.0 unless that is the real version', () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { version: string };
    if (pkg.version !== '0.1.0') {
      expect(getPackageVersion()).not.toBe('0.1.0');
    }
  });
});
