# Implementierungsplan — @datasynx/agentic-ai-shadowing v0.1.0

## Analyse: Ist-Zustand vs. Soll-Zustand

### Grundlegende Erkenntnis
Das aktuelle Repo enthält den **alten Shadow-Daemon** aus `@datasynx/agentic-ai-cartography` —
ein System-Monitoring-Tool (TCP-Snapshots, Prozesse, IPC-Daemon). Die neue Spezifikation beschreibt
ein **fundamental anderes Produkt**: ein interaktives, Mitarbeiter-gesteuertes Task-Tracking-Tool
mit SOP-Generierung, HTML-Frontend und Export-Engine.

**Konsequenz:** Alle Source-Dateien (`src/*.ts`) werden komplett ersetzt. Behalten werden:
- Build-Infrastruktur: `tsconfig.json`, `tsup.config.ts`, `.gitignore`
- Projekt-Metadaten: `LICENSE`, `CLAUDE.md`
- `package.json` (wird angepasst: neue Dependencies, andere Binaries)

### Alte Dateien → Entscheidung

| Datei | Aktion | Begründung |
|-------|--------|------------|
| `src/daemon.ts` | **Löschen** | Kein Daemon-Konzept in neuer Spec |
| `src/ipc.ts` | **Löschen** | Kein IPC/Unix-Socket nötig |
| `src/client.ts` | **Löschen** | Kein Attach/Foreground-Client |
| `src/notify.ts` | **Löschen** | Keine Desktop-Notifications in MVP |
| `src/agent.ts` | **Löschen** | Komplett andere SOP-Generierung |
| `src/types.ts` | **Löschen** | Komplett neues Typsystem |
| `src/cli.ts` | **Löschen** | Komplett andere CLI-Befehle |
| `src/index.ts` | **Löschen** | Neue Public API |
| `test/ipc.test.ts` | **Löschen** | IPC existiert nicht mehr |
| `docs/SHADOW_SPEC.md` | **Ersetzen** | Durch neue Produktspezifikation |

---

## Implementierungsschritte (Phase 1 — MVP)

### Schritt 1: Projekt-Restrukturierung
**Ziel:** Alte Dateien entfernen, Dependencies anpassen, neue Verzeichnisstruktur anlegen.

**1.1 Alte Source-Dateien löschen:**
- Alle `src/*.ts` löschen
- `test/ipc.test.ts` löschen

**1.2 `package.json` anpassen:**
- Binary `datasynx-shadow` → `shadowing`
- `node-notifier` entfernen (nicht im MVP)
- `@anthropic-ai/claude-code` entfernen (direkt `@anthropic-ai/sdk` nutzen)
- `@inquirer/prompts` hinzufügen (interaktive Terminal-Prompts)
- `express` hinzufügen (REST-API für Frontend, Phase 2 vorbereiten)
- `marked` + `dompurify` noch NICHT (Phase 2)
- `engines.node` auf `>=20` setzen
- Peer-Dependency auf `@datasynx/agentic-ai-cartography` entfernen (optional in neuer Spec)

**1.3 `CLAUDE.md` aktualisieren** mit neuer Projektbeschreibung

**1.4 `docs/SHADOW_SPEC.md`** durch neue Produktspezifikation ersetzen

**1.5 `docs/tasks.md`** mit neuer Task-Liste ersetzen

**1.6 Neue Verzeichnisstruktur:**
```
src/
├── cli.ts              # Commander CLI (Haupteintrag)
├── index.ts            # Public API
├── db.ts               # SQLite-Schema + Datenbank-Klasse
├── types.ts            # Alle TypeScript-Typen
├── config.ts           # Config-Management (~/.datasynx/shadowing/config.json)
├── task-manager.ts     # Task-Lifecycle (start, pause, complete, cancel)
├── sop-generator.ts    # Claude SDK SOP-Generierung
├── metrics.ts          # Metriken-Berechnung (Scores)
├── anonymizer.ts       # PII-Erkennung und -Redaktion
├── exporter.ts         # Markdown-Export mit Manifest
└── ui-server.ts        # Express REST-Server + HTML-Frontend (Phase 2 Vorbereitung)
test/
├── db.test.ts
├── task-manager.test.ts
├── sop-generator.test.ts
├── metrics.test.ts
├── anonymizer.test.ts
└── exporter.test.ts
```

**1.7 Build verifizieren:** `npm install && npm run lint && npm run build`

---

### Schritt 2: `src/types.ts` — Typsystem
**Ziel:** Alle Interfaces und Zod-Schemas aus der DB-Spec (Sektion 4) definieren.

**Definieren:**
- `Task` interface (id, title, description, status, started_at, completed_at, duration_seconds, created_at, updated_at)
- `TaskStatus` type: `'active' | 'paused' | 'completed' | 'cancelled'`
- `SOP` interface (id, task_id, title, description, content_md, version, status, ai_generated, reviewed_at, exported_at, created_at, updated_at)
- `SOPStatus` type: `'draft' | 'reviewed' | 'approved' | 'exported' | 'archived'`
- `Tag` interface (id, name)
- `SOPTag` interface (sop_id, tag_id, ai_generated)
- `TaskExecution` interface (id, sop_id, duration_seconds, complexity_rating, notes, executed_at)
- `ExportRecord` interface (id, exported_at, sop_count, export_path, anonymized)
- `ShadowingConfig` interface (aus Sektion 10.1)
- `SOPMetrics` interface (execution_count, avg_duration, median_duration, min_duration, max_duration, std_deviation, cv, avg_complexity, consistency_score, maturity_score, freshness_score)
- `GlobalStats` interface

---

### Schritt 3: `src/config.ts` — Konfigurationsmanagement
**Ziel:** `~/.datasynx/shadowing/config.json` lesen/schreiben mit Defaults.

**Funktionen:**
- `getConfigDir(): string` → `~/.datasynx/shadowing/`
- `getDefaultConfig(): ShadowingConfig` → Defaults aus Spec Sektion 10.1
- `loadConfig(): ShadowingConfig` → liest config.json oder erstellt mit Defaults
- `saveConfig(config: ShadowingConfig): void`
- `getDbPath(): string` → `~/.datasynx/shadowing/shadowing.db`

**Defaults:**
- `polling_interval_minutes: 15`
- `editor: "code"` (VS Code)
- `ui_port: 3847`
- `sop_generation.model: "claude-sonnet-4-20250514"`
- `sop_generation.temperature: 0.3`
- `sop_generation.sop_language: "de"`
- `anonymization.*`: alle true

---

### Schritt 4: `src/db.ts` — SQLite-Datenbank
**Ziel:** better-sqlite3 Wrapper mit dem Schema aus Sektion 4.1.

**Klasse: `ShadowingDB`**

**Schema-Migration (in `initialize()`):**
- `tasks` Tabelle
- `sops` Tabelle
- `tags` Tabelle
- `sop_tags` Tabelle
- `task_executions` Tabelle
- `exports` Tabelle
- `export_sops` Tabelle
- Alle Indizes

**Methoden — Tasks:**
- `createTask(title: string, description?: string): Task`
- `getTask(id: string): Task | null`
- `getActiveTask(): Task | null`
- `listTasks(filter?: { status?: TaskStatus }): Task[]`
- `updateTask(id: string, updates: Partial<Task>): Task`
- `completeTask(id: string): Task` — setzt status, completed_at, berechnet duration_seconds
- `pauseTask(id: string): Task`
- `resumeTask(id: string): Task`
- `cancelTask(id: string): Task`
- `deleteTask(id: string): void`

**Methoden — SOPs:**
- `createSOP(taskId: string, data: { title, description, content_md, tags?: string[] }): SOP`
- `getSOP(id: string): SOP | null`
- `listSOPs(filter?: { status?, tag?, search? }): SOP[]`
- `updateSOP(id: string, updates: Partial<SOP>): SOP` — inkrementiert version bei content_md-Änderung
- `updateSOPStatus(id: string, status: SOPStatus): SOP`
- `deleteSOP(id: string): void`

**Methoden — Tags:**
- `getOrCreateTag(name: string): Tag`
- `addTagToSOP(sopId: string, tagName: string, aiGenerated?: boolean): void`
- `removeTagFromSOP(sopId: string, tagId: string): void`
- `listTags(): Tag[]`
- `getTagsForSOP(sopId: string): (Tag & { ai_generated: boolean })[]`

**Methoden — Executions:**
- `logExecution(sopId: string, data: { duration_seconds, complexity_rating?, notes? }): TaskExecution`
- `getExecutions(sopId: string): TaskExecution[]`

**Methoden — Exports:**
- `logExport(data: { sop_count, export_path, sop_ids: string[] }): ExportRecord`
- `getExports(): ExportRecord[]`

**Methoden — Stats:**
- `getGlobalStats(): GlobalStats`

**Tests:** `test/db.test.ts`
- Tabellen-Erstellung
- CRUD für Tasks, SOPs, Tags
- Task-Lifecycle (active → paused → active → completed)
- SOP-Versionierung
- Tag-Zuordnung
- Execution-Logging

---

### Schritt 5: `src/task-manager.ts` — Task-Lifecycle
**Ziel:** Orchestriert Task-Lifecycle und interaktive Prompts.

**Klasse: `TaskManager`**

Benötigt: `ShadowingDB`, `ShadowingConfig`

**Methoden:**
- `startTask(title: string, description?: string): Task` — prüft ob bereits ein aktiver Task existiert
- `pauseTask(): Task` — pausiert den aktiven Task
- `resumeTask(): Task` — nimmt pausierten Task wieder auf
- `completeTask(complexityRating?: number): { task: Task; duration: string }` — beendet Task, formatiert Dauer
- `cancelTask(): Task`
- `getActiveTask(): Task | null`
- `addNote(note: string): void` — speichert Notiz zum aktiven Task (in description anhängen)

**Hilfsfunktionen:**
- `formatDuration(seconds: number): string` — "1h 23min 45s"

**Tests:** `test/task-manager.test.ts`
- Start/Complete-Flow
- Pause/Resume
- Fehler wenn kein aktiver Task
- Fehler bei doppeltem Start

---

### Schritt 6: `src/sop-generator.ts` — Claude SOP-Generierung
**Ziel:** Generiert SOPs via Anthropic Messages API basierend auf Task-Daten.

**Klasse: `SOPGenerator`**

Benötigt: `ShadowingConfig`, `ShadowingDB`

**Methoden:**
- `generateSOP(task: Task, notes?: string[]): Promise<{ title, description, content_md, tags }>` — System-Prompt aus Spec Sektion 6.1, Cartography-Graph als optionaler Kontext
- `regenerateSOP(sopId: string): Promise<SOP>` — SOP neu generieren aus Task-Daten

**Prompt-Aufbau:**
- System-Prompt definiert Rolle, Regeln, Markdown-Struktur (Sektion 4.2)
- User-Prompt enthält: Task-Titel, Beschreibung, Dauer, Notizen, Komplexität, optional Cartography-Graph
- Response-Parsing: Markdown-Content + Tags-Array aus structured output

**KI-Tag-Generierung:**
- Aus dem generierten Content Tags extrahieren
- Kategorien: Abteilung, Tool/System, Prozessart, Frequenz, Komplexität (Sektion 6.2)

**Tests:** `test/sop-generator.test.ts`
- Prompt-Aufbau testen (ohne API-Call)
- Response-Parsing testen (Mock-Response)
- Tag-Extraktion

---

### Schritt 7: `src/metrics.ts` — Metriken-Berechnung
**Ziel:** Qualitäts-Scores aus Execution-Daten berechnen (Sektion 7).

**Funktionen:**
- `calculateSOPMetrics(db: ShadowingDB, sopId: string): SOPMetrics`
  - Ausführungsstatistik: count, avg, median, min, max, stddev, CV
  - avg_complexity aus task_executions
- `calculateConsistencyScore(cv: number): number` — `max(0, 100 - (cv * 2))`
- `calculateMaturityScore(sop: SOP, executionCount: number, hasReview: boolean, revisionCount: number, hasTags: boolean, hasDescription: boolean): number` — gewichteter Score
- `calculateFreshnessScore(sop: SOP, avgFrequencyDays: number): number` — Aktualität basierend auf Review-Alter und Frequenz
- `calculateOverallQualityScore(consistency, maturity, freshness, weights): number`

**Tests:** `test/metrics.test.ts`
- Konsistenz-Score bei verschiedenen CVs
- Reife-Score bei verschiedenen Kombinationen
- Aktualitäts-Score
- Edge Cases (0 Ausführungen, keine Reviews)

---

### Schritt 8: `src/anonymizer.ts` — PII-Erkennung und -Redaktion
**Ziel:** Export-Anonymisierung gemäß Sektion 9.2.

**Klasse: `Anonymizer`**

Benötigt: `ShadowingConfig.anonymization`

**Methoden:**
- `anonymize(text: string): string` — wendet alle Regeln an
- Private Methoden:
  - `redactEmails(text: string): string` — `[email@example.com]`
  - `redactIPs(text: string): string` — `[interne-ip]`
  - `redactURLs(text: string): string` — Domain generalisieren
  - `redactPhoneNumbers(text: string): string` — `[Telefonnummer]`
  - `redactFilePaths(text: string): string` — `/Users/[user]/...`
  - `applyCustomReplacements(text: string): string` — aus config

**Regex-Patterns:**
- E-Mail: `/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g`
- IP: `/\b(?:\d{1,3}\.){3}\d{1,3}\b/g`
- URL: `/https?:\/\/[^\s)]+/g`
- Telefon: `/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g`
- Dateipfade: `/(?:\/Users\/|\/home\/|C:\\Users\\)[^\s"')]+/g`

**Tests:** `test/anonymizer.test.ts`
- Jeder PII-Typ einzeln
- Custom Replacements
- Text ohne PII bleibt unverändert
- Markdown-Struktur bleibt intakt

---

### Schritt 9: `src/exporter.ts` — Markdown-Export
**Ziel:** Anonymisierter Export als Markdown-Dateien + manifest.json (Sektion 9.1).

**Klasse: `Exporter`**

Benötigt: `ShadowingDB`, `Anonymizer`, `ShadowingConfig`

**Methoden:**
- `exportSOPs(sopIds: string[]): ExportResult` — Erzeugt Export-Verzeichnis
  1. Verzeichnis anlegen: `~/.datasynx/shadowing/exports/export_YYYY-MM-DD_HH-mm/`
  2. Für jede SOP: Anonymisieren → `sops/sop_NNN.md` schreiben
  3. Metriken pro SOP berechnen
  4. `manifest.json` schreiben (Format aus Sektion 9.1)
  5. Export in DB loggen
  6. Pfad zurückgeben
- `exportAll(): ExportResult` — alle SOPs mit status='approved'
- `getExportHistory(): ExportRecord[]`

**Tests:** `test/exporter.test.ts`
- Export-Verzeichnis-Struktur
- manifest.json Format
- Anonymisierung wird angewendet
- Export-Logging in DB

---

### Schritt 10: `src/cli.ts` — Commander CLI
**Ziel:** Alle CLI-Befehle aus Sektion 5.4 implementieren.

**Binary:** `shadowing` (in package.json `bin`)

**Befehle:**

**`shadowing init`**
- Config-Verzeichnis anlegen
- DB initialisieren
- config.json mit Defaults erstellen
- Erfolgsmeldung

**`shadowing start`** (interaktiver Task-Loop)
- Prüft ob DB initialisiert
- Fragt: "Startest du einen neuen Task?"
- Bei Ja: Titel + optionale Beschreibung erfragen
- Loop: Alle `config.polling_interval_minutes` Minuten fragen: "Bist du noch beim gleichen Task?"
- Optionen: [1] Task abschließen → SOP generieren, [2] Pausieren, [3] Abbrechen, [4] Notiz, [5] Neuer Task
- Bei Abschluss: Komplexität (1-5) erfragen → SOP generieren → Review-Optionen anzeigen

**`shadowing status`**
- Aktuellen Task anzeigen (falls aktiv)
- Statistiken: Anzahl Tasks, SOPs, letzte Aktivität

**`shadowing list`**
- SOPs als Tabelle: ID (kurz), Titel, Status, Tags, Datum
- Optionen: `--status <status>`, `--tag <tag>`, `--search <query>`

**`shadowing show <sop-id>`**
- SOP-Markdown im Terminal rendern (content_md ausgeben)
- Metadaten: Tags, Version, Status, Metriken

**`shadowing edit <sop-id>`**
- SOP in temporäre Datei schreiben
- Standard-Editor öffnen (`$EDITOR` oder config.editor)
- Nach Schließen: Änderungen in DB speichern, Version inkrementieren

**`shadowing delete <sop-id>`**
- Bestätigungsabfrage
- SOP löschen (CASCADE löscht tags, executions)

**`shadowing tag <sop-id> <tags...>`**
- Tags hinzufügen (mit `+tag`) oder entfernen (mit `-tag`)

**`shadowing stats`**
- Globale Statistiken im Terminal
- Top-5 häufigste Tasks
- Qualitäts-Score-Übersicht

**`shadowing export`**
- Interaktiv: SOPs zur Auswahl anzeigen (Checkbox)
- Vorschau der Anonymisierung
- Bestätigung → Export

**`shadowing export --all`**
- Alle approved SOPs exportieren

**`shadowing import-graph <path>`**
- Cartography-Graph (JSON) importieren und in config speichern

**`shadowing config`**
- Config im Editor öffnen

**`shadowing reset`**
- Bestätigungsabfrage ("Bist du sicher? Alle Daten werden gelöscht.")
- DB + config löschen

---

### Schritt 11: `src/index.ts` — Public API
**Ziel:** Saubere Re-Exports für programmatische Nutzung.

**Exports:**
- `ShadowingDB`
- `TaskManager`
- `SOPGenerator`
- `Anonymizer`
- `Exporter`
- Alle Types
- `loadConfig`, `getDefaultConfig`
- Metriken-Funktionen

---

### Schritt 12: `tsup.config.ts` anpassen
**Ziel:** CLI-Binary + Library-Entry korrekt konfigurieren.

- CLI entry: `src/cli.ts` → `dist/cli.js` (mit shebang)
- Library entry: `src/index.ts` → `dist/index.js` + `dist/index.d.ts`

---

### Schritt 13: Build, Lint, Test, Smoke-Test
**Ziel:** Alles baut, alle Tests grün, CLI funktioniert.

- `npm run lint` — TypeScript ohne Fehler
- `npm run test` — alle Tests grün
- `npm run build` — dist/ korrekt
- `npx tsx src/cli.ts init` → DB wird erstellt
- `npx tsx src/cli.ts status` → zeigt "Kein aktiver Task"
- `npx tsx src/cli.ts list` → zeigt leere Liste

---

### Schritt 14: Dokumentation aktualisieren
**Ziel:** README.md, CLAUDE.md, docs/ aktuell.

- `README.md` — neue Projektbeschreibung, Installation, CLI-Befehle
- `CLAUDE.md` — neue Coding-Rules, Commands
- `docs/tasks.md` — Task-Liste aktualisieren (Phase 1 als erledigt markieren)
- `docs/PRODUCT_SPEC.md` — Produktspezifikation ablegen

---

### Schritt 15: Commit & Push
- Sauberer Commit mit allen Änderungen
- Push auf den Feature-Branch

---

## Abhängigkeitsgraph der Schritte

```
Schritt 1 (Restrukturierung)
    │
    ├── Schritt 2 (types.ts) ──────────────┐
    │                                       │
    ├── Schritt 3 (config.ts) ─────────────┤
    │                                       │
    └── Schritt 4 (db.ts) ◄────────────────┤
         │                                  │
         ├── Schritt 5 (task-manager.ts) ◄──┘
         │        │
         │        └── Schritt 6 (sop-generator.ts)
         │
         ├── Schritt 7 (metrics.ts)
         │
         ├── Schritt 8 (anonymizer.ts)
         │        │
         │        └── Schritt 9 (exporter.ts)
         │
         └─── Alle ──► Schritt 10 (cli.ts)
                           │
                           ├── Schritt 11 (index.ts)
                           ├── Schritt 12 (tsup.config.ts)
                           ├── Schritt 13 (Build/Test)
                           ├── Schritt 14 (Docs)
                           └── Schritt 15 (Commit/Push)
```

## Geschätzte Dateien & Umfang

| Datei | ~LOC | Komplexität |
|-------|------|-------------|
| `src/types.ts` | 120 | Niedrig |
| `src/config.ts` | 80 | Niedrig |
| `src/db.ts` | 350 | Mittel |
| `src/task-manager.ts` | 100 | Niedrig |
| `src/sop-generator.ts` | 150 | Mittel |
| `src/metrics.ts` | 120 | Mittel |
| `src/anonymizer.ts` | 100 | Niedrig |
| `src/exporter.ts` | 120 | Niedrig |
| `src/cli.ts` | 350 | Hoch |
| `src/index.ts` | 30 | Niedrig |
| Tests (gesamt) | 400 | Mittel |
| **Gesamt** | **~1920** | |

## Nicht im Scope (Phase 2+)

- HTML-Frontend + REST-API-Server (`shadowing ui`)
- SOP-Editor mit Markdown-Preview im Browser
- Versionshistorie / Diff-Ansicht
- Heatmap / Trend-Charts
- NER-basierte Anonymisierung
- Cartography-Graph-Kontext-Nutzung (wird vorbereitet aber nicht voll implementiert)
- `shadowing config` (Config-Editor) — wird als Stub implementiert
