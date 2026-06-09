/**
 * Optional file-system watching for observation sessions (#29).
 *
 * Off by default (`shadowing observe --watch-files [dir]`), gated behind the
 * `file` consent scope. Exclusion rules and a built-in deny list are applied
 * BEFORE anything is logged; the capture redactor (redact-on-capture, #20)
 * runs at the DB layer like every other observed action. Events are debounced
 * and the pending buffer is capped so a noisy build can't degrade the machine.
 */

import { watch, type FSWatcher } from 'chokidar';
import { relative } from 'node:path';
import type { ShadowingDB } from './db.js';
import type { ExclusionRule } from './types.js';
import { matchesExclusionRules } from './observer.js';
import { getLogger } from './logger.js';

const log = getLogger('file-watcher');

/** Paths that never produce observation rows, regardless of user rules. */
const ALWAYS_IGNORED = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)\.cache(\/|$)/,
];

export interface FileWatcherOptions {
  /** Debounce window for batching rapid saves (ms, default 1000). */
  debounceMs?: number;
  /** Max buffered events per flush — overflow is dropped with a warning (default 200). */
  maxBuffer?: number;
}

export function shouldIgnorePath(relPath: string, rules: ExclusionRule[]): boolean {
  if (ALWAYS_IGNORED.some(re => re.test(relPath))) return true;
  return matchesExclusionRules(rules, { file_path: relPath });
}

export interface ObservedFileEvent { event: string; path: string }

/**
 * Watch `rootDir` and log add/change/unlink events into the observation
 * session. Returns the watcher; callers must `close()` it on shutdown.
 */
export function createFileWatcher(
  db: ShadowingDB,
  sessionId: string,
  rootDir: string,
  opts?: FileWatcherOptions,
): FSWatcher {
  const debounceMs = opts?.debounceMs ?? 1000;
  const maxBuffer = opts?.maxBuffer ?? 200;

  let pending: ObservedFileEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dropped = 0;

  function flush(): void {
    timer = null;
    const batch = pending;
    pending = [];
    if (dropped > 0) {
      log.warn('File watcher buffer overflow — events dropped', { dropped });
      dropped = 0;
    }
    for (const { event, path } of batch) {
      try {
        db.logObservedAction(sessionId, {
          source: 'file',
          window_title: `File ${event}: ${path}`,
          file_path: path,
        });
      } catch (err) {
        log.warn('Failed to log file event', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const watcher = watch(rootDir, {
    ignoreInitial: true,
    ignored: (path: string) => {
      const rel = relative(rootDir, path);
      if (rel === '' || rel.startsWith('..')) return false;
      return shouldIgnorePath(rel, db.listExclusionRules());
    },
  });

  for (const event of ['add', 'change', 'unlink'] as const) {
    watcher.on(event, (path: string) => {
      const rel = relative(rootDir, path);
      // Defense in depth: chokidar's ignore already filtered, but rules can
      // change mid-session — re-check before buffering.
      if (shouldIgnorePath(rel, db.listExclusionRules())) return;
      if (pending.length >= maxBuffer) { dropped++; return; }
      pending.push({ event, path: rel });
      if (!timer) timer = setTimeout(flush, debounceMs);
    });
  }

  watcher.on('error', (err) => {
    log.warn('File watcher error', { error: err instanceof Error ? err.message : String(err) });
  });

  return watcher;
}
