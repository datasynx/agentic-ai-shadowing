import { Command } from 'commander';
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { ShadowingDB } from './db.js';
import { TaskManager, formatDuration } from './task-manager.js';
import { SOPGenerator, SOPGenerationError, buildSOPPreview, countSteps } from './sop-generator.js';
import { Anonymizer } from './anonymizer.js';
import { Exporter } from './exporter.js';
import { calculateSOPMetrics } from './metrics.js';
import { diffTexts, formatDiff } from './diff.js';
import { Observer } from './observer.js';
import { createShellHistoryReader } from './shell-history.js';
import { PrivacyManager, getDefaultExclusions } from './privacy.js';
import { buildInfraGraph, formatInfraGraph } from './infra-context.js';
import { checkCartographyInstalled, ensureCartography, locateJGFFile } from './cartography-check.js';
import { loadJGFFile } from './cartography.js';
import { startMCPServer } from './mcp-server.js';
import { runHookHandler } from './hook-handler.js';
import type { ExclusionRule } from './types.js';
import {
  ensureConfigDir, getConfigPath, getDbPath,
  loadConfig, saveConfig, getConfigDir,
} from './config.js';

const program = new Command();

program
  .name('shadowing')
  .description('Agentic AI Shadowing — beobachtet Tasks, generiert SOPs')
  .version('0.1.0');

// ── Helper: DB + Config laden ────────────────────────────────────────────────

function openDB(): ShadowingDB {
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    process.stderr.write('Datenbank nicht gefunden. Bitte zuerst "shadowing init" ausführen.\n');
    process.exitCode = 1;
    throw new Error('DB not initialized');
  }
  const db = new ShadowingDB(dbPath);
  return db;
}

function openDBWithCartographyCheck(): ShadowingDB {
  ensureCartography();
  return openDB();
}

// ── shadowing init ───────────────────────────────────────────────────────────

program
  .command('init')
  .description('Erstmalige Einrichtung (DB + Config anlegen)')
  .action(() => {
    // Check cartography package is installed
    const cartoCheck = checkCartographyInstalled();
    if (!cartoCheck.installed) {
      process.stderr.write(
        `Fehler: agentic-ai-cartography ist nicht installiert.\n` +
        `Shadowing benötigt die Nodes aus agentic-ai-cartography als Grundlage.\n` +
        `Bitte installieren Sie es mit:\n\n` +
        `  npm install @datasynx/agentic-ai-cartography\n\n`,
      );
      process.exitCode = 1;
      return;
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
      process.stderr.write(`  Cartography-Graph gefunden: ${cartoCheck.jgfPath}\n`);
    } else {
      process.stderr.write(
        `  Hinweis: cartography-graph.jgf.json nicht gefunden.\n` +
        `  Führen Sie zuerst einen Discovery-Run in agentic-ai-cartography aus,\n` +
        `  dann "shadowing import-graph <pfad>" oder legen Sie die Datei ab in:\n` +
        `    - ./datasynx-output/cartography-graph.jgf.json\n` +
        `    - ${getConfigDir()}/cartography-graph.jgf.json\n`,
      );
    }
    saveConfig(config);

    process.stderr.write(`\nShadowing initialisiert.\n`);
    process.stderr.write(`  DB:     ${dbPath}\n`);
    process.stderr.write(`  Config: ${configPath}\n`);
    process.stderr.write(`\nStarte mit: shadowing start\n`);
  });

// ── shadowing start ──────────────────────────────────────────────────────────

program
  .command('start')
  .description('Interaktiven Shadowing-Modus starten')
  .action(async () => {
    let db: ShadowingDB;
    try { db = openDBWithCartographyCheck(); } catch { return; }

    const config = loadConfig();
    const tm = new TaskManager(db);
    const gen = new SOPGenerator(config, db);

    // Dynamic import for inquirer (ESM)
    const { input, select, confirm } = await import('@inquirer/prompts');

    process.stderr.write('\n  Agentic AI Shadowing — Active\n\n');

    // Check for existing active task
    const active = tm.getActiveTask();
    if (active) {
      process.stderr.write(`  Laufender Task: "${active.title}"\n`);
      process.stderr.write(`  Gestartet: ${active.started_at}\n\n`);
    }

    // Main loop
    let running = true;
    while (running) {
      const currentTask = tm.getActiveTask();

      if (!currentTask) {
        const startNew = await confirm({ message: 'Neuen Task starten?' });
        if (!startNew) {
          running = false;
          break;
        }

        const title = await input({ message: 'Task-Titel:' });
        if (!title.trim()) continue;

        const description = await input({ message: 'Kurze Beschreibung (optional):' });
        const task = tm.startTask(title.trim(), description.trim() || undefined);
        process.stderr.write(`\n  Task gestartet: "${task.title}" (ID: ${task.id.substring(0, 8)})\n\n`);
        continue;
      }

      // Task is active — show options
      const elapsed = Math.round((Date.now() - new Date(currentTask.started_at).getTime()) / 1000);
      process.stderr.write(`\n  Aktueller Task: "${currentTask.title}"\n`);
      process.stderr.write(`  Laufzeit: ${formatDuration(elapsed)}\n\n`);

      const action = await select({
        message: 'Was möchtest du tun?',
        choices: [
          { value: 'complete', name: 'Task abschließen -> SOP generieren' },
          { value: 'pause', name: 'Task pausieren' },
          { value: 'cancel', name: 'Task abbrechen (keine SOP)' },
          { value: 'note', name: 'Notiz zum aktuellen Schritt hinzufügen' },
          { value: 'new', name: 'Neuen Task starten (aktuellen beenden)' },
          { value: 'quit', name: 'Shadowing beenden' },
        ],
      });

      switch (action) {
        case 'complete': {
          const complexity = await select({
            message: 'Wie komplex war dieser Task? (1-5)',
            choices: [
              { value: 1, name: '1 - Sehr einfach' },
              { value: 2, name: '2 - Einfach' },
              { value: 3, name: '3 - Mittel' },
              { value: 4, name: '4 - Komplex' },
              { value: 5, name: '5 - Sehr komplex' },
            ],
          });

          const { task, duration } = tm.completeTask(complexity);
          process.stderr.write(`\n  Task abgeschlossen. Dauer: ${duration}\n`);
          process.stderr.write('  SOP wird generiert...\n\n');

          try {
            const result = await gen.generateSOP(task);
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
            process.stderr.write(`  SOP generiert!\n`);
            process.stderr.write(buildSOPPreview(result.title, result.tags, steps) + '\n\n');

            const sopAction = await select({
              message: 'SOP-Aktion:',
              choices: [
                { value: 'accept', name: 'SOP akzeptieren' },
                { value: 'edit', name: 'SOP bearbeiten (öffnet Editor)' },
                { value: 'regenerate', name: 'SOP neu generieren' },
                { value: 'discard', name: 'SOP verwerfen' },
              ],
            });

            if (sopAction === 'accept') {
              db.updateSOPStatus(sop.id, 'reviewed');
              process.stderr.write('  SOP akzeptiert und als "reviewed" markiert.\n');
            } else if (sopAction === 'edit') {
              await editSOPInEditor(db, sop.id, config.editor);
            } else if (sopAction === 'regenerate') {
              process.stderr.write('  SOP wird neu generiert...\n');
              await gen.regenerateSOP(sop.id);
              process.stderr.write('  Neue Version erstellt.\n');
            } else if (sopAction === 'discard') {
              db.deleteSOP(sop.id);
              process.stderr.write('  SOP verworfen.\n');
            }
          } catch (err) {
            if (err instanceof SOPGenerationError) {
              switch (err.code) {
                case 'missing_api_key':
                  process.stderr.write(`  ${err.message}`);
                  break;
                case 'auth_failed':
                  process.stderr.write(`  Authentifizierung fehlgeschlagen: ${err.message}\n`);
                  break;
                case 'rate_limited':
                  process.stderr.write(`  API-Limit erreicht: ${err.message}\n`);
                  process.stderr.write('  Tipp: Versuche es in einigen Minuten erneut mit "shadowing edit <sop-id>".\n');
                  break;
                case 'api_error':
                  process.stderr.write(`  Claude API Fehler: ${err.message}\n`);
                  break;
                case 'parse_error':
                  process.stderr.write(`  Parsing-Fehler: ${err.message}\n`);
                  break;
                default:
                  process.stderr.write(`  Fehler bei SOP-Generierung: ${err.message}\n`);
              }
            } else {
              process.stderr.write(`  Unerwarteter Fehler: ${err instanceof Error ? err.message : String(err)}\n`);
            }
            process.stderr.write('  Task wurde trotzdem als abgeschlossen markiert.\n');
          }
          break;
        }

        case 'pause':
          tm.pauseTask();
          process.stderr.write('  Task pausiert.\n');
          break;

        case 'cancel':
          tm.cancelTask();
          process.stderr.write('  Task abgebrochen.\n');
          break;

        case 'note': {
          const note = await input({ message: 'Notiz:' });
          if (note.trim()) {
            tm.addNote(note.trim());
            process.stderr.write('  Notiz hinzugefügt.\n');
          }
          break;
        }

        case 'new': {
          // Complete current task first
          const { duration } = tm.completeTask();
          process.stderr.write(`  Task abgeschlossen (${duration}). Starte neuen Task...\n`);
          break;
        }

        case 'quit':
          running = false;
          break;
      }
    }

    db.close();
    process.stderr.write('\nShadowing beendet.\n');
  });

// ── shadowing status ─────────────────────────────────────────────────────────

program
  .command('status')
  .description('Aktuellen Task und Statistiken anzeigen')
  .action(() => {
    let db: ShadowingDB;
    try { db = openDBWithCartographyCheck(); } catch { return; }

    const tm = new TaskManager(db);
    const active = tm.getActiveTask();
    const stats = db.getGlobalStats();

    if (active) {
      const elapsed = Math.round((Date.now() - new Date(active.started_at).getTime()) / 1000);
      process.stderr.write(`\n  Aktiver Task: "${active.title}"\n`);
      process.stderr.write(`  Laufzeit: ${formatDuration(elapsed)}\n`);
      if (active.description) process.stderr.write(`  Beschreibung: ${active.description.substring(0, 80)}\n`);
    } else {
      process.stderr.write('\n  Kein aktiver Task.\n');
    }

    process.stderr.write(`\n  Tasks: ${stats.total_tasks} (${stats.completed_tasks} abgeschlossen)\n`);
    process.stderr.write(`  SOPs:  ${stats.total_sops} (${stats.approved_sops} approved, ${stats.draft_sops} draft)\n`);
    process.stderr.write(`  Tags:  ${stats.total_tags} | Exports: ${stats.total_exports}\n\n`);

    db.close();
  });

// ── shadowing list ───────────────────────────────────────────────────────────

program
  .command('list')
  .description('Alle SOPs auflisten')
  .option('--status <status>', 'Filter nach Status (draft/reviewed/approved/exported/archived)')
  .option('--tag <tag>', 'Filter nach Tag')
  .option('--search <query>', 'Freitextsuche')
  .action((opts) => {
    let db: ShadowingDB;
    try { db = openDBWithCartographyCheck(); } catch { return; }

    const sops = db.listSOPs({
      status: opts.status,
      tag: opts.tag,
      search: opts.search,
    });

    if (sops.length === 0) {
      process.stderr.write('\n  Keine SOPs gefunden.\n\n');
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
  .description('Eine SOP im Terminal anzeigen')
  .action((sopId: string) => {
    let db: ShadowingDB;
    try { db = openDBWithCartographyCheck(); } catch { return; }

    const sop = findSOP(db, sopId);
    if (!sop) { db.close(); return; }

    const tags = db.getTagsForSOP(sop.id).map(t => `#${t.name}`).join(' ');
    const config = loadConfig();
    const metrics = calculateSOPMetrics(db, sop.id, config.metrics.quality_score_weights);

    process.stderr.write(`\n  ID: ${sop.id} | Version: ${sop.version} | Status: ${sop.status}\n`);
    process.stderr.write(`  Tags: ${tags || '(keine)'}\n`);
    if (metrics.execution_count > 0) {
      process.stderr.write(`  Ausführungen: ${metrics.execution_count} | Avg: ${formatDuration(metrics.avg_duration_seconds)}\n`);
      process.stderr.write(`  Qualität: ${metrics.overall_quality_score}%\n`);
    }
    process.stderr.write('\n---\n\n');
    process.stdout.write(sop.content_md + '\n');

    db.close();
  });

// ── shadowing edit ───────────────────────────────────────────────────────────

program
  .command('edit <sop-id>')
  .description('SOP im Standard-Editor öffnen')
  .action((sopId: string) => {
    let db: ShadowingDB;
    try { db = openDBWithCartographyCheck(); } catch { return; }

    const sop = findSOP(db, sopId);
    if (!sop) { db.close(); return; }

    const config = loadConfig();
    editSOPInEditorSync(db, sop.id, config.editor);
    db.close();
  });

// ── shadowing delete ─────────────────────────────────────────────────────────

program
  .command('delete <sop-id>')
  .description('SOP unwiderruflich löschen')
  .action(async (sopId: string) => {
    let db: ShadowingDB;
    try { db = openDBWithCartographyCheck(); } catch { return; }

    const sop = findSOP(db, sopId);
    if (!sop) { db.close(); return; }

    const { confirm } = await import('@inquirer/prompts');
    const yes = await confirm({ message: `SOP "${sop.title}" wirklich löschen?` });
    if (yes) {
      db.deleteSOP(sop.id);
      process.stderr.write('  SOP gelöscht.\n');
    }
    db.close();
  });

// ── shadowing history ────────────────────────────────────────────────────────

program
  .command('history <sop-id>')
  .description('Versionshistorie einer SOP anzeigen')
  .action((sopId: string) => {
    let db: ShadowingDB;
    try { db = openDBWithCartographyCheck(); } catch { return; }

    const sop = findSOP(db, sopId);
    if (!sop) { db.close(); return; }

    const versions = db.getSOPVersions(sop.id);
    process.stderr.write(`\n  Versionshistorie: "${sop.title}" (aktuell: v${sop.version})\n\n`);

    if (versions.length === 0) {
      process.stderr.write('  Keine älteren Versionen vorhanden.\n\n');
      db.close();
      return;
    }

    for (const v of versions) {
      const summary = v.change_summary ? ` — ${v.change_summary}` : '';
      process.stderr.write(`  v${v.version}  ${v.changed_at}  "${v.title}"${summary}\n`);
    }
    process.stderr.write(`\n  Nutze "shadowing diff <sop-id> <version>" um Änderungen zu sehen.\n\n`);

    db.close();
  });

// ── shadowing diff ───────────────────────────────────────────────────────────

program
  .command('diff <sop-id> [version]')
  .description('Diff zwischen SOP-Versionen anzeigen')
  .option('--from <version>', 'Ausgangsversion (default: vorherige)')
  .option('--to <version>', 'Zielversion (default: aktuell)')
  .action((sopId: string, versionArg: string | undefined, opts: { from?: string; to?: string }) => {
    let db: ShadowingDB;
    try { db = openDBWithCartographyCheck(); } catch { return; }

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
        process.stderr.write(`  Version ${oldVersion} nicht gefunden.\n`);
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
      if (!vFrom) { process.stderr.write(`  Version ${oldVersion} nicht gefunden.\n`); db.close(); return; }
      oldContent = vFrom.content_md;
      newContent = vTo ? vTo.content_md : sop.content_md;
    } else {
      // Default: previous version vs current
      const versions = db.getSOPVersions(sop.id);
      if (versions.length === 0) {
        process.stderr.write('  Keine älteren Versionen zum Vergleichen.\n');
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
  .description('Tags hinzufügen (+tag) oder entfernen (-tag)')
  .action((sopId: string, tags: string[]) => {
    let db: ShadowingDB;
    try { db = openDBWithCartographyCheck(); } catch { return; }

    const sop = findSOP(db, sopId);
    if (!sop) { db.close(); return; }

    for (const raw of tags) {
      if (raw.startsWith('-')) {
        const name = raw.substring(1);
        const allTags = db.getTagsForSOP(sop.id);
        const match = allTags.find(t => t.name.toLowerCase() === name.toLowerCase());
        if (match) {
          db.removeTagFromSOP(sop.id, match.id);
          process.stderr.write(`  Tag entfernt: #${name}\n`);
        }
      } else {
        const name = raw.startsWith('+') ? raw.substring(1) : raw;
        db.addTagToSOP(sop.id, name, false);
        process.stderr.write(`  Tag hinzugefügt: #${name}\n`);
      }
    }

    db.close();
  });

// ── shadowing stats ──────────────────────────────────────────────────────────

program
  .command('stats')
  .description('Metriken-Dashboard im Terminal')
  .action(() => {
    let db: ShadowingDB;
    try { db = openDBWithCartographyCheck(); } catch { return; }

    const stats = db.getGlobalStats();
    const config = loadConfig();

    process.stderr.write('\n  === Shadowing Statistiken ===\n\n');
    process.stderr.write(`  Tasks:        ${stats.total_tasks} gesamt (${stats.completed_tasks} abgeschlossen, ${stats.active_tasks} aktiv)\n`);
    process.stderr.write(`  SOPs:         ${stats.total_sops} gesamt\n`);
    process.stderr.write(`    Draft:      ${stats.draft_sops}\n`);
    process.stderr.write(`    Reviewed:   ${stats.reviewed_sops}\n`);
    process.stderr.write(`    Approved:   ${stats.approved_sops}\n`);
    process.stderr.write(`    Exported:   ${stats.exported_sops}\n`);
    process.stderr.write(`  Ausführungen: ${stats.total_executions}\n`);
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
  .description('SOPs exportieren')
  .option('--all', 'Alle approved SOPs exportieren')
  .action(async (opts) => {
    let db: ShadowingDB;
    try { db = openDBWithCartographyCheck(); } catch { return; }

    const config = loadConfig();
    const anonymizer = new Anonymizer(config.anonymization);
    const exporter = new Exporter(db, anonymizer, config);

    if (opts.all) {
      try {
        const result = exporter.exportAll();
        process.stderr.write(`\n  ${result.sop_count} SOP(s) exportiert.\n`);
        process.stderr.write(`  Pfad: ${result.export_path}\n\n`);
      } catch (err) {
        process.stderr.write(`  Fehler: ${err instanceof Error ? err.message : err}\n`);
      }
      db.close();
      return;
    }

    // Interactive selection
    const approved = db.listSOPs({ status: 'approved' });
    const reviewed = db.listSOPs({ status: 'reviewed' });
    const available = [...approved, ...reviewed];

    if (available.length === 0) {
      process.stderr.write('\n  Keine SOPs zum Exportieren. SOPs müssen "approved" oder "reviewed" sein.\n\n');
      db.close();
      return;
    }

    const { checkbox, confirm } = await import('@inquirer/prompts');
    const selected = await checkbox({
      message: 'SOPs zum Export auswählen:',
      choices: available.map(s => ({
        value: s.id,
        name: `[${s.status}] ${s.title}`,
      })),
    });

    if (selected.length === 0) {
      process.stderr.write('  Keine SOPs ausgewählt.\n');
      db.close();
      return;
    }

    const yes = await confirm({ message: `${selected.length} SOP(s) anonymisiert exportieren?` });
    if (yes) {
      const result = exporter.exportSOPs(selected);
      process.stderr.write(`\n  ${result.sop_count} SOP(s) exportiert.\n`);
      process.stderr.write(`  Pfad: ${result.export_path}\n\n`);
    }

    db.close();
  });

// ── shadowing ui ─────────────────────────────────────────────────────────────

program
  .command('ui')
  .description('Web-Dashboard starten')
  .option('-p, --port <port>', 'Port (default: config.ui_port)')
  .action(async (opts) => {
    let db: ShadowingDB;
    try { db = openDBWithCartographyCheck(); } catch { return; }

    const config = loadConfig();
    const port = opts.port ? parseInt(opts.port, 10) : config.ui_port;

    const { createUIServer } = await import('./ui-server.js');
    const server = createUIServer(db, config);

    server.listen(port, () => {
      process.stderr.write(`\n  Shadowing Dashboard gestartet.\n`);
      process.stderr.write(`  http://localhost:${port}\n\n`);
      process.stderr.write('  Strg+C zum Beenden.\n');
    });

    process.on('SIGINT', () => {
      server.close();
      db.close();
      process.stderr.write('\n  Dashboard beendet.\n');
    });
  });

// ── shadowing import-graph ───────────────────────────────────────────────────

program
  .command('import-graph <path>')
  .description('Cartography-Graph (JGF) importieren')
  .action((path: string) => {
    // Check cartography package is installed
    try { ensureCartography(); } catch { return; }

    if (!existsSync(path)) {
      process.stderr.write(`  Datei nicht gefunden: ${path}\n`);
      process.exitCode = 1;
      return;
    }

    // Validate the file is a valid JGF or CartographyGraph
    const graph = loadJGFFile(path);
    if (!graph) {
      process.stderr.write(`  Datei konnte nicht als Cartography-Graph geladen werden: ${path}\n`);
      process.stderr.write(`  Erwartet: cartography-graph.jgf.json (JGF-Format)\n`);
      process.exitCode = 1;
      return;
    }

    const config = loadConfig();
    config.cartography_graph_path = path;
    saveConfig(config);
    process.stderr.write(`  Cartography-Graph importiert: ${path}\n`);
    process.stderr.write(`  ${graph.nodes.length} Knoten, ${graph.edges.length} Kanten geladen.\n`);
  });

// ── shadowing config ─────────────────────────────────────────────────────────

program
  .command('config')
  .description('Konfiguration bearbeiten')
  .action(() => {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) {
      saveConfig(loadConfig());
    }
    const config = loadConfig();
    const editor = config.editor || process.env['EDITOR'] || 'vi';

    try {
      execSync(`${editor} "${configPath}"`, { stdio: 'inherit' });
      process.stderr.write('  Config gespeichert.\n');
    } catch {
      process.stderr.write(`  Editor konnte nicht gestartet werden: ${editor}\n`);
      process.stderr.write(`  Config-Pfad: ${configPath}\n`);
    }
  });

// ── shadowing reset ──────────────────────────────────────────────────────────

program
  .command('reset')
  .description('Alle Daten löschen')
  .action(async () => {
    const { confirm } = await import('@inquirer/prompts');
    const yes = await confirm({
      message: 'Alle Daten (DB + Config) unwiderruflich löschen?',
      default: false,
    });

    if (!yes) return;

    const dbPath = getDbPath();
    const configPath = getConfigPath();

    try { if (existsSync(dbPath)) unlinkSync(dbPath); } catch { /* ok */ }
    try { if (existsSync(configPath)) unlinkSync(configPath); } catch { /* ok */ }

    process.stderr.write('  Alle Daten gelöscht. "shadowing init" zum Neustart.\n');
  });

// ── shadowing observe ────────────────────────────────────────────────────────

program
  .command('observe')
  .description('Beobachtungsmodus starten (automatische Workflow-Erfassung)')
  .option('--interval <ms>', 'Poll-Intervall in Millisekunden', '5000')
  .option('--no-shell', 'Shell-History nicht erfassen')
  .option('--work-hours', 'Nur während Arbeitszeiten erfassen')
  .action(async (opts) => {
    let db: ShadowingDB;
    try { db = openDBWithCartographyCheck(); } catch { return; }

    const privacy = new PrivacyManager(db);

    // Check consent
    if (!privacy.hasConsent('all')) {
      const { confirm } = await import('@inquirer/prompts');
      process.stderr.write('\n  Beobachtungsmodus erfordert Zustimmung zur Datenerfassung.\n');
      process.stderr.write('  Erfasst werden: aktive Fenster, Shell-Befehle, Dateiänderungen.\n');
      process.stderr.write('  Alle Daten bleiben lokal. Keine Cloud-Übertragung.\n\n');

      const yes = await confirm({ message: 'Zustimmung zur Beobachtung erteilen?' });
      if (!yes) {
        process.stderr.write('  Beobachtung abgebrochen.\n');
        db.close();
        return;
      }
      privacy.grantConsent('all');
      process.stderr.write('  Zustimmung erteilt.\n\n');
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

    const { input } = await import('@inquirer/prompts');

    const session = observer.start();
    process.stderr.write(`\n  Beobachtung gestartet (Session: ${session.id.substring(0, 8)})\n`);
    process.stderr.write(`  Intervall: ${opts.interval}ms\n`);
    process.stderr.write('  Befehle: "stop" = beenden, "pause" = pausieren, "note" = Notiz\n\n');

    let running = true;
    while (running) {
      const cmd = await input({ message: '>' }).catch(() => 'stop');
      const trimmed = cmd.trim().toLowerCase();

      switch (trimmed) {
        case 'stop':
        case 'quit':
        case 'exit': {
          const completed = observer.stop();
          if (completed) {
            process.stderr.write(`  Session beendet. ${completed.total_actions} Aktionen erfasst.\n`);
          }
          running = false;
          break;
        }
        case 'pause':
          observer.pause();
          process.stderr.write('  Beobachtung pausiert.\n');
          break;
        case 'resume':
          observer.resume();
          process.stderr.write('  Beobachtung fortgesetzt.\n');
          break;
        case 'note': {
          const note = await input({ message: 'Notiz:' }).catch(() => '');
          if (note.trim()) {
            observer.logManualAction(note.trim());
            process.stderr.write('  Notiz erfasst.\n');
          }
          break;
        }
        case 'status': {
          const s = observer.getSession();
          if (s) {
            const summary = db.getActionSummary(s.id);
            process.stderr.write(`  Session: ${s.id.substring(0, 8)} | Status: ${s.status}\n`);
            for (const item of summary) {
              process.stderr.write(`    ${item.source}: ${item.count} Aktionen (${formatDuration(item.total_seconds)})\n`);
            }
          }
          break;
        }
        default:
          if (trimmed) {
            process.stderr.write('  Unbekannter Befehl. Verfügbar: stop, pause, resume, note, status\n');
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
  .description('Zeitachse einer Beobachtungssession anzeigen')
  .option('--source <source>', 'Filter nach Quelle (window/shell/git/file/manual)')
  .option('--limit <n>', 'Maximale Anzahl Einträge', '50')
  .action((sessionId: string | undefined, opts) => {
    let db: ShadowingDB;
    try { db = openDBWithCartographyCheck(); } catch { return; }

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
        process.stderr.write('  Keine Beobachtungssession gefunden.\n');
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
      process.stderr.write('  Keine Aktionen aufgezeichnet.\n\n');
      db.close();
      return;
    }

    // Summary first
    const summary = db.getActionSummary(session.id);
    process.stderr.write('\n  Zusammenfassung:\n');
    for (const item of summary) {
      process.stderr.write(`    ${item.source.padEnd(8)} ${String(item.count).padStart(4)} Aktionen  ${formatDuration(item.total_seconds)}\n`);
    }

    process.stderr.write(`\n  Letzte ${actions.length} Aktionen:\n\n`);

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
  .description('Beobachtungssessions auflisten')
  .action(() => {
    let db: ShadowingDB;
    try { db = openDBWithCartographyCheck(); } catch { return; }

    const sessions = db.listObservationSessions();

    if (sessions.length === 0) {
      process.stderr.write('\n  Keine Beobachtungssessions vorhanden.\n\n');
      db.close();
      return;
    }

    process.stderr.write(`\n  ${sessions.length} Session(s):\n\n`);
    for (const s of sessions) {
      const statusIcon = s.status === 'active' ? '[>>]' :
                         s.status === 'paused' ? '[||]' : '[ok]';
      process.stderr.write(
        `  ${s.id.substring(0, 8)}  ${statusIcon}  ${s.started_at}  ${String(s.total_actions).padStart(4)} Aktionen  ${s.title ?? ''}\n`
      );
    }
    process.stderr.write('\n');
    db.close();
  });

// ── shadowing consent ───────────────────────────────────────────────────────

program
  .command('consent')
  .description('Zustimmungsmanagement für Beobachtung')
  .option('--grant <scope>', 'Zustimmung erteilen (window/shell/git/file/all)')
  .option('--revoke <scope>', 'Zustimmung widerrufen')
  .option('--log', 'Consent-Protokoll anzeigen')
  .action((opts) => {
    let db: ShadowingDB;
    try { db = openDBWithCartographyCheck(); } catch { return; }

    const privacy = new PrivacyManager(db);

    if (opts.grant) {
      privacy.grantConsent(opts.grant);
      process.stderr.write(`  Zustimmung erteilt: ${opts.grant}\n`);
    } else if (opts.revoke) {
      privacy.revokeConsent(opts.revoke);
      process.stderr.write(`  Zustimmung widerrufen: ${opts.revoke}\n`);
    } else if (opts.log) {
      const log = privacy.getConsentLog();
      if (log.length === 0) {
        process.stderr.write('\n  Kein Consent-Protokoll vorhanden.\n\n');
      } else {
        process.stderr.write('\n  Consent-Protokoll:\n\n');
        for (const entry of log) {
          const icon = entry.action === 'granted' ? '[+]' : '[-]';
          process.stderr.write(`  ${entry.recorded_at}  ${icon}  ${entry.scope}\n`);
        }
        process.stderr.write('\n');
      }
    } else {
      // Show current status
      const status = privacy.getConsentStatus();
      process.stderr.write('\n  Aktueller Consent-Status:\n\n');
      for (const [scope, granted] of Object.entries(status)) {
        const icon = granted ? '[+]' : '[-]';
        process.stderr.write(`  ${icon}  ${scope}\n`);
      }
      process.stderr.write('\n  Nutze --grant <scope> oder --revoke <scope> zum Ändern.\n\n');
    }

    db.close();
  });

// ── shadowing exclude ───────────────────────────────────────────────────────

program
  .command('exclude')
  .description('Ausschlussregeln für die Beobachtung verwalten')
  .option('--add <pattern>', 'Neue Ausschlussregel hinzufügen')
  .option('--type <type>', 'Regeltyp: app, title_pattern, url_pattern, path_pattern', 'title_pattern')
  .option('--remove <id>', 'Ausschlussregel entfernen')
  .option('--defaults', 'Standard-Ausschlussregeln laden')
  .action((opts) => {
    let db: ShadowingDB;
    try { db = openDBWithCartographyCheck(); } catch { return; }

    const privacy = new PrivacyManager(db);

    if (opts.add) {
      const ruleType = opts.type as ExclusionRule['rule_type'];
      const rule = privacy.addExclusion(ruleType, opts.add);
      process.stderr.write(`  Regel hinzugefügt: [${ruleType}] "${opts.add}" (ID: ${rule.id.substring(0, 8)})\n`);
    } else if (opts.remove) {
      privacy.removeExclusion(opts.remove);
      process.stderr.write(`  Regel entfernt.\n`);
    } else if (opts.defaults) {
      const defaults = getDefaultExclusions();
      let added = 0;
      for (const def of defaults) {
        privacy.addExclusion(def.rule_type, def.pattern);
        added++;
      }
      process.stderr.write(`  ${added} Standard-Ausschlussregeln geladen.\n`);
    } else {
      // List all rules
      const rules = privacy.listExclusions();
      if (rules.length === 0) {
        process.stderr.write('\n  Keine Ausschlussregeln definiert.\n');
        process.stderr.write('  Nutze --defaults zum Laden der Standardregeln.\n\n');
      } else {
        process.stderr.write(`\n  ${rules.length} Ausschlussregel(n):\n\n`);
        for (const rule of rules) {
          process.stderr.write(`  ${rule.id.substring(0, 8)}  [${rule.rule_type.padEnd(14)}]  ${rule.pattern}\n`);
        }
        process.stderr.write('\n');
      }
    }

    db.close();
  });

// ── shadowing infra ─────────────────────────────────────────────────────────

program
  .command('infra [dir]')
  .description('Infrastruktur-Kontext aus Projektverzeichnis extrahieren')
  .action((dir?: string) => {
    const projectDir = dir ?? process.cwd();

    if (!existsSync(projectDir)) {
      process.stderr.write(`  Verzeichnis nicht gefunden: ${projectDir}\n`);
      return;
    }

    const graph = buildInfraGraph(projectDir);

    if (graph.nodes.length === 0) {
      process.stderr.write('\n  Keine Infrastruktur-Informationen gefunden.\n\n');
      return;
    }

    process.stderr.write(`\n  Infrastruktur-Kontext (${graph.nodes.length} Knoten, ${graph.edges.length} Kanten):\n\n`);
    process.stderr.write(formatInfraGraph(graph) + '\n\n');
  });

// ── shadowing guide ──────────────────────────────────────────────────────────

program
  .command('guide')
  .description('Komplette Anleitung und Workflow-Beschreibung')
  .option('--topic <topic>', 'Spezifisches Thema: quickstart, tasks, observe, sops, export, privacy, api')
  .action((opts) => {
    const topic = opts.topic ?? 'all';
    const w = process.stderr.write.bind(process.stderr);

    if (topic === 'all' || topic === 'quickstart') {
      w(`
  ╔══════════════════════════════════════════════════════════════════════╗
  ║              Agentic AI Shadowing — Benutzerhandbuch               ║
  ╚══════════════════════════════════════════════════════════════════════╝

  Shadowing beobachtet deine Arbeitsabläufe und generiert daraus
  automatisch Standard Operating Procedures (SOPs). Vollständig lokal,
  anonymisiert, unter deiner Kontrolle.

  ── Schnellstart ────────────────────────────────────────────────────

  1. Initialisieren:     shadowing init
  2. Task starten:       shadowing start
  3. SOPs ansehen:       shadowing list
  4. SOP anzeigen:       shadowing show <id>
  5. SOPs exportieren:   shadowing export --all
  6. Web-Dashboard:      shadowing ui

`);
    }

    if (topic === 'all' || topic === 'tasks') {
      w(`  ── Tasks (manueller Modus) ──────────────────────────────────────────

  "shadowing start" startet einen interaktiven Modus:
  - Du gibst einen Task-Titel und optionale Beschreibung ein
  - Während der Arbeit kannst du Notizen hinzufügen
  - Beim Abschluss wird automatisch eine SOP per Claude AI generiert
  - Du kannst die SOP akzeptieren, bearbeiten oder neu generieren

  Weitere Task-Befehle:
    shadowing status          Aktuellen Task und Statistiken anzeigen
    shadowing stats           Detaillierte Metriken im Terminal

`);
    }

    if (topic === 'all' || topic === 'observe') {
      w(`  ── Beobachtungsmodus (automatisch) ──────────────────────────────────

  "shadowing observe" startet die automatische Workflow-Erfassung:
  - Erfasst aktive Fenster, Shell-Befehle und Dateiänderungen
  - Nutzt Heartbeat-Deduplikation: gleiche Aktivität wird nicht
    mehrfach gespeichert, sondern die Dauer verlängert
  - Erfordert einmalige Zustimmung (Consent)

  Befehle im Observe-Modus:
    status     Aktuelle Session-Zusammenfassung
    note       Manuelle Notiz hinzufügen
    pause      Beobachtung pausieren
    resume     Beobachtung fortsetzen
    stop       Session beenden

  Optionen:
    --interval <ms>    Poll-Intervall (default: 5000ms)
    --no-shell         Shell-History nicht erfassen
    --work-hours       Nur 8-18 Uhr erfassen

  Session-Verwaltung:
    shadowing sessions               Alle Sessions auflisten
    shadowing timeline [session-id]  Zeitachse einer Session anzeigen
    shadowing timeline --source shell  Nach Quelle filtern

`);
    }

    if (topic === 'all' || topic === 'sops') {
      w(`  ── SOPs verwalten ───────────────────────────────────────────────────

  SOPs durchlaufen einen Status-Workflow:
    draft → reviewed → approved → exported

  Befehle:
    shadowing list                    Alle SOPs auflisten
    shadowing list --status draft     Nach Status filtern
    shadowing list --tag buchhaltung  Nach Tag filtern
    shadowing list --search SAP       Freitextsuche
    shadowing show <id>               SOP im Terminal anzeigen
    shadowing edit <id>               SOP im Editor bearbeiten
    shadowing delete <id>             SOP löschen
    shadowing tag <id> +neu -alt      Tags hinzufügen/entfernen
    shadowing history <id>            Versionshistorie anzeigen
    shadowing diff <id>               Diff zur Vorgängerversion
    shadowing diff <id> 1             Diff zu Version 1

  Tipp: SOP-IDs können abgekürzt werden (erste 4-8 Zeichen reichen).

`);
    }

    if (topic === 'all' || topic === 'export') {
      w(`  ── Export ────────────────────────────────────────────────────────────

  Exportiert SOPs als anonymisierte Markdown-Dateien mit Manifest.

    shadowing export           Interaktive Auswahl
    shadowing export --all     Alle approved SOPs exportieren

  Export-Verzeichnis: ~/.datasynx/shadowing/exports/
  Struktur:
    export_YYYY-MM-DD_HH-mm/
    ├── manifest.json          Metadaten, Tags, Metriken
    └── sops/
        ├── sop_001.md
        └── sop_002.md

  Automatische Anonymisierung:
  - E-Mail-Adressen, IPs, URLs, Telefonnummern
  - Dateipfade, IBANs, Kreditkarten, Steuer-IDs
  - Konfigurierbar über "shadowing config"

`);
    }

    if (topic === 'all' || topic === 'privacy') {
      w(`  ── Datenschutz & Privacy ─────────────────────────────────────────────

  Alle Daten bleiben lokal. Keine Cloud-Übertragung (außer Claude API
  für SOP-Generierung).

  Consent (Zustimmung):
    shadowing consent                 Status anzeigen
    shadowing consent --grant all     Zustimmung für alles erteilen
    shadowing consent --revoke shell  Shell-Erfassung widerrufen
    shadowing consent --log           Audit-Trail anzeigen

  Ausschlussregeln (was NICHT erfasst wird):
    shadowing exclude                         Regeln anzeigen
    shadowing exclude --defaults              Standardregeln laden
                                              (Passwort-Manager, Banking, etc.)
    shadowing exclude --add "1Password" --type app
    shadowing exclude --add "*banking*" --type title_pattern
    shadowing exclude --add "*.env*" --type path_pattern
    shadowing exclude --remove <id>

  Daten-Lebenszyklus:
    0-7 Tage:    Volle Details (Fenstertitel, Befehle, Pfade)
    7-30 Tage:   Nur App-Namen + Dauer (Details gelöscht)
    >90 Tage:    Daten komplett gelöscht

`);
    }

    if (topic === 'all' || topic === 'api') {
      w(`  ── Web-Dashboard & API ──────────────────────────────────────────────

    shadowing ui               Dashboard starten (default: Port 3847)
    shadowing ui --port 8080   Anderen Port verwenden

  REST-API-Endpunkte:
    GET  /api/stats             Globale Statistiken
    GET  /api/tasks             Task-Liste (?status=active)
    GET  /api/tasks/active      Aktiver Task
    GET  /api/sops              SOP-Liste (?status=, ?tag=, ?search=)
    GET  /api/sops/:id          SOP-Detail mit Metriken + Versionen
    PUT  /api/sops/:id/status   Status ändern
    GET  /api/sops/:id/diff     Diff zur Vorgängerversion
    GET  /api/tags              Alle Tags
    GET  /api/exports           Export-Historie

`);
    }

    if (topic === 'all' || topic === 'claude-code') {
      w(`  ── Claude Code Integration ──────────────────────────────────────────

  Shadowing integriert sich nahtlos mit Claude Code über zwei Mechanismen:

  1. MCP-Server (Model Context Protocol)
     Claude Code kann Shadowing-Tools direkt aufrufen:

     Verfügbare MCP-Tools (17):
       shadowing_start_task       Task starten
       shadowing_complete_task    Task abschließen (SOP generieren)
       shadowing_pause_task       Task pausieren
       shadowing_resume_task      Task fortsetzen
       shadowing_get_status       Status abfragen
       shadowing_list_sops        SOPs auflisten
       shadowing_get_sop          SOP-Detail abrufen
       shadowing_update_sop       SOP bearbeiten
       shadowing_approve_sop      SOP genehmigen
       shadowing_add_tags         Tags hinzufügen
       shadowing_log_observation  Aktion erfassen
       shadowing_start_observation  Session starten
       shadowing_stop_observation   Session beenden
       shadowing_get_stats        Statistiken
       shadowing_export_sops      SOPs exportieren
       shadowing_list_tasks       Tasks auflisten
       shadowing_get_timeline     Timeline abrufen

  2. Hooks (automatische Erfassung)
     Claude Code Hooks loggen Tool-Aufrufe automatisch:
       PostToolUse → Jeder Tool-Aufruf wird als ObservedAction erfasst
       Stop        → Session-Ende wird protokolliert

  Einrichtung:
    shadowing setup-hooks              Alles automatisch konfigurieren
    shadowing setup-hooks --project-dir /pfad/zum/projekt

  Manuell starten:
    shadowing mcp                      MCP-Server starten (stdio)

  Die Konfiguration wird in .claude/settings.json gespeichert.

`);
    }

    if (topic === 'all') {
      w(`  ── Weitere Befehle ──────────────────────────────────────────────────

    shadowing infra [dir]      Infrastruktur-Kontext extrahieren
                               (package.json, docker-compose, .env, Makefile)
    shadowing import-graph <p> Cartography-Graph importieren (JSON)
    shadowing config           Konfiguration im Editor öffnen
    shadowing reset            Alle Daten löschen (mit Bestätigung)

  ── Hilfe zu einzelnen Themen ────────────────────────────────────────

    shadowing guide --topic quickstart   Schnellstart
    shadowing guide --topic tasks        Manueller Task-Modus
    shadowing guide --topic observe      Automatischer Beobachtungsmodus
    shadowing guide --topic sops         SOP-Verwaltung
    shadowing guide --topic export       Export & Anonymisierung
    shadowing guide --topic privacy      Datenschutz & Consent
    shadowing guide --topic api          Web-Dashboard & REST-API
    shadowing guide --topic claude-code  Claude Code Integration

`);
    }
  });

// ── shadowing mcp ───────────────────────────────────────────────────────────

program
  .command('mcp')
  .description('MCP-Server starten (stdio-Transport für Claude Code)')
  .action(() => {
    startMCPServer();
  });

// ── shadowing hook ──────────────────────────────────────────────────────────

program
  .command('hook')
  .description('Claude Code Hook-Events verarbeiten (intern)')
  .option('--event <type>', 'Event-Typ (PostToolUse, Stop, SessionStart)')
  .action(async (opts: { event?: string }) => {
    await runHookHandler(opts.event);
  });

// ── shadowing setup-hooks ───────────────────────────────────────────────────

program
  .command('setup-hooks')
  .description('Claude Code Hooks + MCP-Server konfigurieren')
  .option('--project-dir <path>', 'Projektverzeichnis (default: cwd)')
  .action((opts: { projectDir?: string }) => {
    const projectDir = opts.projectDir ?? process.cwd();
    const claudeDir = join(projectDir, '.claude');
    const settingsPath = join(claudeDir, 'settings.json');

    // Read existing settings
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      } catch {
        settings = {};
      }
    } else {
      mkdirSync(claudeDir, { recursive: true });
    }

    // Add hooks configuration
    const hooks: Record<string, unknown[]> = (settings['hooks'] as Record<string, unknown[]>) ?? {};

    const hookCommand = 'npx shadowing hook';

    // PostToolUse hook — captures all tool usage
    if (!hooks['PostToolUse']) hooks['PostToolUse'] = [];
    const postToolHooks = hooks['PostToolUse'] as Array<{ matcher?: string; command?: string }>;
    if (!postToolHooks.some(h => h.command?.includes('shadowing hook'))) {
      postToolHooks.push({
        matcher: '*',
        command: hookCommand,
      });
    }

    // Stop hook — marks session end
    if (!hooks['Stop']) hooks['Stop'] = [];
    const stopHooks = hooks['Stop'] as Array<{ matcher?: string; command?: string }>;
    if (!stopHooks.some(h => h.command?.includes('shadowing hook'))) {
      stopHooks.push({
        matcher: '',
        command: `${hookCommand} --event stop`,
      });
    }

    settings['hooks'] = hooks;

    // Add MCP server configuration
    const mcpServers: Record<string, unknown> = (settings['mcpServers'] as Record<string, unknown>) ?? {};
    mcpServers['shadowing'] = {
      command: 'npx',
      args: ['shadowing', 'mcp'],
      type: 'stdio',
    };
    settings['mcpServers'] = mcpServers;

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');

    process.stderr.write(`\nClaude Code Integration konfiguriert.\n\n`);
    process.stderr.write(`  Hooks:\n`);
    process.stderr.write(`    PostToolUse → shadowing hook (alle Tool-Aufrufe loggen)\n`);
    process.stderr.write(`    Stop        → shadowing hook --event stop (Session beenden)\n\n`);
    process.stderr.write(`  MCP-Server:\n`);
    process.stderr.write(`    shadowing   → npx shadowing mcp (17 Shadowing-Tools)\n\n`);
    process.stderr.write(`  Konfigurationsdatei: ${settingsPath}\n\n`);
    process.stderr.write(`  Claude Code kann jetzt:\n`);
    process.stderr.write(`    - Tasks starten/beenden via MCP-Tools\n`);
    process.stderr.write(`    - SOPs lesen, bearbeiten und exportieren\n`);
    process.stderr.write(`    - Workflow-Aktionen automatisch erfassen\n`);
    process.stderr.write(`    - Observation-Sessions verwalten\n\n`);
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
    process.stderr.write(`  Mehrere SOPs gefunden für "${idPrefix}". Bitte genauere ID angeben.\n`);
    return null;
  }

  process.stderr.write(`  SOP nicht gefunden: ${idPrefix}\n`);
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
      process.stderr.write('  SOP aktualisiert (neue Version).\n');
    } else {
      process.stderr.write('  Keine Änderungen.\n');
    }
  } catch {
    process.stderr.write(`  Editor konnte nicht gestartet werden: ${editor}\n`);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ok */ }
  }
}

program.parse();
