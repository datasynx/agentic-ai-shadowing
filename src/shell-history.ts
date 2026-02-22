import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ShellCommand } from './observer.js';

// ── Shell Type Detection ─────────────────────────────────────────────────────

export type ShellType = 'zsh' | 'bash' | 'fish' | 'unknown';

export function detectShell(): ShellType {
  const shell = process.env['SHELL'] ?? '';
  if (shell.includes('zsh')) return 'zsh';
  if (shell.includes('bash')) return 'bash';
  if (shell.includes('fish')) return 'fish';
  return 'unknown';
}

// ── History File Paths ───────────────────────────────────────────────────────

export function getHistoryFilePath(shellType?: ShellType): string | null {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'];
  if (!home) return null;

  const type = shellType ?? detectShell();

  switch (type) {
    case 'zsh': {
      const histFile = process.env['HISTFILE'] ?? join(home, '.zsh_history');
      return existsSync(histFile) ? histFile : null;
    }
    case 'bash': {
      const histFile = process.env['HISTFILE'] ?? join(home, '.bash_history');
      return existsSync(histFile) ? histFile : null;
    }
    case 'fish': {
      const histFile = join(home, '.local', 'share', 'fish', 'fish_history');
      return existsSync(histFile) ? histFile : null;
    }
    default:
      return null;
  }
}

// ── Zsh History Parser ───────────────────────────────────────────────────────

/**
 * Parse zsh extended history format:
 * `: <timestamp>:<duration>;<command>`
 *
 * Falls back to plain line parsing if not extended format.
 */
export function parseZshHistory(content: string): ShellCommand[] {
  const commands: ShellCommand[] = [];
  const lines = content.split('\n');

  // Extended history format pattern: `: 1234567890:0;command`
  const extendedPattern = /^:\s*(\d+):(\d+);(.+)$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = extendedPattern.exec(trimmed);
    if (match) {
      const timestamp = parseInt(match[1]!, 10);
      const duration = parseInt(match[2]!, 10);
      const command = match[3]!;

      commands.push({
        command,
        timestamp: new Date(timestamp * 1000).toISOString().replace('Z', '').replace('T', ' ').substring(0, 19),
        duration_seconds: duration,
      });
    }
    // Skip non-extended lines (plain commands without timestamps)
  }

  return commands;
}

// ── Bash History Parser ──────────────────────────────────────────────────────

/**
 * Parse bash history with timestamps (HISTTIMEFORMAT set).
 * Format:
 * ```
 * #1234567890
 * command
 * ```
 */
export function parseBashHistory(content: string): ShellCommand[] {
  const commands: ShellCommand[] = [];
  const lines = content.split('\n');

  const timestampPattern = /^#(\d{10,})$/;

  let pendingTimestamp: number | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const tsMatch = timestampPattern.exec(trimmed);
    if (tsMatch) {
      pendingTimestamp = parseInt(tsMatch[1]!, 10);
      continue;
    }

    if (pendingTimestamp !== null) {
      commands.push({
        command: trimmed,
        timestamp: new Date(pendingTimestamp * 1000).toISOString().replace('Z', '').replace('T', ' ').substring(0, 19),
      });
      pendingTimestamp = null;
    }
    // Lines without preceding timestamp are skipped (no reliable timestamp)
  }

  return commands;
}

// ── Fish History Parser ──────────────────────────────────────────────────────

/**
 * Parse fish history format:
 * ```
 * - cmd: the command
 *   when: 1234567890
 * ```
 */
export function parseFishHistory(content: string): ShellCommand[] {
  const commands: ShellCommand[] = [];
  const lines = content.split('\n');

  let currentCmd: string | null = null;

  const cmdPattern = /^- cmd:\s*(.+)$/;
  const whenPattern = /^\s+when:\s*(\d+)$/;

  for (const line of lines) {
    const cmdMatch = cmdPattern.exec(line);
    if (cmdMatch) {
      currentCmd = cmdMatch[1]!;
      continue;
    }

    const whenMatch = whenPattern.exec(line);
    if (whenMatch && currentCmd) {
      const timestamp = parseInt(whenMatch[1]!, 10);
      commands.push({
        command: currentCmd,
        timestamp: new Date(timestamp * 1000).toISOString().replace('Z', '').replace('T', ' ').substring(0, 19),
      });
      currentCmd = null;
    }
  }

  return commands;
}

// ── Shell History Reader ─────────────────────────────────────────────────────

/**
 * Creates an incremental shell history reader.
 * Tracks the file position so only new entries are returned on each call.
 */
export function createShellHistoryReader(shellType?: ShellType): () => Promise<ShellCommand[]> {
  const type = shellType ?? detectShell();
  const histPath = getHistoryFilePath(type);
  let lastSize = 0;
  let initialized = false;

  return async (): Promise<ShellCommand[]> => {
    if (!histPath || !existsSync(histPath)) return [];

    const stats = statSync(histPath);
    const currentSize = stats.size;

    if (!initialized) {
      // On first call, skip existing history — only track new entries
      lastSize = currentSize;
      initialized = true;
      return [];
    }

    if (currentSize <= lastSize) {
      // File hasn't grown (or was truncated)
      if (currentSize < lastSize) lastSize = currentSize;
      return [];
    }

    // Read only the new portion of the file
    const fd = await import('node:fs').then(fs =>
      fs.openSync(histPath, 'r')
    );
    const buffer = Buffer.alloc(currentSize - lastSize);
    const { readSync, closeSync } = await import('node:fs');
    readSync(fd, buffer, 0, buffer.length, lastSize);
    closeSync(fd);

    const newContent = buffer.toString('utf8');
    lastSize = currentSize;

    const parser = type === 'zsh' ? parseZshHistory :
                   type === 'bash' ? parseBashHistory :
                   type === 'fish' ? parseFishHistory :
                   null;

    if (!parser) return [];
    return parser(newContent);
  };
}
