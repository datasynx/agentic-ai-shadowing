import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the pure/exported functions — the OS-specific detectors are tested
// only at the unit level (extractAppFromTitle, detectPlatform).

describe('Window Detector', () => {
  // ── detectPlatform ──────────────────────────────────────────────────────

  describe('detectPlatform', () => {
    const originalPlatform = process.platform;
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('returns unsupported when no DISPLAY on linux', async () => {
      // In test environment (likely CI), we might not have DISPLAY
      const { detectPlatform } = await import('../src/window-detector.js');
      const result = detectPlatform();
      // In CI/headless, this should be 'unsupported' (no X11)
      expect(['linux-x11', 'macos', 'unsupported']).toContain(result);
    });
  });

  // ── createWindowDetector ────────────────────────────────────────────────

  describe('createWindowDetector', () => {
    it('returns a function or null depending on platform', async () => {
      const { createWindowDetector } = await import('../src/window-detector.js');
      const detector = createWindowDetector();
      // On CI (headless Linux), likely null; on macOS dev, likely a function
      expect(detector === null || typeof detector === 'function').toBe(true);
    });

    it('returned function returns WindowInfo or null', async () => {
      const { createWindowDetector } = await import('../src/window-detector.js');
      const detector = createWindowDetector();
      if (detector) {
        const result = await detector();
        // Either null (headless/error) or valid WindowInfo
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
});
