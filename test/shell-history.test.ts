import { describe, it, expect } from 'vitest';
import { parseZshHistory, parseBashHistory, parseFishHistory, parsePowerShellHistory, detectShell } from '../src/shell-history.js';

describe('Shell History — Zsh Parser', () => {
  it('parses extended zsh history format', () => {
    const content = `: 1700000000:0;ls -la
: 1700000060:5;npm test
: 1700000120:10;git commit -m "test"`;

    const commands = parseZshHistory(content);
    expect(commands).toHaveLength(3);
    expect(commands[0]!.command).toBe('ls -la');
    expect(commands[0]!.duration_seconds).toBe(0);
    expect(commands[1]!.command).toBe('npm test');
    expect(commands[1]!.duration_seconds).toBe(5);
    expect(commands[2]!.command).toBe('git commit -m "test"');
    expect(commands[2]!.duration_seconds).toBe(10);
  });

  it('generates valid ISO-like timestamps', () => {
    const content = `: 1700000000:0;echo hello`;
    const commands = parseZshHistory(content);
    expect(commands).toHaveLength(1);
    // Should be a valid datetime string
    expect(commands[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('handles empty content', () => {
    expect(parseZshHistory('')).toHaveLength(0);
  });

  it('skips non-extended format lines', () => {
    const content = `ls -la
echo hello
: 1700000000:0;npm test`;

    const commands = parseZshHistory(content);
    // Only the extended format line is parsed
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toBe('npm test');
  });

  it('handles commands with colons and semicolons', () => {
    const content = `: 1700000000:0;echo "hello:world;test"`;
    const commands = parseZshHistory(content);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toBe('echo "hello:world;test"');
  });
});

describe('Shell History — Bash Parser', () => {
  it('parses bash timestamped history', () => {
    const content = `#1700000000
ls -la
#1700000060
npm test
#1700000120
git status`;

    const commands = parseBashHistory(content);
    expect(commands).toHaveLength(3);
    expect(commands[0]!.command).toBe('ls -la');
    expect(commands[1]!.command).toBe('npm test');
    expect(commands[2]!.command).toBe('git status');
  });

  it('generates valid timestamps', () => {
    const content = `#1700000000
echo hello`;

    const commands = parseBashHistory(content);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('handles empty content', () => {
    expect(parseBashHistory('')).toHaveLength(0);
  });

  it('skips lines without timestamps', () => {
    const content = `ls -la
echo hello`;
    // No timestamp lines, so nothing is parsed
    expect(parseBashHistory(content)).toHaveLength(0);
  });
});

describe('Shell History — Fish Parser', () => {
  it('parses fish history format', () => {
    const content = `- cmd: ls -la
  when: 1700000000
- cmd: npm test
  when: 1700000060
- cmd: git status
  when: 1700000120`;

    const commands = parseFishHistory(content);
    expect(commands).toHaveLength(3);
    expect(commands[0]!.command).toBe('ls -la');
    expect(commands[1]!.command).toBe('npm test');
    expect(commands[2]!.command).toBe('git status');
  });

  it('generates valid timestamps', () => {
    const content = `- cmd: echo hello
  when: 1700000000`;

    const commands = parseFishHistory(content);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('handles empty content', () => {
    expect(parseFishHistory('')).toHaveLength(0);
  });

  it('skips incomplete entries', () => {
    const content = `- cmd: ls -la
- cmd: npm test
  when: 1700000060`;

    // Only the second entry has a timestamp
    const commands = parseFishHistory(content);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toBe('npm test');
  });
});

describe('Shell History — PowerShell Parser', () => {
  it('parses simple PowerShell history', () => {
    const content = `Get-Process
cd C:\\Users\\john\\Documents
npm install express
git status`;

    const commands = parsePowerShellHistory(content);
    expect(commands).toHaveLength(4);
    expect(commands[0]!.command).toBe('Get-Process');
    expect(commands[1]!.command).toBe('cd C:\\Users\\john\\Documents');
    expect(commands[2]!.command).toBe('npm install express');
    expect(commands[3]!.command).toBe('git status');
  });

  it('generates timestamp at read time', () => {
    const content = `echo hello`;
    const commands = parsePowerShellHistory(content);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('handles empty content', () => {
    expect(parsePowerShellHistory('')).toHaveLength(0);
  });

  it('skips empty lines', () => {
    const content = `Get-Process

npm install

git status`;
    const commands = parsePowerShellHistory(content);
    expect(commands).toHaveLength(3);
  });

  it('skips backtick continuation markers', () => {
    const content = `if ($true) {
\`
Write-Host "hello"
\`
}`;
    const commands = parsePowerShellHistory(content);
    // Backtick lines should be skipped
    const backtickOnly = commands.filter(c => c.command === '`');
    expect(backtickOnly).toHaveLength(0);
  });

  it('handles PowerShell-specific commands', () => {
    const content = `Get-ChildItem -Recurse | Where-Object { $_.Extension -eq ".log" }
Invoke-WebRequest -Uri "https://api.example.com"
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`;

    const commands = parsePowerShellHistory(content);
    expect(commands).toHaveLength(3);
    expect(commands[0]!.command).toContain('Get-ChildItem');
    expect(commands[1]!.command).toContain('Invoke-WebRequest');
    expect(commands[2]!.command).toContain('Set-ExecutionPolicy');
  });

  it('all commands share the same timestamp batch', () => {
    const content = `cmd1\ncmd2\ncmd3`;
    const commands = parsePowerShellHistory(content);
    expect(commands).toHaveLength(3);
    // All should have the same timestamp (assigned at read time)
    expect(commands[0]!.timestamp).toBe(commands[1]!.timestamp);
    expect(commands[1]!.timestamp).toBe(commands[2]!.timestamp);
  });
});

describe('detectShell', () => {
  it('detects shell from SHELL env var', () => {
    const result = detectShell();
    // Should return some value (varies by environment)
    expect(['zsh', 'bash', 'fish', 'powershell', 'unknown']).toContain(result);
  });
});
