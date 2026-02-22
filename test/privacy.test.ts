import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShadowingDB } from '../src/db.js';
import { PrivacyManager, getDefaultExclusions } from '../src/privacy.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `shadowing-privacy-test-${Date.now()}.db`);
let db: ShadowingDB;
let privacy: PrivacyManager;

beforeEach(() => {
  db = new ShadowingDB(DB_PATH);
  db.initialize();
  privacy = new PrivacyManager(db, { degradeAfterDays: 7, purgeAfterDays: 90 });
});

afterEach(() => {
  db.close();
  try { unlinkSync(DB_PATH); } catch { /* ok */ }
});

describe('Privacy — Consent Management', () => {
  it('grantConsent and hasConsent work together', () => {
    expect(privacy.hasConsent('window')).toBe(false);
    privacy.grantConsent('window');
    expect(privacy.hasConsent('window')).toBe(true);
  });

  it('revokeConsent withdraws consent', () => {
    privacy.grantConsent('shell');
    expect(privacy.hasConsent('shell')).toBe(true);
    privacy.revokeConsent('shell');
    expect(privacy.hasConsent('shell')).toBe(false);
  });

  it('granting "all" covers specific scopes', () => {
    privacy.grantConsent('all');
    expect(privacy.hasConsent('window')).toBe(true);
    expect(privacy.hasConsent('shell')).toBe(true);
    expect(privacy.hasConsent('file')).toBe(true);
  });

  it('getConsentStatus returns all scopes', () => {
    privacy.grantConsent('window');
    privacy.grantConsent('shell');
    const status = privacy.getConsentStatus();

    expect(status['window']).toBe(true);
    expect(status['shell']).toBe(true);
    expect(status['file']).toBe(false);
    expect(status['all']).toBe(false);
  });

  it('getConsentLog returns the audit trail', () => {
    privacy.grantConsent('window');
    privacy.revokeConsent('window');
    privacy.grantConsent('shell');

    const log = privacy.getConsentLog();
    expect(log).toHaveLength(3);
    // Most recent first
    expect(log[0]!.scope).toBe('shell');
    expect(log[0]!.action).toBe('granted');
    expect(log[1]!.scope).toBe('window');
    expect(log[1]!.action).toBe('revoked');
  });
});

describe('Privacy — Exclusion Rules', () => {
  it('addExclusion creates a rule', () => {
    const rule = privacy.addExclusion('app', '1Password');
    expect(rule.id).toBeTruthy();
    expect(rule.rule_type).toBe('app');
    expect(rule.pattern).toBe('1Password');
  });

  it('listExclusions returns all rules', () => {
    privacy.addExclusion('app', 'Firefox');
    privacy.addExclusion('title_pattern', '*banking*');

    const all = privacy.listExclusions();
    expect(all).toHaveLength(2);
  });

  it('listExclusions filters by type', () => {
    privacy.addExclusion('app', 'Firefox');
    privacy.addExclusion('title_pattern', '*banking*');

    const appRules = privacy.listExclusions('app');
    expect(appRules).toHaveLength(1);
    expect(appRules[0]!.pattern).toBe('Firefox');
  });

  it('removeExclusion deletes a rule', () => {
    const rule = privacy.addExclusion('app', 'Test');
    privacy.removeExclusion(rule.id);
    expect(privacy.listExclusions()).toHaveLength(0);
  });

  it('shouldExclude checks against all rules', () => {
    privacy.addExclusion('app', '1Password');
    privacy.addExclusion('title_pattern', '*banking*');

    expect(privacy.shouldExclude({ app_name: '1Password' })).toBe(true);
    expect(privacy.shouldExclude({ window_title: 'Online Banking' })).toBe(true);
    expect(privacy.shouldExclude({ app_name: 'VS Code' })).toBe(false);
  });
});

describe('Privacy — Data Degradation', () => {
  it('degradeOldActions strips details from old actions', () => {
    const session = db.startObservationSession();

    // Log an action that looks "old" by manipulating the DB directly
    db.logObservedAction(session.id, {
      source: 'window',
      app_name: 'VS Code',
      window_title: 'secret-file.ts',
      command: 'git push',
      file_path: '/home/user/project/secret.ts',
      metadata: { key: 'value' },
    });

    // Degrade with 0 days should affect everything
    const degraded = db.degradeOldActions(0);
    expect(degraded).toBe(1);

    // Check the action was stripped
    const actions = db.getObservedActions(session.id);
    expect(actions[0]!.app_name).toBe('VS Code'); // Kept
    expect(actions[0]!.window_title).toBeNull(); // Stripped
    expect(actions[0]!.command).toBeNull(); // Stripped
    expect(actions[0]!.file_path).toBeNull(); // Stripped
    expect(actions[0]!.metadata).toBeNull(); // Stripped
  });

  it('purgeOldActions removes old actions entirely', () => {
    const session = db.startObservationSession();
    db.logObservedAction(session.id, { source: 'window', app_name: 'Test' });

    // Purge with 0 days should remove everything
    const purged = db.purgeOldActions(0);
    expect(purged).toBe(1);

    const actions = db.getObservedActions(session.id);
    expect(actions).toHaveLength(0);
  });

  it('applyDataLifecycle runs both degrade and purge', () => {
    const session = db.startObservationSession();
    db.logObservedAction(session.id, {
      source: 'window',
      app_name: 'Test',
      window_title: 'Title',
    });

    // Default 7 degrade / 90 purge: recent data should NOT be affected
    const result = privacy.applyDataLifecycle();
    expect(result.purged).toBe(0);
    expect(result.degraded).toBe(0);

    // Verify data is intact
    const actions = db.getObservedActions(session.id);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.window_title).toBe('Title');
  });

  it('getRetentionPolicy returns configured values', () => {
    const policy = privacy.getRetentionPolicy();
    expect(policy.degradeAfterDays).toBe(7);
    expect(policy.purgeAfterDays).toBe(90);
  });
});

describe('Privacy — Default Exclusions', () => {
  it('getDefaultExclusions returns known privacy-sensitive apps', () => {
    const defaults = getDefaultExclusions();
    expect(defaults.length).toBeGreaterThan(5);

    // Check some known defaults
    const apps = defaults.filter(d => d.rule_type === 'app');
    expect(apps.find(a => a.pattern === '1Password')).toBeDefined();
    expect(apps.find(a => a.pattern === 'Bitwarden')).toBeDefined();

    // Check pattern types
    const patterns = defaults.filter(d => d.rule_type === 'title_pattern');
    expect(patterns.find(p => p.pattern === '*password*')).toBeDefined();

    const pathPatterns = defaults.filter(d => d.rule_type === 'path_pattern');
    expect(pathPatterns.find(p => p.pattern === '*.env*')).toBeDefined();
  });

  it('loading defaults creates rules in DB', () => {
    const defaults = getDefaultExclusions();
    for (const def of defaults) {
      privacy.addExclusion(def.rule_type, def.pattern);
    }

    const rules = privacy.listExclusions();
    expect(rules.length).toBe(defaults.length);
  });
});
