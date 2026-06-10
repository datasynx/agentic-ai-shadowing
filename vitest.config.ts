import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        // Pure type declarations and barrel re-exports carry no testable logic.
        'src/types.ts',
        'src/index.ts',
        // Not unit-tested by design — the coverage gate targets the testable
        // core, not these layers:
        //  - cli.ts: argv/command wiring that delegates to the (tested) core
        //    (TaskManager, ShadowingDB, Exporter, …); exercised via the CLI
        //    smoke tests in CI, not unit coverage.
        //  - dashboard-html.ts: an HTML string template; its testable JS
        //    helpers live in dashboard-client.ts (100% covered).
        //  - window-detector.ts: platform-specific OS shell-outs
        //    (xdotool/osascript/PowerShell) that can't run deterministically
        //    in CI.
        'src/cli.ts',
        'src/dashboard-html.ts',
        'src/window-detector.ts',
      ],
      // Global gate only — guards against regression without forcing every
      // file (e.g. the large CLI surface) to an unrealistic per-file bar.
      // Thresholds sit a few points under the measured baseline so honest
      // refactors don't trip them, while a real drop fails CI.
      thresholds: {
        statements: 85,
        branches: 78,
        functions: 88,
        lines: 87,
      },
    },
  },
});
