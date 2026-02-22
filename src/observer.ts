import type { ShadowingDB } from './db.js';
import type { ActionSource, ObservedAction, ObservationSession, ObserverConfig } from './types.js';
import type { ExclusionRule } from './types.js';

// ── Default Observer Config ──────────────────────────────────────────────────

export function getDefaultObserverConfig(): ObserverConfig {
  return {
    poll_interval_ms: 5000,
    watch_git: true,
    watch_files: true,
    capture_shell_history: true,
    work_hours_only: false,
    work_hours_start: 8,
    work_hours_end: 18,
  };
}

// ── Window Info Type ─────────────────────────────────────────────────────────

export interface WindowInfo {
  app_name: string;
  window_title: string;
}

// ── Observer ─────────────────────────────────────────────────────────────────

/**
 * The Observer captures workflow actions using a heartbeat deduplication pattern.
 *
 * Instead of logging every poll as a separate event, consecutive polls that detect
 * the same state (same app + window title) are merged into a single action with
 * an extended duration. A new action is only created when:
 *   1. The state changes (different app/window), or
 *   2. The gap between polls exceeds pulsetime (default: 2x poll interval)
 *
 * This approach (from ActivityWatch architecture) dramatically reduces data volume
 * while preserving accurate time tracking.
 */
export class Observer {
  private db: ShadowingDB;
  private config: ObserverConfig;
  private session: ObservationSession | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private windowDetector: (() => Promise<WindowInfo | null>) | null = null;
  private shellHistoryReader: (() => Promise<ShellCommand[]>) | null = null;
  private lastShellHistoryTimestamp: string | null = null;

  constructor(db: ShadowingDB, config?: Partial<ObserverConfig>) {
    this.db = db;
    this.config = { ...getDefaultObserverConfig(), ...config };
  }

  /**
   * Register a custom window detector function.
   * By default, no window detection is active (works on headless systems too).
   */
  setWindowDetector(detector: () => Promise<WindowInfo | null>): void {
    this.windowDetector = detector;
  }

  /**
   * Register a shell history reader that returns new commands since last check.
   */
  setShellHistoryReader(reader: () => Promise<ShellCommand[]>): void {
    this.shellHistoryReader = reader;
  }

  getSession(): ObservationSession | null {
    return this.session;
  }

  isRunning(): boolean {
    return this.pollTimer !== null;
  }

  /**
   * Start an observation session with periodic polling.
   */
  start(title?: string): ObservationSession {
    if (this.session && this.pollTimer) {
      throw new Error('Observer is already running');
    }

    // Resume or create session
    const active = this.db.getActiveObservationSession();
    this.session = active ?? this.db.startObservationSession(title);

    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.config.poll_interval_ms);

    // Initial poll immediately
    void this.poll();

    return this.session;
  }

  /**
   * Stop the observer and complete the session.
   */
  stop(): ObservationSession | null {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.session) {
      const completed = this.db.completeObservationSession(this.session.id);
      this.session = null;
      return completed;
    }

    return null;
  }

  /**
   * Pause the observer without completing the session.
   */
  pause(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.session) {
      this.session = this.db.pauseObservationSession(this.session.id);
    }
  }

  /**
   * Resume a paused observer.
   */
  resume(): void {
    if (this.session) {
      this.session = this.db.resumeObservationSession(this.session.id);
      this.pollTimer = setInterval(() => {
        void this.poll();
      }, this.config.poll_interval_ms);
      void this.poll();
    }
  }

  /**
   * Log a manual action (e.g. from CLI input).
   */
  logManualAction(description: string): ObservedAction | null {
    if (!this.session) return null;
    return this.db.logObservedAction(this.session.id, {
      source: 'manual',
      window_title: description,
    });
  }

  /**
   * Single poll iteration — captures current state and applies heartbeat logic.
   */
  async poll(): Promise<void> {
    if (!this.session) return;

    // Work hours check
    if (this.config.work_hours_only && !isWithinWorkHours(this.config)) {
      return;
    }

    // 1. Window detection
    if (this.windowDetector) {
      try {
        const windowInfo = await this.windowDetector();
        if (windowInfo && !this.isExcluded(windowInfo)) {
          this.heartbeatOrCreate('window', windowInfo);
        }
      } catch {
        // Window detection can fail silently (e.g. Wayland, headless)
      }
    }

    // 2. Shell history
    if (this.config.capture_shell_history && this.shellHistoryReader) {
      try {
        const commands = await this.shellHistoryReader();
        for (const cmd of commands) {
          if (this.lastShellHistoryTimestamp && cmd.timestamp <= this.lastShellHistoryTimestamp) {
            continue; // Skip already-seen commands
          }
          if (!this.isCommandExcluded(cmd.command)) {
            this.db.logObservedAction(this.session.id, {
              source: 'shell',
              command: cmd.command,
              started_at: cmd.timestamp,
              ended_at: cmd.timestamp,
              duration_seconds: cmd.duration_seconds ?? 0,
            });
          }
        }
        if (commands.length > 0) {
          this.lastShellHistoryTimestamp = commands[commands.length - 1]!.timestamp;
        }
      } catch {
        // Shell history parsing can fail silently
      }
    }
  }

  /**
   * Apply the heartbeat pattern: merge with last action or create a new one.
   */
  private heartbeatOrCreate(source: ActionSource, info: WindowInfo): void {
    if (!this.session) return;

    const pulsetime = Math.ceil(this.config.poll_interval_ms / 1000) * 2;

    const merged = this.db.heartbeatAction(this.session.id, {
      source,
      app_name: info.app_name,
      window_title: info.window_title,
      pulsetime_seconds: pulsetime,
    });

    if (!merged) {
      // State changed or gap too large — create new action
      this.db.logObservedAction(this.session.id, {
        source,
        app_name: info.app_name,
        window_title: info.window_title,
      });
    }
  }

  /**
   * Check if the window info matches any exclusion rules.
   */
  private isExcluded(info: WindowInfo): boolean {
    const rules = this.db.listExclusionRules();
    return matchesExclusionRules(rules, {
      app_name: info.app_name,
      window_title: info.window_title,
    });
  }

  /**
   * Check if a shell command matches any exclusion rules.
   */
  private isCommandExcluded(command: string): boolean {
    const rules = this.db.listExclusionRules();
    return rules.some(rule => {
      if (rule.rule_type !== 'title_pattern') return false;
      return matchesPattern(rule.pattern, command);
    });
  }
}

// ── Shell Command Type ───────────────────────────────────────────────────────

export interface ShellCommand {
  command: string;
  timestamp: string; // ISO 8601
  duration_seconds?: number;
}

// ── Exclusion Matching ───────────────────────────────────────────────────────

export function matchesExclusionRules(
  rules: ExclusionRule[],
  context: {
    app_name?: string;
    window_title?: string;
    url?: string;
    file_path?: string;
  },
): boolean {
  for (const rule of rules) {
    switch (rule.rule_type) {
      case 'app':
        if (context.app_name && matchesPattern(rule.pattern, context.app_name)) return true;
        break;
      case 'title_pattern':
        if (context.window_title && matchesPattern(rule.pattern, context.window_title)) return true;
        break;
      case 'url_pattern':
        if (context.url && matchesPattern(rule.pattern, context.url)) return true;
        break;
      case 'path_pattern':
        if (context.file_path && matchesPattern(rule.pattern, context.file_path)) return true;
        break;
    }
  }
  return false;
}

/**
 * Simple glob-like pattern matching.
 * Supports: * (any chars), ? (single char), case-insensitive.
 */
export function matchesPattern(pattern: string, value: string): boolean {
  const escapedPattern = pattern
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp(`^${escapedPattern}$`, 'i');
  return regex.test(value);
}

// ── Work Hours Check ─────────────────────────────────────────────────────────

export function isWithinWorkHours(config: ObserverConfig): boolean {
  const now = new Date();
  const hour = now.getHours();
  return hour >= config.work_hours_start && hour < config.work_hours_end;
}
