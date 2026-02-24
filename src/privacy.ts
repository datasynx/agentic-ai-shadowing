import type { ShadowingDB } from './db.js';
import type { ExclusionRule } from './types.js';
import { matchesExclusionRules } from './observer.js';

// ── Privacy Manager ──────────────────────────────────────────────────────────

/**
 * Central privacy management: consent, exclusion rules, and data degradation.
 *
 * Privacy tiers:
 * 1. Full detail (0-7 days): window titles, commands, file paths, metadata
 * 2. Reduced detail (7-30 days): app names + durations only (titles/commands stripped)
 * 3. Aggregated (30-90 days): only summary statistics kept
 * 4. Deleted (>90 days): data completely removed
 *
 * All tiers are configurable via the constructor.
 */
export class PrivacyManager {
  private db: ShadowingDB;
  private degradeAfterDays: number;
  private purgeAfterDays: number;

  constructor(db: ShadowingDB, opts?: { degradeAfterDays?: number; purgeAfterDays?: number }) {
    this.db = db;
    this.degradeAfterDays = opts?.degradeAfterDays ?? 7;
    this.purgeAfterDays = opts?.purgeAfterDays ?? 90;
  }

  // ── Consent Management ──────────────────────────────────────────────────

  /**
   * Grant consent for a specific observation scope.
   * Scopes: 'window', 'shell', 'git', 'file', 'all'
   */
  grantConsent(scope: string): void {
    this.db.logConsent('granted', scope);
  }

  /**
   * Revoke consent for a specific observation scope.
   */
  revokeConsent(scope: string): void {
    this.db.logConsent('revoked', scope);
  }

  /**
   * Check if consent is granted for a scope.
   * 'all' scope grants consent for all specific scopes.
   */
  hasConsent(scope: string): boolean {
    if (this.db.hasConsent('all')) return true;
    return this.db.hasConsent(scope);
  }

  /**
   * Get the current consent state for all known scopes.
   */
  getConsentStatus(): Record<string, boolean> {
    const scopes = ['window', 'shell', 'git', 'file', 'all'];
    const result: Record<string, boolean> = {};
    for (const scope of scopes) {
      result[scope] = this.db.hasConsent(scope);
    }
    return result;
  }

  /**
   * Return full consent log.
   */
  getConsentLog() {
    return this.db.getConsentLog();
  }

  // ── Exclusion Rules ─────────────────────────────────────────────────────

  /**
   * Add an exclusion rule. Actions matching this rule will not be recorded.
   */
  addExclusion(ruleType: ExclusionRule['rule_type'], pattern: string): ExclusionRule {
    return this.db.addExclusionRule(ruleType, pattern);
  }

  /**
   * Remove an exclusion rule by ID.
   */
  removeExclusion(id: string): void {
    this.db.removeExclusionRule(id);
  }

  /**
   * List all exclusion rules.
   */
  listExclusions(ruleType?: ExclusionRule['rule_type']): ExclusionRule[] {
    return this.db.listExclusionRules(ruleType);
  }

  /**
   * Check if an action should be excluded based on current rules.
   */
  shouldExclude(context: {
    app_name?: string;
    window_title?: string;
    url?: string;
    file_path?: string;
  }): boolean {
    const rules = this.db.listExclusionRules();
    return matchesExclusionRules(rules, context);
  }

  // ── Data Degradation ────────────────────────────────────────────────────

  /**
   * Apply the full data lifecycle:
   * 1. Degrade old actions (remove detailed fields)
   * 2. Purge very old actions entirely
   *
   * Returns counts of affected rows.
   */
  applyDataLifecycle(): { degraded: number; purged: number } {
    const purged = this.db.purgeOldActions(this.purgeAfterDays);
    const degraded = this.db.degradeOldActions(this.degradeAfterDays);
    return { degraded, purged };
  }

  /**
   * Get data retention info.
   */
  getRetentionPolicy(): { degradeAfterDays: number; purgeAfterDays: number } {
    return {
      degradeAfterDays: this.degradeAfterDays,
      purgeAfterDays: this.purgeAfterDays,
    };
  }
}

// ── Pre-built Exclusion Patterns ─────────────────────────────────────────────

/**
 * Returns common default exclusion patterns for privacy-sensitive applications.
 */
export function getDefaultExclusions(): { rule_type: ExclusionRule['rule_type']; pattern: string; description: string }[] {
  return [
    { rule_type: 'app', pattern: '1Password', description: 'Password manager' },
    { rule_type: 'app', pattern: 'KeePass*', description: 'Password manager' },
    { rule_type: 'app', pattern: 'Bitwarden', description: 'Password manager' },
    { rule_type: 'title_pattern', pattern: '*password*', description: 'Password-related windows' },
    { rule_type: 'title_pattern', pattern: '*banking*', description: 'Banking windows' },
    { rule_type: 'title_pattern', pattern: '*Private*Browsing*', description: 'Private browsing' },
    { rule_type: 'title_pattern', pattern: '*Incognito*', description: 'Incognito mode' },
    { rule_type: 'url_pattern', pattern: '*bank*', description: 'Banking URLs' },
    { rule_type: 'path_pattern', pattern: '*.env*', description: 'Environment files' },
    { rule_type: 'path_pattern', pattern: '*credentials*', description: 'Credential files' },
    { rule_type: 'path_pattern', pattern: '*.pem', description: 'Certificate files' },
    { rule_type: 'path_pattern', pattern: '*id_rsa*', description: 'SSH keys' },
  ];
}
