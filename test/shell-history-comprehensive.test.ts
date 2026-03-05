import { describe, it, expect } from 'vitest';
import {
  detectShell, parseZshHistory, parseBashHistory,
  parseFishHistory, parsePowerShellHistory,
} from '../src/shell-history.js';

describe('detectShell — Comprehensive', () => {
  it('returns a valid ShellType', () => {
    const result = detectShell();
    expect(['zsh', 'bash', 'fish', 'powershell', 'unknown']).toContain(result);
  });
});

describe('parseZshHistory — Comprehensive', () => {
  it('parses extended format', () => {
    const content = ': 1700000000:0;ls -la\n: 1700000060:5;git status\n';
    const commands = parseZshHistory(content);
    expect(commands).toHaveLength(2);
    expect(commands[0]!.command).toBe('ls -la');
    expect(commands[0]!.duration_seconds).toBe(0);
    expect(commands[1]!.command).toBe('git status');
    expect(commands[1]!.duration_seconds).toBe(5);
  });

  it('returns valid ISO-like timestamps', () => {
    const content = ': 1700000000:0;test\n';
    const commands = parseZshHistory(content);
    expect(commands[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('handles empty content', () => {
    expect(parseZshHistory('')).toEqual([]);
  });

  it('skips blank lines', () => {
    const content = '\n\n: 1700000000:0;cmd\n\n';
    expect(parseZshHistory(content)).toHaveLength(1);
  });

  it('skips non-extended format lines', () => {
    const content = 'plain command without timestamp\n: 1700000000:0;real command\n';
    const commands = parseZshHistory(content);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toBe('real command');
  });

  it('handles commands with colons and semicolons', () => {
    const content = ': 1700000000:0;echo "hello:world;test"\n';
    const commands = parseZshHistory(content);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toBe('echo "hello:world;test"');
  });

  it('handles multi-line history (each line is separate)', () => {
    const content = ': 1700000000:0;cmd1\n: 1700000001:0;cmd2\n: 1700000002:0;cmd3\n';
    expect(parseZshHistory(content)).toHaveLength(3);
  });

  it('handles large duration values', () => {
    const content = ': 1700000000:3600;long-running-task\n';
    const commands = parseZshHistory(content);
    expect(commands[0]!.duration_seconds).toBe(3600);
  });
});

describe('parseBashHistory — Comprehensive', () => {
  it('parses timestamp + command pairs', () => {
    const content = '#1700000000\nls -la\n#1700000060\ngit status\n';
    const commands = parseBashHistory(content);
    expect(commands).toHaveLength(2);
    expect(commands[0]!.command).toBe('ls -la');
    expect(commands[1]!.command).toBe('git status');
  });

  it('returns valid timestamps', () => {
    const content = '#1700000000\ncmd\n';
    const commands = parseBashHistory(content);
    expect(commands[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('handles empty content', () => {
    expect(parseBashHistory('')).toEqual([]);
  });

  it('skips commands without preceding timestamp', () => {
    const content = 'orphan command\n#1700000000\nwith timestamp\n';
    const commands = parseBashHistory(content);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toBe('with timestamp');
  });

  it('handles blank lines', () => {
    const content = '\n#1700000000\n\ncmd\n\n';
    const commands = parseBashHistory(content);
    expect(commands).toHaveLength(1);
  });

  it('requires 10+ digit timestamps', () => {
    const content = '#123\ncmd\n#1700000000\nreal cmd\n';
    const commands = parseBashHistory(content);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toBe('real cmd');
  });

  it('handles consecutive timestamps (uses last)', () => {
    const content = '#1700000000\n#1700000001\ncmd\n';
    const commands = parseBashHistory(content);
    expect(commands).toHaveLength(1);
  });
});

describe('parseFishHistory — Comprehensive', () => {
  it('parses fish YAML-like format', () => {
    const content = `- cmd: ls -la
  when: 1700000000
- cmd: git status
  when: 1700000060
`;
    const commands = parseFishHistory(content);
    expect(commands).toHaveLength(2);
    expect(commands[0]!.command).toBe('ls -la');
    expect(commands[1]!.command).toBe('git status');
  });

  it('returns valid timestamps', () => {
    const content = '- cmd: test\n  when: 1700000000\n';
    const commands = parseFishHistory(content);
    expect(commands[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('handles empty content', () => {
    expect(parseFishHistory('')).toEqual([]);
  });

  it('skips entries without when timestamp', () => {
    const content = '- cmd: orphan\n- cmd: with time\n  when: 1700000000\n';
    const commands = parseFishHistory(content);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toBe('with time');
  });

  it('handles commands with special characters', () => {
    const content = '- cmd: echo "hello world" | grep hello\n  when: 1700000000\n';
    const commands = parseFishHistory(content);
    expect(commands[0]!.command).toBe('echo "hello world" | grep hello');
  });
});

describe('parsePowerShellHistory — Comprehensive', () => {
  it('parses simple line-per-command format', () => {
    const content = 'Get-Process\nSet-Location C:\\Users\ndir\n';
    const commands = parsePowerShellHistory(content);
    expect(commands).toHaveLength(3);
    expect(commands[0]!.command).toBe('Get-Process');
  });

  it('assigns current time as timestamp', () => {
    const commands = parsePowerShellHistory('test\n');
    expect(commands[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('handles empty content', () => {
    expect(parsePowerShellHistory('')).toEqual([]);
  });

  it('skips backtick continuation markers', () => {
    const content = '`\nreal-command\n`\n';
    const commands = parsePowerShellHistory(content);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toBe('real-command');
  });

  it('skips blank lines', () => {
    const content = '\ncmd1\n\ncmd2\n\n';
    const commands = parsePowerShellHistory(content);
    expect(commands).toHaveLength(2);
  });

  it('preserves command whitespace correctly', () => {
    const content = '  Get-Process | Where Name  \n';
    const commands = parsePowerShellHistory(content);
    expect(commands[0]!.command).toBe('Get-Process | Where Name');
  });
});
