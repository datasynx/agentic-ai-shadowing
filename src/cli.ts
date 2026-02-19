import { Command } from 'commander';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEFAULT_SHADOW_CONFIG,
  MIN_POLL_INTERVAL_MS,
  type ShadowConfig,
} from './types.js';
import {
  forkDaemon,
  isDaemonRunning,
  stopDaemon,
  pauseDaemon,
  resumeDaemon,
  startDaemonProcess,
} from './daemon.js';
import { ForegroundClient, AttachClient } from './client.js';
import { generateSOPs } from './agent.js';

const program = new Command();

program
  .name('datasynx-shadow')
  .description('Shadow daemon for @datasynx/agentic-ai-cartography')
  .version('0.1.0');

// ── shadow start ────────────────────────────────────────────────────────────

program
  .command('start')
  .description('Start the shadow daemon')
  .option('--interval <ms>', 'Poll interval in ms', String(DEFAULT_SHADOW_CONFIG.pollIntervalMs))
  .option('--inactivity <ms>', 'Inactivity timeout in ms', String(DEFAULT_SHADOW_CONFIG.inactivityTimeoutMs))
  .option('--model <model>', 'Analysis model', DEFAULT_SHADOW_CONFIG.shadowModel)
  .option('--track-windows', 'Track window focus (requires xdotool)', false)
  .option('--auto-save', 'Auto-save nodes without prompt', false)
  .option('--no-notifications', 'Disable desktop notifications')
  .option('--foreground', 'Run in foreground (no daemon fork)', false)
  .option('--db <path>', 'Database path', DEFAULT_SHADOW_CONFIG.dbPath)
  .option('--daemon-child', 'Internal: marks this as a forked daemon child', false)
  .action(async (opts) => {
    const pollIntervalMs = parseInt(opts.interval, 10);
    if (pollIntervalMs < MIN_POLL_INTERVAL_MS) {
      process.stderr.write(
        `❌ Poll interval must be >= ${MIN_POLL_INTERVAL_MS}ms (got ${pollIntervalMs}ms)\n` +
        `   Agent SDK needs ~2-5s per cycle. Shorter intervals cause overlap.\n`
      );
      process.exitCode = 1;
      return;
    }

    const config: ShadowConfig = {
      ...DEFAULT_SHADOW_CONFIG,
      pollIntervalMs,
      inactivityTimeoutMs: parseInt(opts.inactivity, 10),
      shadowModel: opts.model,
      trackWindowFocus: opts.trackWindows,
      autoSaveNodes: opts.autoSave,
      enableNotifications: opts.notifications !== false,
      dbPath: opts.db,
      shadowMode: opts.foreground ? 'foreground' : 'daemon',
    };

    // Ensure config directories exist
    for (const p of [config.socketPath, config.pidFile, config.dbPath]) {
      const dir = dirname(p);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    // Check if daemon child (forked by forkDaemon)
    if (opts.daemonChild || process.env['CARTOGRAPHYY_DAEMON'] === '1') {
      await startDaemonProcess(config);
      return;
    }

    // Check if already running
    const { running, pid } = isDaemonRunning(config.pidFile);
    if (running) {
      process.stderr.write(`❌ Shadow daemon already running (PID ${pid})\n`);
      process.stderr.write(`   Use "datasynx-shadow stop" first.\n`);
      process.exitCode = 1;
      return;
    }

    if (opts.foreground) {
      const client = new ForegroundClient();
      await client.run(config);
    } else {
      const daemonPid = forkDaemon(config);
      process.stderr.write(`👁 Shadow daemon gestartet (PID ${daemonPid})\n`);
      process.stderr.write(`   Socket: ${config.socketPath}\n`);
      process.stderr.write(`   Intervall: ${config.pollIntervalMs / 1000}s | Modell: ${config.shadowModel}\n`);
      process.stderr.write(`   "datasynx-shadow attach" zum Ankoppeln\n`);
    }
  });

// ── shadow stop ─────────────────────────────────────────────────────────────

program
  .command('stop')
  .description('Stop the shadow daemon')
  .option('--db <path>', 'Database path', DEFAULT_SHADOW_CONFIG.dbPath)
  .action(async (opts) => {
    const config = { ...DEFAULT_SHADOW_CONFIG, dbPath: opts.db };

    const stopped = stopDaemon(config.pidFile);
    if (stopped) {
      process.stderr.write('🛑 Shadow daemon gestoppt\n');
    } else {
      process.stderr.write('⚠ Kein laufender Daemon gefunden\n');
    }
  });

// ── shadow pause ────────────────────────────────────────────────────────────

program
  .command('pause')
  .description('Pause the shadow daemon')
  .action(() => {
    const paused = pauseDaemon(DEFAULT_SHADOW_CONFIG.pidFile);
    if (paused) {
      process.stderr.write('⏸ Shadow daemon pausiert\n');
    } else {
      process.stderr.write('⚠ Kein laufender Daemon gefunden\n');
    }
  });

// ── shadow resume ───────────────────────────────────────────────────────────

program
  .command('resume')
  .description('Resume the shadow daemon')
  .action(() => {
    const resumed = resumeDaemon(DEFAULT_SHADOW_CONFIG.pidFile);
    if (resumed) {
      process.stderr.write('▶ Shadow daemon fortgesetzt\n');
    } else {
      process.stderr.write('⚠ Kein laufender Daemon gefunden\n');
    }
  });

// ── shadow status ───────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show daemon status')
  .action(() => {
    const { running, pid } = isDaemonRunning(DEFAULT_SHADOW_CONFIG.pidFile);
    if (running) {
      process.stderr.write(`👁 Shadow daemon läuft (PID ${pid})\n`);
      process.stderr.write(`   Socket: ${DEFAULT_SHADOW_CONFIG.socketPath}\n`);
    } else {
      process.stderr.write('⚫ Shadow daemon nicht aktiv\n');
    }
  });

// ── shadow attach ───────────────────────────────────────────────────────────

program
  .command('attach')
  .description('Attach to running daemon (terminal UI)')
  .action(async () => {
    const { running } = isDaemonRunning(DEFAULT_SHADOW_CONFIG.pidFile);
    if (!running) {
      process.stderr.write('❌ Kein laufender Daemon. Starte mit "datasynx-shadow start"\n');
      process.exitCode = 1;
      return;
    }

    const client = new AttachClient();
    await client.attach(DEFAULT_SHADOW_CONFIG.socketPath);
  });

// ── sops ────────────────────────────────────────────────────────────────────

program
  .command('sops [session-id]')
  .description('Generate SOPs from completed tasks')
  .option('--db <path>', 'Database path', DEFAULT_SHADOW_CONFIG.dbPath)
  .action(async (sessionId: string | undefined, opts) => {
    process.stderr.write('⚠ SOP generation requires a CartographyDB instance.\n');
    process.stderr.write('   Provide a session-id or use the programmatic API.\n');

    if (!sessionId) {
      process.stderr.write('   Usage: datasynx-shadow sops <session-id>\n');
      process.exitCode = 1;
    }
  });

program.parse();
