import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import type { ShellCommand } from './observer.js';

// ── Shell Type Detection ─────────────────────────────────────────────────────

export type ShellType = 'zsh' | 'bash' | 'fish' | 'powershell' | 'unknown';

export function detectShell(): ShellType {
  const shell = process.env['SHELL'] ?? '';

  // Unix shells (Linux/macOS, also Git Bash on Windows via MSYSTEM)
  if (shell.includes('zsh')) return 'zsh';
  if (shell.includes('bash')) return 'bash';
  if (shell.includes('fish')) return 'fish';

  // Windows: check for Git Bash / MSYS2 environment
  if (process.env['MSYSTEM']) {
    return 'bash'; // Git Bash uses bash
  }

  // Windows: default to PowerShell (available on all Win10/11)
  if (platform() === 'win32') {
    return 'powershell';
  }

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
    case 'powershell': {
      // PSReadLine history: %APPDATA%\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt
      // Available on Windows 10 (1607+) and Windows 11 out of the box
      const appData = process.env['APPDATA'];
      if (appData) {
        const histFile = join(appData, 'Microsoft', 'Windows', 'PowerShell',
          'PSReadLine', 'ConsoleHost_history.txt');
        if (existsSync(histFile)) return histFile;
      }
      return null;
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

// ── PowerShell History Parser ────────────────────────────────────────────────

/**
 * Parse PowerShell PSReadLine history.
 * Format: one command per line, NO timestamps.
 *
 * Since PowerShell does not store timestamps in the history file,
 * each command is assigned the current time when read. The incremental
 * reader ensures we only process newly appended commands.
 */
export function parsePowerShellHistory(content: string): ShellCommand[] {
  const commands: ShellCommand[] = [];
  const now = new Date().toISOString().replace('Z', '').replace('T', ' ').substring(0, 19);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip backtick-continuation markers from multi-line commands
    if (trimmed === '`') continue;

    commands.push({
      command: trimmed,
      timestamp: now,
    });
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
                   type === 'powershell' ? parsePowerShellHistory :
                   null;

    if (!parser) return [];
    return parser(newContent);
  };
}
