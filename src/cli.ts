import { Command } from 'commander';
import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { ShadowingDB } from './db.js';
import { TaskManager, formatDuration } from './task-manager.js';
import { SOPGenerator, buildSOPPreview, countSteps } from './sop-generator.js';
import { Anonymizer } from './anonymizer.js';
import { Exporter } from './exporter.js';
import { calculateSOPMetrics } from './metrics.js';
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

// ── shadowing init ───────────────────────────────────────────────────────────

program
  .command('init')
  .description('Erstmalige Einrichtung (DB + Config anlegen)')
  .action(() => {
    ensureConfigDir();

    const dbPath = getDbPath();
    const configPath = getConfigPath();

    const db = new ShadowingDB(dbPath);
    db.initialize();
    db.close();

    if (!existsSync(configPath)) {
      saveConfig(loadConfig());
    }

    process.stderr.write(`Shadowing initialisiert.\n`);
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
    try { db = openDB(); } catch { return; }

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
            process.stderr.write(`  Fehler bei SOP-Generierung: ${err}\n`);
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
    try { db = openDB(); } catch { return; }

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
    try { db = openDB(); } catch { return; }

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
    try { db = openDB(); } catch { return; }

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
  .description('SOP unwiderruflich löschen')
  .action(async (sopId: string) => {
    let db: ShadowingDB;
    try { db = openDB(); } catch { return; }

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

// ── shadowing tag ────────────────────────────────────────────────────────────

program
  .command('tag <sop-id> <tags...>')
  .description('Tags hinzufügen (+tag) oder entfernen (-tag)')
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
    try { db = openDB(); } catch { return; }

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
    try { db = openDB(); } catch { return; }

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

// ── shadowing import-graph ───────────────────────────────────────────────────

program
  .command('import-graph <path>')
  .description('Cartography-Graph importieren')
  .action((path: string) => {
    if (!existsSync(path)) {
      process.stderr.write(`  Datei nicht gefunden: ${path}\n`);
      process.exitCode = 1;
      return;
    }

    const config = loadConfig();
    config.cartography_graph_path = path;
    saveConfig(config);
    process.stderr.write(`  Cartography-Graph importiert: ${path}\n`);
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
  writeFileSync(tmpFile, sop.content_md, 'utf8');

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
