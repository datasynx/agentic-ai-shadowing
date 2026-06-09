// Hinweis: Alle Benutzerausgaben gehen auf stderr (gemäß CLAUDE.md Regel "Terminal auf stderr").
// Nur Daten-Output (SOP Markdown in "show") geht auf stdout für Piping-Kompatibilität.
import { Command } from 'commander';
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { ShadowingDB } from './db.js';
import { TaskManager, formatDuration } from './task-manager.js';
import { SOPGenerator, SOPGenerationError, buildSOPPreview, countSteps } from './sop-generator.js';
import { Anonymizer, createCaptureRedactor } from './anonymizer.js';
import { Exporter } from './exporter.js';
import { calculateSOPMetrics } from './metrics.js';
import { diffTexts, formatDiff } from './diff.js';
import { Observer } from './observer.js';
import { createShellHistoryReader } from './shell-history.js';
import { createWindowDetector } from './window-detector.js';
import { SessionAnalyzer } from './session-analyzer.js';
import { PrivacyManager, getDefaultExclusions } from './privacy.js';
import { buildInfraGraph, formatInfraGraph } from './infra-context.js';
import { checkCartographyInstalled, locateJGFFile } from './cartography-check.js';
import { loadJGFFile } from './cartography.js';
import { startMCPServer } from './mcp-server.js';
import { runHookHandler } from './hook-handler.js';
import { applyClaudeSetup, type SetupScope } from './claude-setup.js';
import { suggestTaskBoundaries } from './segmentation.js';
import { createFileWatcher } from './file-watcher.js';
import { applyHarness, detectHarnesses, planHarness, HARNESS_TARGETS, type HarnessTarget } from './harness.js';
import {
  planSkillPublish, planAgentsMdIndex, applyPublishPlan, skillNameForSOP,
  type PublishPlan, type PublishTarget,
} from './sop-publisher.js';
import { getPackageVersion } from './version.js';
import { setLogLevel } from './logger.js';
import type { ExclusionRule } from './types.js';
import {
  ensureConfigDir, getConfigPath, getDbPath,
  loadConfig, saveConfig, getConfigDir,
} from './config.js';

// Quiet diagnostic INFO/DEBUG logs for interactive CLI use unless the user
// explicitly opts in via LOG_LEVEL (see issue #15). Warnings and errors still
// surface. Module loggers resolve their threshold at log-time, so this applies
// even though they were created during import.
if (!process.env['LOG_LEVEL']) {
  setLogLevel('warn');
}

const program = new Command();

program
  .name('shadowing')
  .description('Agentic AI Shadowing — observes tasks, generates SOPs')
  .version(getPackageVersion());

// ── Helper: Load DB + Config ─────────────────────────────────────────────────

function openDB(): ShadowingDB {
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    process.stderr.write('Database not found. Please run "shadowing init" first.\n');
    process.exitCode = 1;
    throw new Error('DB not initialized');
  }
  const db = new ShadowingDB(dbPath);
  // Redact-on-capture: PII/secrets are stripped before observation data
  // hits SQLite (config: anonymization.redact_on_capture, default on).
  db.setCaptureRedactor(createCaptureRedactor(loadConfig()));
  return db;
}


// ── shadowing init ───────────────────────────────────────────────────────────

program
  .command('init')
  .description('Initial setup (create DB + config)')
  .action(() => {
    // Check cartography package (optional — just informational)
    const cartoCheck = checkCartographyInstalled();
    if (!cartoCheck.installed) {
      process.stderr.write(
        `Note: agentic-ai-cartography is not installed.\n` +
        `For cartography context in SOPs you can optionally install it:\n\n` +
        `  npm install @datasynx/agentic-ai-cartography\n\n`,
      );
    }

    ensureConfigDir();

    const dbPath = getDbPath();
    const configPath = getConfigPath();

    const db = new ShadowingDB(dbPath);
    db.initialize();
    db.close();

    // Load or create config, auto-detect JGF file
    const config = loadConfig();
    if (cartoCheck.jgfPath) {
      config.cartography_graph_path = cartoCheck.jgfPath;
      process.stderr.write(`  Cartography graph found: ${cartoCheck.jgfPath}\n`);
    } else {
      process.stderr.write(
        `  Note: cartography-graph.jgf.json not found.\n` +
        `  Run a discovery run in agentic-ai-cartography first,\n` +
        `  then "shadowing import-graph <path>" or place the file at:\n` +
        `    - ./datasynx-output/cartography-graph.jgf.json\n` +
        `    - ${getConfigDir()}/cartography-graph.jgf.json\n`,
      );
    }
    saveConfig(config);

    process.stderr.write(`\nShadowing initialized.\n`);
    process.stderr.write(`  DB:     ${dbPath}\n`);
    process.stderr.write(`  Config: ${configPath}\n`);
    process.stderr.write(`\nGet started with: shadowing start\n`);
  });

// ── shadowing start ──────────────────────────────────────────────────────────

program
  .command('start')
  .description('Start interactive shadowing mode')
  .action(async () => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }

    const config = loadConfig();
    const tm = new TaskManager(db, createCaptureRedactor(config) ?? undefined);
    // Construct the SOP generator lazily: it requires ANTHROPIC_API_KEY, but
    // starting/pausing/cancelling/noting a task does not. Building it eagerly
    // would crash the whole command for users who have not set a key yet.
    let gen: SOPGenerator | null = null;
    const getGen = (): SOPGenerator => (gen ??= new SOPGenerator(config, db));

    // Dynamic import for inquirer (ESM)
    const { input, select, confirm } = await import('@inquirer/prompts');

    process.stderr.write('\n  Agentic AI Shadowing — Active\n\n');

    // Check for existing active task
    const active = tm.getActiveTask();
    if (active) {
      process.stderr.write(`  Active task: "${active.title}"\n`);
      process.stderr.write(`  Started: ${active.started_at}\n\n`);
    }

    // Main loop
    let running = true;
    while (running) {
      const currentTask = tm.getActiveTask();

      if (!currentTask) {
        const startNew = await confirm({ message: 'Start a new task?' });
        if (!startNew) {
          running = false;
          break;
        }

        const title = await input({ message: 'Task title:' });
        if (!title.trim()) continue;

        const description = await input({ message: 'Short description (optional):' });
        const task = tm.startTask(title.trim(), description.trim() || undefined);
        process.stderr.write(`\n  Task started: "${task.title}" (ID: ${task.id.substring(0, 8)})\n\n`);
        continue;
      }

      // Task is active — show options
      const elapsed = Math.round((Date.now() - new Date(currentTask.started_at).getTime()) / 1000);
      process.stderr.write(`\n  Current task: "${currentTask.title}"\n`);
      process.stderr.write(`  Elapsed: ${formatDuration(elapsed)}\n\n`);

      const action = await select({
        message: 'What would you like to do?',
        choices: [
          { value: 'complete', name: 'Complete task -> Generate SOP' },
          { value: 'pause', name: 'Pause task' },
          { value: 'cancel', name: 'Cancel task (no SOP)' },
          { value: 'note', name: 'Add note to current step' },
          { value: 'new', name: 'Start new task (finish current)' },
          { value: 'quit', name: 'Exit shadowing' },
        ],
      });

      try {
        switch (action) {
          case 'complete': {
            const complexity = await select({
              message: 'How complex was this task? (1-5)',
              choices: [
                { value: 1, name: '1 - Very simple' },
                { value: 2, name: '2 - Simple' },
                { value: 3, name: '3 - Medium' },
                { value: 4, name: '4 - Complex' },
                { value: 5, name: '5 - Very complex' },
              ],
            });

            const { task, duration } = tm.completeTask(complexity);
            process.stderr.write(`\n  Task completed. Duration: ${duration}\n`);
            process.stderr.write('  Generating SOP...\n\n');

            try {
              const result = await getGen().generateSOP(task);
              const sop = db.createSOP(task.id, {
                title: result.title,
                description: result.description,
                content_md: result.content_md,
                tags: result.tags,
              });

              // Log execution
              if (task.duration_seconds) {
                db.logExecution(sop.id, {
                  duration_seconds: task.duration_seconds,
                  complexity_rating: complexity,
                });
              }

              const steps = countSteps(result.content_md);
              process.stderr.write(`  SOP generated!\n`);
              process.stderr.write(buildSOPPreview(result.title, result.tags, steps) + '\n\n');

              const sopAction = await select({
                message: 'SOP action:',
                choices: [
                  { value: 'accept', name: 'Accept SOP' },
                  { value: 'edit', name: 'Edit SOP (opens editor)' },
                  { value: 'regenerate', name: 'Regenerate SOP' },
                  { value: 'discard', name: 'Discard SOP' },
                ],
              });

              if (sopAction === 'accept') {
                db.updateSOPStatus(sop.id, 'reviewed');
                process.stderr.write('  SOP accepted and marked as "reviewed".\n');
              } else if (sopAction === 'edit') {
                await editSOPInEditor(db, sop.id, config.editor);
              } else if (sopAction === 'regenerate') {
                process.stderr.write('  Regenerating SOP...\n');
                await getGen().regenerateSOP(sop.id);
                process.stderr.write('  New version created.\n');
              } else if (sopAction === 'discard') {
                db.deleteSOP(sop.id);
                process.stderr.write('  SOP discarded.\n');
              }
            } catch (err) {
              if (err instanceof SOPGenerationError) {
                switch (err.code) {
                  case 'missing_api_key':
                    process.stderr.write(`  ${err.message}`);
                    break;
                  case 'auth_failed':
                    process.stderr.write(`  Authentication failed: ${err.message}\n`);
                    break;
                  case 'rate_limited':
                    process.stderr.write(`  API rate limit reached: ${err.message}\n`);
                    process.stderr.write('  Tip: Try again in a few minutes with "shadowing edit <sop-id>".\n');
                    break;
                  case 'api_error':
                    process.stderr.write(`  Claude API error: ${err.message}\n`);
                    break;
                  case 'parse_error':
                    process.stderr.write(`  Parsing error: ${err.message}\n`);
                    break;
                  default:
                    process.stderr.write(`  Error during SOP generation: ${err.message}\n`);
                }
              } else {
                process.stderr.write(`  Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
              }
              process.stderr.write('  Task was still marked as completed.\n');
            }
            break;
          }

          case 'pause':
            tm.pauseTask();
            process.stderr.write('  Task paused.\n');
            break;

          case 'cancel':
            tm.cancelTask();
            process.stderr.write('  Task cancelled.\n');
            break;

          case 'note': {
            const note = await input({ message: 'Note:' });
            if (note.trim()) {
              tm.addNote(note.trim());
              process.stderr.write('  Note added.\n');
            }
            break;
          }

          case 'new': {
            // Complete current task first
            const { duration } = tm.completeTask();
            process.stderr.write(`  Task completed (${duration}). Starting new task...\n`);
            break;
          }

          case 'quit':
            running = false;
            break;
        }
      } catch (err) {
        process.stderr.write(`  Error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    db.close();
    process.stderr.write('\nShadowing ended.\n');
  });

// ── shadowing status ─────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show current task and statistics')
  .action(() => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }

    const tm = new TaskManager(db);
    const active = tm.getActiveTask();
    const stats = db.getGlobalStats();

    if (active) {
      const elapsed = Math.round((Date.now() - new Date(active.started_at).getTime()) / 1000);
      process.stderr.write(`\n  Active task: "${active.title}"\n`);
      process.stderr.write(`  Elapsed: ${formatDuration(elapsed)}\n`);
      if (active.description) process.stderr.write(`  Description: ${active.description.substring(0, 80)}\n`);
    } else {
      process.stderr.write('\n  No active task.\n');
    }

    process.stderr.write(`\n  Tasks: ${stats.total_tasks} (${stats.completed_tasks} completed)\n`);
    process.stderr.write(`  SOPs:  ${stats.total_sops} (${stats.approved_sops} approved, ${stats.draft_sops} draft)\n`);
    process.stderr.write(`  Tags:  ${stats.total_tags} | Exports: ${stats.total_exports}\n\n`);

    db.close();
  });

// ── shadowing list ───────────────────────────────────────────────────────────

program
  .command('list')
  .description('List all SOPs')
  .option('--status <status>', 'Filter by status (draft/reviewed/approved/exported/archived)')
  .option('--tag <tag>', 'Filter by tag')
  .option('--search <query>', 'Free-text search')
  .action((opts) => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }

    const sops = db.listSOPs({
      status: opts.status,
      tag: opts.tag,
      search: opts.search,
    });

    if (sops.length === 0) {
      process.stderr.write('\n  No SOPs found.\n\n');
      db.close();
      return;
    }

    process.stderr.write(`\n  ${sops.length} SOP(s):\n\n`);
    for (const sop of sops) {
      const tags = db.getTagsForSOP(sop.id).map(t => `#${t.name}`).join(' ');
      const statusIcon = sop.status === 'approved' ? '[ok]' :
                         sop.status === 'draft' ? '[..] ' :
                         sop.status === 'reviewed' ? '[rv]' :
                         sop.status === 'exported' ? '[ex]' : '[ar]';
      process.stderr.write(
        `  ${sop.id.substring(0, 8)}  ${statusIcon}  ${sop.title.substring(0, 50).padEnd(50)}  ${tags}\n`
      );
    }
    process.stderr.write('\n');

    db.close();
  });

// ── shadowing show ───────────────────────────────────────────────────────────

program
  .command('show <sop-id>')
  .description('Display an SOP in the terminal')
  .action((sopId: string) => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }

    const sop = findSOP(db, sopId);
    if (!sop) { db.close(); return; }

    const tags = db.getTagsForSOP(sop.id).map(t => `#${t.name}`).join(' ');
    const config = loadConfig();
    const metrics = calculateSOPMetrics(db, sop.id, config.metrics.quality_score_weights);

    process.stderr.write(`\n  ID: ${sop.id} | Version: ${sop.version} | Status: ${sop.status}\n`);
    process.stderr.write(`  Tags: ${tags || '(none)'}\n`);
    if (metrics.execution_count > 0) {
      process.stderr.write(`  Executions: ${metrics.execution_count} | Avg: ${formatDuration(metrics.avg_duration_seconds)}\n`);
      process.stderr.write(`  Quality: ${metrics.overall_quality_score}%\n`);
    }
    process.stderr.write('\n---\n\n');
    process.stdout.write(sop.content_md + '\n');

    db.close();
  });

// ── shadowing edit ───────────────────────────────────────────────────────────

program
  .command('edit <sop-id>')
  .description('Open SOP in default editor')
  .action((sopId: string) => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }

    const sop = findSOP(db, sopId);
    if (!sop) { db.close(); return; }

    const config = loadConfig();
    editSOPInEditorSync(db, sop.id, config.editor);
    db.close();
  });

// ── shadowing delete ─────────────────────────────────────────────────────────

program
  .command('delete <sop-id>')
  .description('Delete SOP permanently')
  .action(async (sopId: string) => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }

    const sop = findSOP(db, sopId);
    if (!sop) { db.close(); return; }

    const { confirm } = await import('@inquirer/prompts');
    const yes = await confirm({ message: `Really delete SOP "${sop.title}"?` });
    if (yes) {
      db.deleteSOP(sop.id);
      process.stderr.write('  SOP deleted.\n');
    }
    db.close();
  });

// ── shadowing history ────────────────────────────────────────────────────────

program
  .command('history <sop-id>')
  .description('Show version history of an SOP')
  .action((sopId: string) => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }

    const sop = findSOP(db, sopId);
    if (!sop) { db.close(); return; }

    const versions = db.getSOPVersions(sop.id);
    process.stderr.write(`\n  Version history: "${sop.title}" (current: v${sop.version})\n\n`);

    if (versions.length === 0) {
      process.stderr.write('  No older versions available.\n\n');
      db.close();
      return;
    }

    for (const v of versions) {
      const summary = v.change_summary ? ` — ${v.change_summary}` : '';
      process.stderr.write(`  v${v.version}  ${v.changed_at}  "${v.title}"${summary}\n`);
    }
    process.stderr.write(`\n  Use "shadowing diff <sop-id> <version>" to see changes.\n\n`);

    db.close();
  });

// ── shadowing diff ───────────────────────────────────────────────────────────

program
  .command('diff <sop-id> [version]')
  .description('Show diff between SOP versions')
  .option('--from <version>', 'Source version (default: previous)')
  .option('--to <version>', 'Target version (default: current)')
  .action((sopId: string, versionArg: string | undefined, opts: { from?: string; to?: string }) => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }

    const sop = findSOP(db, sopId);
    if (!sop) { db.close(); return; }

    let oldContent: string;
    let newContent: string;
    let oldVersion: number;
    let newVersion: number;

    if (versionArg) {
      // Compare specific version to current
      oldVersion = parseInt(versionArg, 10);
      newVersion = sop.version;
      const v = db.getSOPVersion(sop.id, oldVersion);
      if (!v) {
        process.stderr.write(`  Version ${oldVersion} not found.\n`);
        process.exitCode = 1;
        db.close();
        return;
      }
      oldContent = v.content_md;
      newContent = sop.content_md;
    } else if (opts.from && opts.to) {
      oldVersion = parseInt(opts.from, 10);
      newVersion = parseInt(opts.to, 10);
      const vFrom = db.getSOPVersion(sop.id, oldVersion);
      const vTo = newVersion === sop.version ? null : db.getSOPVersion(sop.id, newVersion);
      if (!vFrom) { process.stderr.write(`  Version ${oldVersion} not found.\n`); process.exitCode = 1; db.close(); return; }
      oldContent = vFrom.content_md;
      newContent = vTo ? vTo.content_md : sop.content_md;
    } else {
      // Default: previous version vs current
      const versions = db.getSOPVersions(sop.id);
      if (versions.length === 0) {
        process.stderr.write('  No older versions to compare.\n');
        db.close();
        return;
      }
      const prev = versions[0]!;
      oldVersion = prev.version;
      newVersion = sop.version;
      oldContent = prev.content_md;
      newContent = sop.content_md;
    }

    process.stderr.write(`\n  Diff: v${oldVersion} → v${newVersion}\n\n`);
    const diff = diffTexts(oldContent, newContent);
    process.stderr.write(formatDiff(diff));
    process.stderr.write('\n');

    db.close();
  });

// ── shadowing tag ────────────────────────────────────────────────────────────

program
  .command('tag <sop-id> <tags...>')
  .description('Add (+tag) or remove (-tag) tags')
  // Tags prefixed with "-" (removal) would otherwise be parsed as unknown CLI
  // options. allowUnknownOption() passes them straight through into the
  // variadic <tags...> operand so the documented `-tag` syntax works. This is
  // scoped to this command only (no global enablePositionalOptions), so other
  // commands keep normal option parsing (e.g. `diff <id> --from 1`).
  .allowUnknownOption()
  .action((sopId: string, tags: string[]) => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }

    const sop = findSOP(db, sopId);
    if (!sop) { db.close(); return; }

    for (const raw of tags) {
      if (raw.startsWith('-')) {
        const name = raw.substring(1);
        const allTags = db.getTagsForSOP(sop.id);
        const match = allTags.find(t => t.name.toLowerCase() === name.toLowerCase());
        if (match) {
          db.removeTagFromSOP(sop.id, match.id);
          process.stderr.write(`  Tag removed: #${name}\n`);
        }
      } else {
        const name = raw.startsWith('+') ? raw.substring(1) : raw;
        db.addTagToSOP(sop.id, name, false);
        process.stderr.write(`  Tag added: #${name}\n`);
      }
    }

    db.close();
  });

// ── shadowing stats ──────────────────────────────────────────────────────────

program
  .command('stats')
  .description('Metrics dashboard in terminal')
  .action(() => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }

    const stats = db.getGlobalStats();
    const config = loadConfig();

    process.stderr.write('\n  === Shadowing Statistics ===\n\n');
    process.stderr.write(`  Tasks:        ${stats.total_tasks} total (${stats.completed_tasks} completed, ${stats.active_tasks} active)\n`);
    process.stderr.write(`  SOPs:         ${stats.total_sops} total\n`);
    process.stderr.write(`    Draft:      ${stats.draft_sops}\n`);
    process.stderr.write(`    Reviewed:   ${stats.reviewed_sops}\n`);
    process.stderr.write(`    Approved:   ${stats.approved_sops}\n`);
    process.stderr.write(`    Exported:   ${stats.exported_sops}\n`);
    process.stderr.write(`  Executions: ${stats.total_executions}\n`);
    process.stderr.write(`  Tags:         ${stats.total_tags}\n`);
    process.stderr.write(`  Exports:      ${stats.total_exports}\n`);

    // Top SOPs by execution count
    const sops = db.listSOPs();
    if (sops.length > 0) {
      process.stderr.write('\n  --- Top SOPs ---\n');
      const ranked = sops
        .map(s => ({ sop: s, metrics: calculateSOPMetrics(db, s.id, config.metrics.quality_score_weights) }))
        .filter(r => r.metrics.execution_count > 0)
        .sort((a, b) => b.metrics.execution_count - a.metrics.execution_count)
        .slice(0, 5);

      for (const { sop, metrics } of ranked) {
        process.stderr.write(
          `  ${sop.title.substring(0, 40).padEnd(40)}  ${metrics.execution_count}x  avg ${formatDuration(metrics.avg_duration_seconds)}  Q:${metrics.overall_quality_score}%\n`
        );
      }
    }
    process.stderr.write('\n');

    db.close();
  });

// ── shadowing export ─────────────────────────────────────────────────────────

program
  .command('export')
  .description('Export SOPs')
  .option('--all', 'Export all approved SOPs')
  .action(async (opts) => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }

    const config = loadConfig();
    const anonymizer = new Anonymizer(config.anonymization);
    const exporter = new Exporter(db, anonymizer, config);

    if (opts.all) {
      try {
        const result = exporter.exportAll();
        process.stderr.write(`\n  ${result.sop_count} SOP(s) exported.\n`);
        process.stderr.write(`  Path: ${result.export_path}\n\n`);
      } catch (err) {
        process.stderr.write(`  Error: ${err instanceof Error ? err.message : err}\n`);
        process.exitCode = 1;
      }
      db.close();
      return;
    }

    // Interactive selection
    const approved = db.listSOPs({ status: 'approved' });
    const reviewed = db.listSOPs({ status: 'reviewed' });
    const available = [...approved, ...reviewed];

    if (available.length === 0) {
      process.stderr.write('\n  No SOPs to export. SOPs must be "approved" or "reviewed".\n\n');
      db.close();
      return;
    }

    const { checkbox, confirm } = await import('@inquirer/prompts');
    const selected = await checkbox({
      message: 'Select SOPs to export:',
      choices: available.map(s => ({
        value: s.id,
        name: `[${s.status}] ${s.title}`,
      })),
    });

    if (selected.length === 0) {
      process.stderr.write('  No SOPs selected.\n');
      db.close();
      return;
    }

    const yes = await confirm({ message: `${selected.length} SOP(s) with anonymization?` });
    if (yes) {
      const result = exporter.exportSOPs(selected);
      process.stderr.write(`\n  ${result.sop_count} SOP(s) exported.\n`);
      process.stderr.write(`  Path: ${result.export_path}\n\n`);
    }

    db.close();
  });

// ── shadowing ui ─────────────────────────────────────────────────────────────

program
  .command('ui')
  .description('Start web dashboard')
  .option('-p, --port <port>', 'Port (default: config.ui_port)')
  .action(async (opts) => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }

    const config = loadConfig();
    const port = opts.port ? parseInt(opts.port, 10) : config.ui_port;

    const { createUIServer } = await import('./ui-server.js');
    const server = createUIServer(db, config);

    server.listen(port, () => {
      process.stderr.write(`\n  Shadowing Dashboard started.\n`);
      process.stderr.write(`  http://localhost:${port}\n\n`);
      process.stderr.write('  Ctrl+C to quit.\n');
    });

    process.on('SIGINT', () => {
      server.close();
      db.close();
      process.stderr.write('\n  Dashboard stopped.\n');
    });
  });

// ── shadowing import-graph ───────────────────────────────────────────────────

program
  .command('import-graph <path>')
  .description('Import cartography graph (JGF)')
  .action((path: string) => {
    if (!existsSync(path)) {
      process.stderr.write(`  File not found: ${path}\n`);
      process.exitCode = 1;
      return;
    }

    // Validate the file is a valid JGF or CartographyGraph
    const graph = loadJGFFile(path);
    if (!graph) {
      process.stderr.write(`  File could not be loaded as cartography graph: ${path}\n`);
      process.stderr.write(`  Expected: cartography-graph.jgf.json (JGF format)\n`);
      process.exitCode = 1;
      return;
    }

    const config = loadConfig();
    config.cartography_graph_path = path;
    saveConfig(config);
    process.stderr.write(`  Cartography graph imported: ${path}\n`);
    process.stderr.write(`  ${graph.nodes.length} nodes, ${graph.edges.length} edges loaded.\n`);
  });

// ── shadowing config ─────────────────────────────────────────────────────────

program
  .command('config')
  .description('Edit configuration')
  .action(() => {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) {
      saveConfig(loadConfig());
    }
    const config = loadConfig();
    const editor = config.editor || process.env['EDITOR'] || (process.platform === 'win32' ? 'notepad' : 'vi');

    try {
      execSync(`${editor} "${configPath}"`, { stdio: 'inherit' });
      process.stderr.write('  Config saved.\n');
    } catch {
      process.stderr.write(`  Could not start editor: ${editor}\n`);
      process.stderr.write(`  Config path: ${configPath}\n`);
    }
  });

// ── shadowing reset ──────────────────────────────────────────────────────────

program
  .command('reset')
  .description('Delete all data')
  .action(async () => {
    const { confirm } = await import('@inquirer/prompts');
    const yes = await confirm({
      message: 'Permanently delete all data (DB + Config)?',
      default: false,
    });

    if (!yes) return;

    const dbPath = getDbPath();
    const configPath = getConfigPath();

    try { if (existsSync(dbPath)) unlinkSync(dbPath); } catch { /* ok */ }
    try { if (existsSync(configPath)) unlinkSync(configPath); } catch { /* ok */ }

    process.stderr.write('  All data deleted. Run "shadowing init" to restart.\n');
  });

// ── shadowing observe ────────────────────────────────────────────────────────

program
  .command('observe')
  .description('Start observation mode (automatic workflow capture)')
  .option('--interval <ms>', 'Poll interval in milliseconds', '5000')
  .option('--no-shell', 'Do not capture shell history')
  .option('--work-hours', 'Only capture during work hours')
  .option('--auto-sop', 'Automatically detect tasks and generate SOPs after observation')
  .option('--no-window', 'Disable window detection')
  .option('--watch-files [dir]', 'Watch a directory for file changes (off by default; requires "file" consent)')
  .action(async (opts) => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }

    const privacy = new PrivacyManager(db);

    // Check consent
    if (!privacy.hasConsent('all')) {
      const { confirm } = await import('@inquirer/prompts');
      process.stderr.write('\n  Observation mode requires consent for data collection.\n');
      process.stderr.write('  Captured: active windows, shell commands, file changes.\n');
      process.stderr.write('  All data stays local. No cloud transmission.\n\n');

      const yes = await confirm({ message: 'Grant consent for observation?' });
      if (!yes) {
        process.stderr.write('  Observation cancelled.\n');
        db.close();
        return;
      }
      privacy.grantConsent('all');
      process.stderr.write('  Consent granted.\n\n');
    }

    const observer = new Observer(db, {
      poll_interval_ms: parseInt(opts.interval, 10),
      capture_shell_history: opts.shell !== false,
      work_hours_only: opts.workHours ?? false,
    });

    // Register shell history reader
    if (opts.shell !== false) {
      observer.setShellHistoryReader(createShellHistoryReader());
    }

    // Register window detector (Linux X11 / macOS)
    if (opts.window !== false) {
      const detector = createWindowDetector();
      if (detector) {
        observer.setWindowDetector(detector);
        process.stderr.write('  Window detection active.\n');
      }
    }

    const { input } = await import('@inquirer/prompts');

    const session = observer.start();

    // Optional file watching (#29): off by default, gated behind 'file' consent;
    // exclusion rules + redact-on-capture apply to every logged event.
    let fileWatcher: ReturnType<typeof createFileWatcher> | null = null;
    if (opts.watchFiles) {
      if (!privacy.hasConsent('file')) {
        process.stderr.write('  --watch-files requires consent for the "file" scope:\n');
        process.stderr.write('    shadowing consent --grant file\n');
      } else {
        const watchDir = typeof opts.watchFiles === 'string' ? opts.watchFiles : process.cwd();
        fileWatcher = createFileWatcher(db, session.id, watchDir);
        process.stderr.write(`  File watching active: ${watchDir}\n`);
      }
    }
    process.stderr.write(`\n  Observation started (Session: ${session.id.substring(0, 8)})\n`);
    process.stderr.write(`  Interval: ${opts.interval}ms\n`);
    process.stderr.write('  Commands: "stop" = end, "pause" = pause, "note" = add note\n\n');

    let running = true;
    while (running) {
      const cmd = await input({ message: '>' }).catch(() => 'stop');
      const trimmed = cmd.trim().toLowerCase();

      switch (trimmed) {
        case 'stop':
        case 'quit':
        case 'exit': {
          if (fileWatcher) await fileWatcher.close();
          const completed = observer.stop();
          if (completed) {
            process.stderr.write(`  Session ended. ${completed.total_actions} actions captured.\n`);

            // Auto-SOP: analyze session and generate tasks + SOPs
            if (opts.autoSop && completed.total_actions > 0) {
              process.stderr.write('\n  Analyzing observations...\n');
              try {
                const config = loadConfig();
                const analyzer = new SessionAnalyzer(config, db);
                const result = await analyzer.analyzeSession(completed.id);
                process.stderr.write(`  ${result.summary}\n`);
                for (const sop of result.sops_generated) {
                  process.stderr.write(`    SOP: ${sop.title}\n`);
                }
              } catch (err) {
                if (err instanceof SOPGenerationError) {
                  process.stderr.write(`  SOP analysis failed: ${err.message}\n`);
                } else {
                  process.stderr.write(`  Analysis error: ${err instanceof Error ? err.message : String(err)}\n`);
                }
              }
            } else if (!opts.autoSop && completed.total_actions > 0) {
              process.stderr.write('  Tip: Use --auto-sop or "shadowing analyze" for automatic SOP generation.\n');
            }
          }
          running = false;
          break;
        }
        case 'pause':
          observer.pause();
          process.stderr.write('  Observation paused.\n');
          break;
        case 'resume':
          observer.resume();
          process.stderr.write('  Observation resumed.\n');
          break;
        case 'note': {
          const note = await input({ message: 'Note:' }).catch(() => '');
          if (note.trim()) {
            observer.logManualAction(note.trim());
            process.stderr.write('  Note captured.\n');
          }
          break;
        }
        case 'status': {
          const s = observer.getSession();
          if (s) {
            const summary = db.getActionSummary(s.id);
            process.stderr.write(`  Session: ${s.id.substring(0, 8)} | Status: ${s.status}\n`);
            for (const item of summary) {
              process.stderr.write(`    ${item.source}: ${item.count} actions (${formatDuration(item.total_seconds)})\n`);
            }
          }
          break;
        }
        default:
          if (trimmed) {
            process.stderr.write('  Unknown command. Available: stop, pause, resume, note, status\n');
          }
      }
    }

    // Apply data lifecycle on exit
    privacy.applyDataLifecycle();

    db.close();
  });

// ── shadowing timeline ──────────────────────────────────────────────────────

program
  .command('timeline [session-id]')
  .description('Show timeline of an observation session')
  .option('--source <source>', 'Filter by source (window/shell/git/file/manual)')
  .option('--limit <n>', 'Maximum number of entries', '50')
  .action((sessionId: string | undefined, opts) => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }

    // If no session ID, use the latest session
    let session = sessionId
      ? db.getObservationSession(sessionId)
      : db.listObservationSessions()[0] ?? null;

    if (!session) {
      // Try prefix match
      if (sessionId) {
        const all = db.listObservationSessions();
        const matches = all.filter(s => s.id.startsWith(sessionId));
        if (matches.length === 1) session = matches[0]!;
      }

      if (!session) {
        process.stderr.write('  No observation session found.\n');
        db.close();
        return;
      }
    }

    process.stderr.write(`\n  Session: ${session.id.substring(0, 8)} | ${session.started_at} | ${session.status}\n`);

    const actions = db.getObservedActions(session.id, {
      source: opts.source,
      limit: parseInt(opts.limit, 10),
    });

    if (actions.length === 0) {
      process.stderr.write('  No actions recorded.\n\n');
      db.close();
      return;
    }

    // Summary first
    const summary = db.getActionSummary(session.id);
    process.stderr.write('\n  Summary:\n');
    for (const item of summary) {
      process.stderr.write(`    ${item.source.padEnd(8)} ${String(item.count).padStart(4)} actions  ${formatDuration(item.total_seconds)}\n`);
    }

    process.stderr.write(`\n  Last ${actions.length} actions:\n\n`);

    for (const action of actions.reverse()) {
      const time = action.started_at.substring(11, 19);
      const dur = action.duration_seconds > 0 ? ` (${formatDuration(action.duration_seconds)})` : '';
      const source = `[${action.source}]`.padEnd(10);
      let detail = '';

      if (action.source === 'window') {
        detail = `${action.app_name ?? '?'}: ${action.window_title ?? ''}`;
      } else if (action.source === 'shell') {
        detail = `$ ${action.command ?? ''}`;
      } else if (action.source === 'file') {
        detail = action.file_path ?? '';
      } else if (action.source === 'manual') {
        detail = action.window_title ?? action.command ?? '';
      } else {
        detail = action.window_title ?? action.command ?? action.file_path ?? '';
      }

      process.stderr.write(`  ${time} ${source} ${detail.substring(0, 70)}${dur}\n`);
    }

    process.stderr.write('\n');
    db.close();
  });

// ── shadowing sessions ──────────────────────────────────────────────────────

program
  .command('sessions')
  .description('List observation sessions')
  .action(() => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }

    const sessions = db.listObservationSessions();

    if (sessions.length === 0) {
      process.stderr.write('\n  No observation sessions available.\n\n');
      db.close();
      return;
    }

    process.stderr.write(`\n  ${sessions.length} Session(s):\n\n`);
    for (const s of sessions) {
      const statusIcon = s.status === 'active' ? '[>>]' :
                         s.status === 'paused' ? '[||]' : '[ok]';
      process.stderr.write(
        `  ${s.id.substring(0, 8)}  ${statusIcon}  ${s.started_at}  ${String(s.total_actions).padStart(4)} actions  ${s.title ?? ''}\n`
      );
    }
    process.stderr.write('\n');
    db.close();
  });

// ── shadowing analyze ──────────────────────────────────────────────────────

program
  .command('analyze [session-id]')
  .description('Analyze observation session -> detect tasks -> generate SOPs')
  .option('--silence <seconds>', 'Threshold for activity blocks in seconds', '300')
  .action(async (sessionId: string | undefined, opts) => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }

    // Find session
    let targetSessionId = sessionId;
    if (!targetSessionId) {
      // Use latest completed session
      const sessions = db.listObservationSessions();
      const completed = sessions.find(s => s.status === 'completed');
      if (completed) {
        targetSessionId = completed.id;
      } else {
        process.stderr.write('\n  No completed observation session found.\n');
        process.stderr.write('  Start an observation first with: shadowing observe\n\n');
        db.close();
        return;
      }
    } else {
      // Prefix match
      const all = db.listObservationSessions();
      const matches = all.filter(s => s.id.startsWith(targetSessionId!));
      if (matches.length === 1) {
        targetSessionId = matches[0]!.id;
      } else if (matches.length === 0) {
        process.stderr.write(`\n  Session "${sessionId}" not found.\n\n`);
        process.exitCode = 1;
        db.close();
        return;
      }
    }

    const session = db.getObservationSession(targetSessionId);
    if (!session) {
      process.stderr.write(`\n  Session "${targetSessionId}" not found.\n\n`);
      process.exitCode = 1;
      db.close();
      return;
    }

    const actions = db.getActionTimeline(targetSessionId);
    if (actions.length === 0) {
      process.stderr.write(`\n  Session ${targetSessionId.substring(0, 8)} contains no actions.\n\n`);
      db.close();
      return;
    }

    process.stderr.write(`\n  Analyzing session ${targetSessionId.substring(0, 8)} (${actions.length} actions)...\n`);

    // Heuristic task-boundary suggestions (#29) — shown even without an API
    // key; explicit start/stop markers always win over these hints.
    const boundaries = suggestTaskBoundaries(actions);
    if (boundaries.length > 0) {
      process.stderr.write(`\n  Suggested task boundaries (heuristic):\n`);
      const reasonLabel = { idle_gap: 'idle gap', branch_switch: 'branch switch', cwd_change: 'directory change' } as const;
      for (const b of boundaries) {
        process.stderr.write(`    ~ ${b.at.substring(11, 16)}  ${reasonLabel[b.reason]}: ${b.detail}\n`);
      }
      process.stderr.write('\n');
    }

    try {
      const config = loadConfig();
      const analyzer = new SessionAnalyzer(config, db);
      const result = await analyzer.analyzeSession(targetSessionId);

      process.stderr.write(`\n  ${result.summary}\n\n`);

      if (result.clusters.length > 0) {
        process.stderr.write('  Detected tasks:\n');
        for (const cluster of result.clusters) {
          process.stderr.write(`    ● ${cluster.title} (${formatDuration(cluster.duration_seconds)}, Complexity: ${cluster.complexity}/5)\n`);
          process.stderr.write(`      ${cluster.description}\n`);
        }
        process.stderr.write('\n');
      }

      if (result.sops_generated.length > 0) {
        process.stderr.write('  Generated SOPs:\n');
        for (const sop of result.sops_generated) {
          process.stderr.write(`    ● ${sop.title} (${sop.sop_id.substring(0, 8)})\n`);
        }
        process.stderr.write('\n');
        process.stderr.write('  Tip: "shadowing list" shows all SOPs. "shadowing show <id>" shows details.\n\n');
      }
    } catch (err) {
      if (err instanceof SOPGenerationError) {
        process.stderr.write(`\n  Analysis failed: ${err.message}\n`);
        if (err.code === 'missing_api_key') {
          process.stderr.write('  Set ANTHROPIC_API_KEY for AI-based analysis.\n');
        }
      } else {
        process.stderr.write(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      process.stderr.write('\n');
    }

    db.close();
  });

// ── shadowing consent ───────────────────────────────────────────────────────

program
  .command('consent')
  .description('Consent management for observation')
  .option('--grant <scope>', 'Grant consent (window/shell/git/file/all)')
  .option('--revoke <scope>', 'Revoke consent')
  .option('--log', 'Show consent log')
  .action((opts) => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }

    const privacy = new PrivacyManager(db);

    if (opts.grant) {
      privacy.grantConsent(opts.grant);
      process.stderr.write(`  Consent granted: ${opts.grant}\n`);
    } else if (opts.revoke) {
      privacy.revokeConsent(opts.revoke);
      process.stderr.write(`  Consent revoked: ${opts.revoke}\n`);
    } else if (opts.log) {
      const log = privacy.getConsentLog();
      if (log.length === 0) {
        process.stderr.write('\n  No consent log available.\n\n');
      } else {
        process.stderr.write('\n  Consent log:\n\n');
        for (const entry of log) {
          const icon = entry.action === 'granted' ? '[+]' : '[-]';
          process.stderr.write(`  ${entry.recorded_at}  ${icon}  ${entry.scope}\n`);
        }
        process.stderr.write('\n');
      }
    } else {
      // Show current status
      const status = privacy.getConsentStatus();
      process.stderr.write('\n  Current consent status:\n\n');
      for (const [scope, granted] of Object.entries(status)) {
        const icon = granted ? '[+]' : '[-]';
        process.stderr.write(`  ${icon}  ${scope}\n`);
      }
      process.stderr.write('\n  Use --grant <scope> or --revoke <scope> to change.\n\n');
    }

    db.close();
  });

// ── shadowing exclude ───────────────────────────────────────────────────────

program
  .command('exclude')
  .description('Manage exclusion rules for observation')
  .option('--add <pattern>', 'Add new exclusion rule')
  .option('--type <type>', 'Rule type: app, title_pattern, url_pattern, path_pattern', 'title_pattern')
  .option('--remove <id>', 'Remove exclusion rule')
  .option('--defaults', 'Load default exclusion rules')
  .action((opts) => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }

    const privacy = new PrivacyManager(db);

    if (opts.add) {
      const ruleType = opts.type as ExclusionRule['rule_type'];
      const rule = privacy.addExclusion(ruleType, opts.add);
      process.stderr.write(`  Rule added: [${ruleType}] "${opts.add}" (ID: ${rule.id.substring(0, 8)})\n`);
    } else if (opts.remove) {
      privacy.removeExclusion(opts.remove);
      process.stderr.write(`  Rule removed.\n`);
    } else if (opts.defaults) {
      const defaults = getDefaultExclusions();
      let added = 0;
      for (const def of defaults) {
        privacy.addExclusion(def.rule_type, def.pattern);
        added++;
      }
      process.stderr.write(`  ${added} default exclusion rules loaded.\n`);
    } else {
      // List all rules
      const rules = privacy.listExclusions();
      if (rules.length === 0) {
        process.stderr.write('\n  No exclusion rules defined.\n');
        process.stderr.write('  Use --defaults to load default rules.\n\n');
      } else {
        process.stderr.write(`\n  ${rules.length} exclusion rule(s):\n\n`);
        for (const rule of rules) {
          process.stderr.write(`  ${rule.id.substring(0, 8)}  [${rule.rule_type.padEnd(14)}]  ${rule.pattern}\n`);
        }
        process.stderr.write('\n');
      }
    }

    db.close();
  });

// ── shadowing scrub ──────────────────────────────────────────────────────────

program
  .command('scrub')
  .description('Re-apply PII/secret redaction to all stored observation data (idempotent)')
  .action(() => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }

    const config = loadConfig();
    const anonymizer = new Anonymizer(config.anonymization);
    const redactor = (text: string): string => anonymizer.anonymize(text);

    const actions = db.scrubObservedActions(redactor);
    const tasks = db.scrubTasks(redactor);

    process.stderr.write(`\n  Scrub complete.\n`);
    process.stderr.write(`  Observed actions redacted: ${actions}\n`);
    process.stderr.write(`  Task records redacted:     ${tasks}\n\n`);
    db.close();
  });

// ── shadowing infra ─────────────────────────────────────────────────────────

program
  .command('infra [dir]')
  .description('Extract infrastructure context from project directory')
  .action((dir?: string) => {
    const projectDir = dir ?? process.cwd();

    if (!existsSync(projectDir)) {
      process.stderr.write(`  Directory not found: ${projectDir}\n`);
      return;
    }

    const graph = buildInfraGraph(projectDir);

    if (graph.nodes.length === 0) {
      process.stderr.write('\n  No infrastructure information found.\n\n');
      return;
    }

    process.stderr.write(`\n  Infrastructure context (${graph.nodes.length} nodes, ${graph.edges.length} edges):\n\n`);
    process.stderr.write(formatInfraGraph(graph) + '\n\n');
  });

// ── shadowing guide ──────────────────────────────────────────────────────────

program
  .command('guide')
  .description('Complete guide and workflow description')
  .option('--topic <topic>', 'Specific topic: quickstart, tasks, observe, sops, export, privacy, api')
  .action((opts) => {
    const topic = opts.topic ?? 'all';
    const w = process.stderr.write.bind(process.stderr);

    if (topic === 'all' || topic === 'quickstart') {
      w(`
  ╔══════════════════════════════════════════════════════════════════════╗
  ║                Agentic AI Shadowing — User Guide                   ║
  ╚══════════════════════════════════════════════════════════════════════╝

  Shadowing observes your workflows and automatically generates
  Standard Operating Procedures (SOPs). Fully local, anonymized,
  under your control.

  ── Quick Start ───────────────────────────────────────────────────

  1. Initialize:         shadowing init
  2. Start task:         shadowing start
  3. View SOPs:          shadowing list
  4. Show SOP:           shadowing show <id>
  5. Export SOPs:        shadowing export --all
  6. Web Dashboard:      shadowing ui

`);
    }

    if (topic === 'all' || topic === 'tasks') {
      w(`  ── Tasks (manual mode) ──────────────────────────────────────────────

  "shadowing start" launches an interactive mode:
  - Enter a task title and optional description
  - Add notes during your work
  - On completion, a SOP is automatically generated via Claude AI
  - Accept, edit, or regenerate the SOP

  More task commands:
    shadowing status          Show current task and statistics
    shadowing stats           Detailed metrics in terminal

`);
    }

    if (topic === 'all' || topic === 'observe') {
      w(`  ── Observation mode (automatic) ─────────────────────────────────────

  "shadowing observe" starts automatic workflow capture:
  - Captures active windows, shell commands, and file changes
  - Uses heartbeat deduplication: identical activity is not
    stored multiple times, but duration is extended
  - Requires one-time consent

  Commands in observe mode:
    status     Current session summary
    note       Add manual note
    pause      Pause observation
    resume     Resume observation
    stop       End session

  Options:
    --interval <ms>    Poll interval (default: 5000ms)
    --no-shell         Do not capture shell history
    --no-window        Disable window detection
    --work-hours       Only capture 8am-6pm
    --auto-sop         Auto-create tasks + SOPs after observation

  Automatic analysis:
    When --auto-sop is active, actions are grouped into logical
    tasks by AI and SOPs are generated after "stop".
    Alternatively: "shadowing analyze [session-id]" for manual analysis.

  Session management:
    shadowing sessions               List all sessions
    shadowing timeline [session-id]  Show session timeline
    shadowing analyze [session-id]   Analyze session → tasks + SOPs
    shadowing timeline --source shell  Filter by source

`);
    }

    if (topic === 'all' || topic === 'sops') {
      w(`  ── Manage SOPs ──────────────────────────────────────────────────────

  SOPs follow a status workflow:
    draft → reviewed → approved → exported

  Commands:
    shadowing list                    List all SOPs
    shadowing list --status draft     Filter by status
    shadowing list --tag accounting   Filter by tag
    shadowing list --search SAP       Free text search
    shadowing show <id>               Display SOP in terminal
    shadowing edit <id>               Edit SOP in editor
    shadowing delete <id>             Delete SOP
    shadowing tag <id> +new -old      Add/remove tags
    shadowing history <id>            Show version history
    shadowing diff <id>               Diff to previous version
    shadowing diff <id> 1             Diff to version 1

  Tip: SOP IDs can be abbreviated (first 4-8 characters are enough).

`);
    }

    if (topic === 'all' || topic === 'export') {
      w(`  ── Export ────────────────────────────────────────────────────────────

  Exports SOPs as anonymized Markdown files with manifest.

    shadowing export           Interactive selection
    shadowing export --all     Export all approved SOPs

  Export directory: ~/.datasynx/shadowing/exports/
  Structure:
    export_YYYY-MM-DD_HH-mm/
    ├── manifest.json          Metadata, tags, metrics
    └── sops/
        ├── sop_001.md
        └── sop_002.md

  Automatic anonymization:
  - Email addresses, IPs, URLs, phone numbers
  - File paths, IBANs, credit cards, tax IDs
  - Configurable via "shadowing config"

`);
    }

    if (topic === 'all' || topic === 'privacy') {
      w(`  ── Data Protection & Privacy ────────────────────────────────────────

  All data stays local. No cloud transmission (except Claude API
  for SOP generation).

  Consent:
    shadowing consent                 Show status
    shadowing consent --grant all     Grant consent for everything
    shadowing consent --revoke shell  Revoke shell capture
    shadowing consent --log           Show audit trail

  Exclusion rules (what is NOT captured):
    shadowing exclude                         Show rules
    shadowing exclude --defaults              Load default rules
                                              (password managers, banking, etc.)
    shadowing exclude --add "1Password" --type app
    shadowing exclude --add "*banking*" --type title_pattern
    shadowing exclude --add "*.env*" --type path_pattern
    shadowing exclude --remove <id>

  Redaction (on by default):
    Capture time:  PII + secrets are redacted BEFORE data reaches SQLite
                   (anonymization.redact_on_capture). API tokens, JWTs,
                   private keys and high-entropy strings are always redacted.
    Export time:   Second anonymization pass over every exported SOP.
    shadowing scrub                   Retroactively redact old databases

  Data lifecycle:
    0-7 days:    Full details (window titles, commands, paths)
    7-30 days:   Only app names + duration (details deleted)
    >90 days:    Data completely deleted

`);
    }

    if (topic === 'all' || topic === 'api') {
      w(`  ── Web Dashboard & API ──────────────────────────────────────────────

    shadowing ui               Start dashboard (default: port 3847)
    shadowing ui --port 8080   Use different port

  REST API endpoints:
    GET  /api/stats             Global statistics
    GET  /api/tasks             Task list (?status=active)
    GET  /api/tasks/active      Active task
    GET  /api/sops              SOP list (?status=, ?tag=, ?search=)
    GET  /api/sops/:id          SOP detail with metrics + versions
    PUT  /api/sops/:id/status   Change status
    GET  /api/sops/:id/diff     Diff to previous version
    GET  /api/tags              All tags
    GET  /api/exports           Export history

`);
    }

    if (topic === 'all' || topic === 'claude-code') {
      w(`  ── Claude Code Integration ──────────────────────────────────────────

  Shadowing integrates seamlessly with Claude Code via two mechanisms:

  1. MCP Server (Model Context Protocol)
     Claude Code can call Shadowing tools directly:

     Available MCP Tools (18):
       shadowing_start_task       Start task
       shadowing_complete_task    Complete task (generate SOP)
       shadowing_pause_task       Pause task
       shadowing_resume_task      Resume task
       shadowing_get_status       Get status
       shadowing_list_sops        List SOPs
       shadowing_get_sop          Get SOP detail
       shadowing_update_sop       Edit SOP
       shadowing_approve_sop      Approve SOP
       shadowing_review_sop       Review via elicitation (approve/reject)
       shadowing_add_tags         Add tags
       shadowing_log_observation  Log action
       shadowing_start_observation  Start session
       shadowing_stop_observation   End session
       shadowing_get_stats        Statistics
       shadowing_export_sops      Export SOPs
       shadowing_list_tasks       List tasks
       shadowing_get_timeline     Get timeline

  2. Hooks (automatic capture)
     Claude Code Hooks log tool calls automatically:
       PostToolUse → Every tool call is captured as ObservedAction
       Stop        → Session end is logged

  Setup:
    shadowing setup-hooks              Auto-configure everything
    shadowing setup-hooks --project-dir /path/to/project

  Start manually:
    shadowing mcp                      Start MCP server (stdio)

  Configuration is stored in .claude/settings.json.

`);
    }

    if (topic === 'all') {
      w(`  ── More Commands ────────────────────────────────────────────────────

    shadowing infra [dir]      Extract infrastructure context
                               (package.json, docker-compose, .env, Makefile)
    shadowing import-graph <p> Import Cartography graph (JSON)
    shadowing config           Open configuration in editor
    shadowing reset            Delete all data (with confirmation)

  ── Help for specific topics ─────────────────────────────────────────

    shadowing guide --topic quickstart   Quick start
    shadowing guide --topic tasks        Manual task mode
    shadowing guide --topic observe      Automatic observation mode
    shadowing guide --topic sops         SOP management
    shadowing guide --topic export       Export & anonymization
    shadowing guide --topic privacy      Data protection & consent
    shadowing guide --topic api          Web dashboard & REST API
    shadowing guide --topic claude-code  Claude Code integration

`);
    }
  });

// ── shadowing mcp ───────────────────────────────────────────────────────────

program
  .command('mcp')
  .description('Start MCP server (stdio by default; --http for Streamable HTTP)')
  .option('--http', 'Serve Streamable HTTP on /mcp instead of stdio (stateless)')
  .option('--port <port>', 'HTTP port (default: 3848)')
  .option('--host <host>', 'Bind host (default: 127.0.0.1; non-loopback requires SHADOWING_MCP_TOKEN)')
  .action(async (opts: { http?: boolean; port?: string; host?: string }) => {
    await startMCPServer({
      http: opts.http,
      port: opts.port ? parseInt(opts.port, 10) : undefined,
      host: opts.host,
    });
  });

// ── shadowing hook ──────────────────────────────────────────────────────────

program
  .command('hook')
  .description('Process Claude Code hook events (internal)')
  .option('--event <type>', 'Event type (PostToolUse, Stop, SessionStart)')
  .action(async (opts: { event?: string }) => {
    await runHookHandler(opts.event);
  });

// ── shadowing setup-hooks ───────────────────────────────────────────────────

program
  .command('setup-hooks')
  .description('Configure Claude Code hooks + MCP server (idempotent)')
  .option('--project-dir <path>', 'Project directory (default: cwd)')
  .option('--scope <scope>', 'Settings scope: local (settings.local.json, default), project (settings.json), user (~/.claude/settings.json)', 'local')
  .option('--dry-run', 'Show what would change without writing anything')
  .option('--uninstall', 'Remove the shadowing hooks and MCP registration')
  .action((opts: { projectDir?: string; scope?: string; dryRun?: boolean; uninstall?: boolean }) => {
    const projectDir = opts.projectDir ?? process.cwd();
    const scope = (opts.scope ?? 'local') as SetupScope;
    if (!['local', 'project', 'user'].includes(scope)) {
      process.stderr.write(`  Invalid scope: ${scope}. Use local, project, or user.\n`);
      process.exitCode = 1;
      return;
    }

    let result;
    try {
      result = applyClaudeSetup({ projectDir, scope, dryRun: opts.dryRun, uninstall: opts.uninstall });
    } catch (err) {
      process.stderr.write(`  ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
      return;
    }

    const verb = opts.dryRun ? 'Would change' : 'Changed';

    if (result.alreadyConfigured) {
      process.stderr.write('\n  Claude Code integration is already configured — nothing to do.\n\n');
      return;
    }
    if (result.changes.length === 0) {
      process.stderr.write('\n  Nothing to remove — shadowing is not configured here.\n\n');
      return;
    }

    process.stderr.write('\n');
    for (const change of result.changes) {
      if (change.after === null) {
        process.stderr.write(`  ${verb}: ${change.path} (deleted — contained only the shadowing entry)\n`);
        continue;
      }
      const status = change.before === null ? 'created' : 'updated';
      process.stderr.write(`  ${verb}: ${change.path} (${status})\n`);
      const diff = diffTexts(change.before ?? '', change.after);
      process.stderr.write(formatDiff(diff).split('\n').map(l => `    ${l}`).join('\n') + '\n');
    }

    if (opts.dryRun) {
      process.stderr.write('\n  Dry run — no files were written.\n\n');
      return;
    }

    if (opts.uninstall) {
      process.stderr.write('\n  Shadowing hooks and MCP registration removed.\n\n');
      return;
    }

    process.stderr.write(`\nClaude Code integration configured (scope: ${scope}).\n\n`);
    process.stderr.write(`  Hooks:\n`);
    process.stderr.write(`    PostToolUse → npx shadowing hook (log all tool calls)\n`);
    process.stderr.write(`    Stop        → npx shadowing hook --event stop (end session)\n\n`);
    process.stderr.write(`  MCP Server (.mcp.json):\n`);
    process.stderr.write(`    shadowing   → npx shadowing mcp (18 shadowing tools)\n\n`);
    process.stderr.write(`  Re-running is safe (idempotent). Remove with: shadowing setup-hooks --uninstall\n\n`);
  });

// ── shadowing setup (multi-framework harness) ───────────────────────────────

program
  .command('setup')
  .description('Register the shadowing MCP server with agent frameworks (Claude Code, Codex, OpenClaw, Hermes, AGENTS.md)')
  .option('--target <targets...>', 'Targets: claude, codex, openclaw, hermes, agents-md, all (default: detect installed)')
  .option('--project-dir <path>', 'Project directory (default: cwd)')
  .option('--dry-run', 'Show planned changes without applying them')
  .option('--uninstall', 'Remove the shadowing registration from the selected targets')
  .option('--yes', 'Apply without interactive confirmation')
  .action(async (opts: { target?: string[]; projectDir?: string; dryRun?: boolean; uninstall?: boolean; yes?: boolean }) => {
    const projectDir = opts.projectDir ?? process.cwd();
    const env = { projectDir };

    const ALL = ['claude', ...HARNESS_TARGETS] as const;
    let targets: string[];
    if (!opts.target || opts.target.includes('all')) {
      if (opts.target?.includes('all')) {
        targets = [...ALL];
      } else {
        const detected = detectHarnesses(env);
        targets = ['claude', ...HARNESS_TARGETS.filter(t => detected[t])];
        process.stderr.write(`\n  Detected targets: ${targets.join(', ')}\n`);
      }
    } else {
      targets = opts.target;
      const invalid = targets.filter(t => !ALL.includes(t as typeof ALL[number]));
      if (invalid.length > 0) {
        process.stderr.write(`  Unknown target(s): ${invalid.join(', ')}. Valid: ${ALL.join(', ')}\n`);
        process.exitCode = 1;
        return;
      }
    }

    // Show the plan
    process.stderr.write('\n  Plan:\n');
    for (const target of targets) {
      if (target === 'claude') {
        process.stderr.write(`    claude      ${opts.uninstall ? 'remove hooks + .mcp.json entry' : 'configure hooks + .mcp.json (idempotent)'}\n`);
      } else {
        const plan = planHarness(target as HarnessTarget, env, { uninstall: opts.uninstall });
        process.stderr.write(`    ${target.padEnd(11)} ${plan.actions.join('; ')}\n`);
      }
    }

    if (!opts.dryRun && !opts.yes) {
      const { confirm } = await import('@inquirer/prompts');
      const proceed = await confirm({ message: 'Apply these changes?', default: true });
      if (!proceed) {
        process.stderr.write('  Aborted — nothing was changed.\n');
        return;
      }
    }

    process.stderr.write('\n');
    let failures = 0;
    for (const target of targets) {
      if (target === 'claude') {
        try {
          const result = applyClaudeSetup({ projectDir, dryRun: opts.dryRun, uninstall: opts.uninstall });
          process.stderr.write(`  claude: ${result.alreadyConfigured ? 'already configured' : `${result.changes.length} file(s) ${opts.dryRun ? 'would change' : 'changed'}`}\n`);
        } catch (err) {
          process.stderr.write(`  claude: ${err instanceof Error ? err.message : String(err)}\n`);
          failures++;
        }
        continue;
      }
      const result = applyHarness(target as HarnessTarget, env, { uninstall: opts.uninstall, dryRun: opts.dryRun });
      for (const message of result.messages) {
        process.stderr.write(`  ${target}: ${message}\n`);
      }
      if (result.manualSnippet) {
        process.stderr.write(result.manualSnippet.split('\n').map(l => `      ${l}`).join('\n') + '\n');
      }
      if (!result.applied && !opts.dryRun && result.manualSnippet === undefined && !result.messages.some(m => m.includes('already') || m.includes('nothing to remove') || m.includes('no managed section'))) {
        failures++;
      }
    }

    if (failures > 0) process.exitCode = 1;
    process.stderr.write('\n');
  });

// ── shadowing publish (SOP → agent context) ─────────────────────────────────

program
  .command('publish <sop-id>')
  .description('Publish an APPROVED SOP into agent context (SKILL.md / AGENTS.md index) — always shows a diff and asks first')
  .option('--as <mode>', 'skill (SKILL.md directory) or agents-md (index section in AGENTS.md)', 'skill')
  .option('--target <targets...>', 'Skill roots: claude (.claude/skills), agents (.agents/skills), hermes (~/.hermes/skills)', ['claude'])
  .option('--project-dir <path>', 'Project directory (default: cwd)')
  .option('--dry-run', 'Show the diff without writing')
  .option('--yes', 'Apply without interactive confirmation')
  .action(async (sopIdPrefix: string, opts: { as: string; target: string[]; projectDir?: string; dryRun?: boolean; yes?: boolean }) => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }
    const config = loadConfig();
    const projectDir = opts.projectDir ?? process.cwd();
    const anonymizer = new Anonymizer(config.anonymization);

    const sop = findSOP(db, sopIdPrefix);
    if (!sop) { db.close(); return; }

    const plans: PublishPlan[] = [];
    try {
      if (opts.as === 'agents-md') {
        const approved = db.listSOPs({ status: 'approved' });
        if (!approved.some(s => s.id === sop.id)) {
          throw new Error(`SOP "${sop.title}" is ${sop.status} — only approved SOPs can be published.`);
        }
        const entries = approved.map(s => ({
          title: anonymizer.anonymize(s.title),
          description: anonymizer.anonymize(s.description ?? ''),
          skillName: skillNameForSOP(s),
        }));
        plans.push(planAgentsMdIndex(projectDir, entries));
      } else if (opts.as === 'skill') {
        const tags = db.getTagsForSOP(sop.id).map(t => t.name);
        for (const target of opts.target) {
          if (!['claude', 'agents', 'hermes'].includes(target)) {
            throw new Error(`Unknown target: ${target}. Valid: claude, agents, hermes`);
          }
          plans.push(planSkillPublish(sop, tags, anonymizer, target as PublishTarget, { projectDir }));
        }
      } else {
        throw new Error(`Unknown mode: ${opts.as}. Valid: skill, agents-md`);
      }
    } catch (err) {
      process.stderr.write(`  ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
      db.close();
      return;
    }

    // Show the diff for every planned write — never silent (#28)
    let anyChange = false;
    for (const plan of plans) {
      if (plan.before === plan.after) {
        process.stderr.write(`  Unchanged: ${plan.path}\n`);
        continue;
      }
      anyChange = true;
      process.stderr.write(`\n  ${plan.before === null ? 'Create' : 'Update'}: ${plan.path}\n`);
      const diff = diffTexts(plan.before ?? '', plan.after);
      process.stderr.write(formatDiff(diff).split('\n').map(l => `    ${l}`).join('\n') + '\n');
    }

    if (!anyChange) {
      process.stderr.write('\n  Everything already published and up to date.\n');
      db.close();
      return;
    }

    if (opts.dryRun) {
      process.stderr.write('\n  Dry run — no files were written.\n');
      db.close();
      return;
    }

    if (!opts.yes) {
      const { confirm } = await import('@inquirer/prompts');
      const proceed = await confirm({ message: 'Write these files?', default: false });
      if (!proceed) {
        process.stderr.write('  Aborted — nothing was written.\n');
        db.close();
        return;
      }
    }

    for (const plan of plans) {
      if (plan.before === plan.after) continue;
      applyPublishPlan(plan);
      process.stderr.write(`  Written: ${plan.path}\n`);
    }
    db.logAudit({
      entity_type: 'sop', entity_id: sop.id, action: 'publish',
      new_value: JSON.stringify({ mode: opts.as, targets: opts.target }),
      source: 'cli',
    });
    db.close();
  });

// ── Helpers ──────────────────────────────────────────────────────────────────

function findSOP(db: ShadowingDB, idPrefix: string) {
  // Try exact match first
  let sop = db.getSOP(idPrefix);
  if (sop) return sop;

  // Try prefix match
  const all = db.listSOPs();
  const matches = all.filter(s => s.id.startsWith(idPrefix));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    process.stderr.write(`  Multiple SOPs found for "${idPrefix}". Please provide a more specific ID.\n`);
    process.exitCode = 1;
    return null;
  }

  process.stderr.write(`  SOP not found: ${idPrefix}\n`);
  process.exitCode = 1;
  return null;
}

async function editSOPInEditor(db: ShadowingDB, sopId: string, editor: string): Promise<void> {
  editSOPInEditorSync(db, sopId, editor);
}

function editSOPInEditorSync(db: ShadowingDB, sopId: string, editor: string): void {
  const sop = db.getSOP(sopId);
  if (!sop) return;

  const tmpFile = join(tmpdir(), `shadowing-sop-${sopId}.md`);
  writeFileSync(tmpFile, sop.content_md, { encoding: 'utf8', mode: 0o600 });

  try {
    execSync(`${editor} "${tmpFile}"`, { stdio: 'inherit' });
    const updated = readFileSync(tmpFile, 'utf8');
    if (updated !== sop.content_md) {
      db.updateSOP(sopId, { content_md: updated });
      process.stderr.write('  SOP updated (new version).\n');
    } else {
      process.stderr.write('  No changes.\n');
    }
  } catch {
    process.stderr.write(`  Could not start editor: ${editor}\n`);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ok */ }
  }
}

// Top-level guard: any error that escapes a command handler is printed as a
// clean message (not a raw stack trace) and surfaces a non-zero exit code.
program.parseAsync().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`  ${message}\n`);
  process.exitCode = 1;
});
