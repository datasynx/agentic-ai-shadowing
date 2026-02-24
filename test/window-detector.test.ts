import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseWindowsPSOutput } from '../src/window-detector.js';

describe('Window Detector', () => {
  // ── detectPlatform ──────────────────────────────────────────────────────

  describe('detectPlatform', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('returns a valid platform value', async () => {
      const { detectPlatform } = await import('../src/window-detector.js');
      const result = detectPlatform();
      expect(['linux-x11', 'macos', 'windows', 'unsupported']).toContain(result);
    });
  });

  // ── createWindowDetector ────────────────────────────────────────────────

  describe('createWindowDetector', () => {
    it('returns a function or null depending on platform', async () => {
      const { createWindowDetector } = await import('../src/window-detector.js');
      const detector = createWindowDetector();
      expect(detector === null || typeof detector === 'function').toBe(true);
    });

    it('returned function returns WindowInfo or null', async () => {
      const { createWindowDetector } = await import('../src/window-detector.js');
      const detector = createWindowDetector();
      if (detector) {
        const result = await detector();
        if (result !== null) {
          expect(result).toHaveProperty('app_name');
          expect(result).toHaveProperty('window_title');
          expect(typeof result.app_name).toBe('string');
          expect(typeof result.window_title).toBe('string');
        }
      }
    });
  });

  // ── detectActiveWindow ──────────────────────────────────────────────────

  describe('detectActiveWindow', () => {
    it('returns WindowInfo or null', async () => {
      const { detectActiveWindow } = await import('../src/window-detector.js');
      const result = detectActiveWindow();
      if (result !== null) {
        expect(result.app_name).toBeTruthy();
        expect(typeof result.window_title).toBe('string');
      } else {
        expect(result).toBeNull();
      }
    });
  });

  // ── parseWindowsPSOutput (Windows PowerShell JSON parsing) ─────────────

  describe('parseWindowsPSOutput', () => {
    it('parses valid PowerShell JSON output', () => {
      const output = '{"title":"README.md - Visual Studio Code","processName":"Code","processId":12345}';
      const result = parseWindowsPSOutput(output);
      expect(result).not.toBeNull();
      expect(result!.app_name).toBe('Code');
      expect(result!.window_title).toBe('README.md - Visual Studio Code');
    });

    it('parses output with empty process name', () => {
      const output = '{"title":"Document.docx - Microsoft Word","processName":"","processId":5678}';
      const result = parseWindowsPSOutput(output);
      expect(result).not.toBeNull();
      // Falls back to extracting from title
      expect(result!.app_name).toBe('Microsoft Word');
      expect(result!.window_title).toBe('Document.docx - Microsoft Word');
    });

    it('parses output with Notepad', () => {
      const output = '{"title":"Untitled - Notepad","processName":"notepad","processId":1234}';
      const result = parseWindowsPSOutput(output);
      expect(result).not.toBeNull();
      expect(result!.app_name).toBe('notepad');
      expect(result!.window_title).toBe('Untitled - Notepad');
    });

    it('parses output with special characters in title', () => {
      const output = '{"title":"C:\\\\Users\\\\Dev\\\\project - VS Code","processName":"Code","processId":999}';
      const result = parseWindowsPSOutput(output);
      expect(result).not.toBeNull();
      expect(result!.app_name).toBe('Code');
    });

    it('returns null for empty title and process name', () => {
      const output = '{"title":"","processName":"","processId":0}';
      const result = parseWindowsPSOutput(output);
      expect(result).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      expect(parseWindowsPSOutput('not json')).toBeNull();
      expect(parseWindowsPSOutput('')).toBeNull();
    });

    it('handles output with surrounding whitespace', () => {
      const output = '  \n{"title":"Terminal","processName":"WindowsTerminal","processId":42}\n  ';
      const result = parseWindowsPSOutput(output);
      expect(result).not.toBeNull();
      expect(result!.app_name).toBe('WindowsTerminal');
    });

    it('uses process name as window title fallback', () => {
      const output = '{"title":"","processName":"explorer","processId":100}';
      const result = parseWindowsPSOutput(output);
      expect(result).not.toBeNull();
      expect(result!.app_name).toBe('explorer');
      expect(result!.window_title).toBe('explorer');
    });

    it('parses Windows 11 Chrome output', () => {
      const output = '{"title":"Google - Google Chrome","processName":"chrome","processId":2468}';
      const result = parseWindowsPSOutput(output);
      expect(result).not.toBeNull();
      expect(result!.app_name).toBe('chrome');
      expect(result!.window_title).toBe('Google - Google Chrome');
    });

    it('parses Windows Terminal output', () => {
      const output = '{"title":"PowerShell","processName":"WindowsTerminal","processId":1111}';
      const result = parseWindowsPSOutput(output);
      expect(result).not.toBeNull();
      expect(result!.app_name).toBe('WindowsTerminal');
    });
  });
});
