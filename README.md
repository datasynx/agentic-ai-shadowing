<div align="center">

# 👁️ Datasynx Shadowing

**AI-powered Workflow Observation & SOP Generation**

[![npm version](https://img.shields.io/npm/v/@datasynx/agentic-ai-shadowing?style=flat-square&color=CB3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/@datasynx/agentic-ai-shadowing)
[![npm downloads](https://img.shields.io/npm/dm/@datasynx/agentic-ai-shadowing?style=flat-square&color=CB3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/@datasynx/agentic-ai-shadowing)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Node.js ≥20](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Built with Claude](https://img.shields.io/badge/Built_with-Claude_API-D4A017?style=flat-square&logo=anthropic&logoColor=white)](https://docs.anthropic.com)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-Datasynx_AI-0077B5?style=flat-square&logo=linkedin&logoColor=white)](https://www.linkedin.com/company/datasynx-ai/)
[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20macOS%20%7C%20Windows-blue?style=flat-square)](https://github.com/datasynx-ai/agentic-ai-shadowing)
[![Tests](https://img.shields.io/badge/Tests-373%20passed-3fb950?style=flat-square&logo=vitest&logoColor=white)](https://github.com/datasynx-ai/agentic-ai-shadowing)

<br/>

*Shadowing beobachtet wie ein Schatten die täglichen Arbeitsabläufe — Shell-Commands, aktive Fenster, Git-Commits — und generiert daraus automatisch Standard Operating Procedures (SOPs) via Claude. Vollständig lokal, vollständig anonymisiert.*

<br/>

**[📦 npm](https://www.npmjs.com/package/@datasynx/agentic-ai-shadowing) · [💼 LinkedIn](https://www.linkedin.com/company/datasynx-ai/) · [🐛 Issues](https://github.com/datasynx-ai/agentic-ai-shadowing/issues)**

</div>

---

## Requires Cartography

Shadowing nutzt die Infrastruktur-Daten aus **Datasynx Cartography** als Kontext für die SOP-Generierung — Systemlandschaft, Services und Abhängigkeiten fließen automatisch in die generierten SOPs ein.

[![Cartography](https://img.shields.io/badge/Requires-@datasynx%2Fagentic--ai--cartography-0077B5?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/@datasynx/agentic-ai-cartography)

```bash
# Cartography installieren (empfohlen)
npm install -g @datasynx/agentic-ai-cartography

# Infrastructure-Scan durchführen → erzeugt den Graph
datasynx-cartography discover

# Graph in Shadowing importieren
shadowing import-graph ./datasynx-output/cartography-graph.jgf.json
```

> **Hinweis:** Shadowing funktioniert auch ohne Cartography — die SOPs werden dann ohne Systemlandschaft-Kontext generiert.

---

## What it does

```
$ shadowing start

  Agentic AI Shadowing — Active

? Neuen Task starten? Yes
? Task-Titel: Monatsabschluss SAP
? Kurze Beschreibung: Monatliche Abschlussarbeiten in SAP FI

  Task gestartet: "Monatsabschluss SAP" (ID: a3f8c210)

? Was möchtest du tun?
  ❯ Task abschließen → SOP generieren
    Task pausieren
    Notiz zum aktuellen Schritt hinzufügen
    Shadowing beenden

? Wie komplex war dieser Task? 3 - Mittel

  Task abgeschlossen. Dauer: 1h 23min 45s
  SOP wird generiert...

  SOP generiert!
  ┌────────────────────────────────────────────────┐
  │  Monatsabschluss SAP — Standard Operating      │
  │  Procedure                                     │
  │  Tags: #buchhaltung #sap #monatlich            │
  │  Schritte: 8                                   │
  └────────────────────────────────────────────────┘
```

```
$ shadowing observe --auto-sop

  Beobachtung gestartet (Session: b7e2f4a1)
  Quellen: Fenster · Shell-History · Git
  Auto-SOP: aktiviert

  [14:23:01] 🖥  VS Code — src/api/routes.ts
  [14:23:45] 💻  git diff src/api/routes.ts
  [14:24:12] 💻  npm run test
  [14:31:00] 🖥  Chrome — Jira Board
  [14:35:22] 💻  git commit -m "fix: validate input"
  [14:35:30] 💻  git push origin feature/validation

  Beobachtung beendet. 2 Tasks erkannt → 2 SOPs generiert.
```

---

## Features

| Feature | Details |
|---------|---------|
| **Automatische Beobachtung** | Shell-History, aktive Fenster, Git-Commits und Dateiänderungen — cross-platform |
| **KI-SOP-Generierung** | Claude generiert strukturierte SOPs mit Ziel, Voraussetzungen, Schritten, erwarteten Ergebnissen |
| **Enterprise Dashboard** | Dark-Theme Web-Dashboard mit SOP-Editor, Metriken, Diff-Viewer, Export-Workflow |
| **Qualitäts-Metriken** | Konsistenz-, Reife-, Aktualitäts- und Gesamt-Score pro SOP |
| **PII-Anonymisierung** | E-Mail, IP, URL, Telefon, Dateipfade, IBAN, Kreditkarten, Steuer-ID, SV-Nummer |
| **Versionshistorie** | Jede SOP-Änderung versioniert mit Diff-Ansicht |
| **Claude Code Integration** | MCP-Server (17 Tools) + Hook-Handler für nahtlose IDE-Integration |
| **Cartography-Kontext** | Systemlandschaft aus [@datasynx/agentic-ai-cartography](https://github.com/datasynx/agentic-ai-cartography) fließt in SOP-Generierung |
| **Privacy First** | Consent-Management, Ausschlussregeln, konfigurierbare Anonymisierung |
| **100% Lokal** | SQLite-DB, kein Cloud-Sync, kein Daemon — der Mitarbeiter kontrolliert alles |

---

## Cross-Platform Support

Shadowing erkennt Fenster und Shell-History nativ auf **Linux**, **macOS** und **Windows**.

| Capability | Linux | macOS | Windows |
|---|---|---|---|
| **Fenster-Erkennung** | `xdotool` (X11) | `osascript` (AppleScript) | PowerShell P/Invoke (`user32.dll`) |
| **Shell-History** | Zsh extended, Bash timestamps | Zsh extended, Bash timestamps | PSReadLine ConsoleHost_history |
| **Git-Tracking** | `git log` | `git log` | `git log` |
| **File-Watching** | `fs.stat` | `fs.stat` | `fs.stat` |
| **Shell-Erkennung** | `$SHELL` | `$SHELL` | `$MSYSTEM` / PowerShell fallback |

### Shell-History-Parser

| Shell | Format | Timestamps |
|-------|--------|-----------|
| **Zsh** | Extended (`: timestamp:duration;command`) | Exakt |
| **Bash** | `#timestamp` + Kommandozeilen | Exakt |
| **Fish** | YAML-artig (`- cmd:` / `when:`) | Exakt |
| **PowerShell** | PSReadLine `ConsoleHost_history.txt` | Lesezeit |

---

## Requirements

- **Node.js >= 20** (Linux, macOS, or Windows)
- **`ANTHROPIC_API_KEY`** environment variable (for SOP generation)
- **[@datasynx/agentic-ai-cartography](https://github.com/datasynx/agentic-ai-cartography)** (recommended, for infrastructure context)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

---

## Install

```bash
npm install -g @datasynx/agentic-ai-shadowing
```

[![npm](https://img.shields.io/badge/npm-@datasynx%2Fagentic--ai--shadowing-CB3837?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/@datasynx/agentic-ai-shadowing)

---

## Quick Start

```bash
# 1. Einrichtung (DB + Config anlegen)
shadowing init

# 2. Manueller Modus: Task starten → SOP generieren lassen
shadowing start

# 3. Automatischer Modus: Workflow beobachten → SOPs auto-generieren
shadowing observe --auto-sop

# 4. SOPs anzeigen
shadowing list
shadowing show <sop-id>

# 5. Web-Dashboard starten
shadowing ui

# 6. Anonymisiert exportieren
shadowing export --all
```

---

## Commands

### Task-Management

```
shadowing init                          Erstmalige Einrichtung (DB + Config)
shadowing start                         Interaktiven Shadowing-Modus starten
shadowing status                        Aktuellen Task und Statistiken anzeigen
```

### SOP-Verwaltung

```
shadowing list [options]                SOPs auflisten
  --status <status>                       Filter: draft/reviewed/approved/exported/archived
  --tag <tag>                             Filter: Tag-Name
  --search <query>                        Freitextsuche

shadowing show <sop-id>                 SOP im Terminal anzeigen
shadowing edit <sop-id>                 SOP im Standard-Editor bearbeiten
shadowing delete <sop-id>               SOP unwiderruflich löschen
shadowing history <sop-id>              Versionshistorie anzeigen
shadowing diff <sop-id> [version]       Diff zwischen Versionen
shadowing tag <sop-id> <tags...>        Tags hinzufügen (+tag) / entfernen (-tag)
```

### Automatische Beobachtung

```
shadowing observe [options]             Beobachtungsmodus starten
  --auto-sop                              SOPs automatisch nach Stop generieren
  --no-window                             Ohne Fenster-Erkennung
  --no-shell                              Ohne Shell-History-Tracking

shadowing sessions                      Beobachtungssessions auflisten
shadowing timeline [session-id]         Zeitachse einer Session anzeigen
shadowing analyze [session-id]          Session → Tasks erkennen → SOPs generieren
```

### Metriken & Export

```
shadowing stats                         Metriken-Dashboard im Terminal
shadowing export                        Interaktiver Export-Wizard
shadowing export --all                  Alle approved SOPs exportieren
shadowing ui [--port <n>]               Web-Dashboard starten (default: 3847)
```

### Datenschutz

```
shadowing consent                       Zustimmungsmanagement für Beobachtung
shadowing exclude                       Ausschlussregeln verwalten
```

### Integration

```
shadowing import-graph <path>           Cartography-Graph (JGF) importieren
shadowing infra [dir]                   Infrastruktur-Kontext extrahieren
shadowing mcp                           MCP-Server starten (stdio-Transport)
shadowing setup-hooks                   Claude Code Hooks + MCP konfigurieren
shadowing guide                         Komplette Anleitung
```

---

## Output Files

```
exports/export_2026-02-24T14-30-00/
├── manifest.json                  Metadaten, Tags, Metriken-Übersicht
└── sops/
    ├── sop_001.md                 Anonymisierte SOP (Markdown)
    ├── sop_002.md
    └── ...
```

---

## Enterprise Dashboard

```bash
shadowing ui
# → http://localhost:3847
```

Dark-Theme Single-Page-App mit:

- **Statistik-Kacheln** — Tasks, SOPs, Quality Scores, Exports
- **SOP-Editor** — Split-Pane mit Markdown-Preview
- **Versionshistorie** — Diff-Viewer für jede Änderung
- **Tag-Management** — Inline hinzufügen/entfernen
- **Export-Workflow** — Anonymisierungs-Preview, Batch-Export
- **Timeline** — Farbcodierte Observation-Events
- **17 REST-API Endpoints** — vollständige programmatische Kontrolle

### REST API

| Methode | Pfad | Beschreibung |
|---------|------|-------------|
| GET | `/api/stats` | Globale Statistiken |
| GET | `/api/tasks` | Task-Liste (Filter: `?status=`) |
| GET | `/api/tasks/active` | Aktiver Task |
| GET | `/api/sops` | SOP-Liste (Filter: `?status=`, `?tag=`, `?search=`) |
| GET | `/api/sops/:id` | SOP-Detail mit Metriken + Versionen |
| PUT | `/api/sops/:id` | SOP-Content aktualisieren |
| PUT | `/api/sops/:id/status` | Status ändern (Draft → Reviewed → Approved) |
| PUT | `/api/sops/:id/tags` | Tags hinzufügen/entfernen |
| GET | `/api/sops/:id/diff` | Diff zur Vorgängerversion |
| GET | `/api/sops/:id/preview` | Anonymisierte Vorschau |
| GET | `/api/tags` | Alle Tags |
| GET | `/api/exports` | Export-Historie |
| POST | `/api/exports` | Export auslösen |
| GET | `/api/sessions` | Observation-Sessions |
| GET | `/api/sessions/:id/timeline` | Session-Timeline |
| GET | `/api/sessions/:id/summary` | Session-Zusammenfassung |

---

## Quality Metrics

### Konsistenz-Score

`max(0, 100 - CV * 2)` — basierend auf dem Variationskoeffizienten der Ausführungsdauern.

### Reife-Score (gewichtet)

| Kriterium | Gewicht |
|-----------|---------|
| >= 5 Ausführungen | 30% |
| Review durchgeführt | 30% |
| >= 1 Revision | 20% |
| Tags vorhanden | 10% |
| Beschreibung vorhanden | 10% |

### Aktualitäts-Score

Basierend auf Review-Alter und Ausführungsfrequenz. Häufig ausgeführte SOPs veralten schneller.

### Gesamt-Qualitäts-Score

```
consistency * 0.35 + maturity * 0.35 + freshness * 0.30
```

---

## Privacy & Anonymization

| Pattern | Ersetzung | Konfigurierbar |
|---------|----------|----------------|
| E-Mail-Adressen | `[email@example.com]` | `redact_emails` |
| IPv4/IPv6-Adressen | `[interne-ip]` | `redact_ips` |
| URLs | `[internes-system]/pfad` | `redact_urls` |
| Telefonnummern | `[Telefonnummer]` | `redact_phone_numbers` |
| Dateipfade | `/Users/[user]/...` | `redact_file_paths` |
| **IBAN** | `[IBAN]` | Immer aktiv |
| **Kreditkartennummern** | `[Kreditkartennummer]` | Immer aktiv |
| **Steuer-ID** | `[Steuer-ID]` | Immer aktiv |
| **SV-Nummer** | `[SV-Nummer]` | Immer aktiv |

Custom Replacements über `config.anonymization.custom_replacements`.

---

## Architecture

```
CLI (Commander.js — 27 Commands)
  └── shadowing init / start / observe / list / export / ui / ...
      ├── TaskManager         Task-Lifecycle (start → pause → resume → complete)
      ├── Observer             Heartbeat-basierte Workflow-Erfassung
      │   ├── WindowDetector   xdotool (Linux) / osascript (macOS) / P/Invoke (Win)
      │   ├── ShellHistory     Zsh / Bash / Fish / PowerShell Parser
      │   └── Git + File       Commit-Tracking + Dateiänderungen
      ├── SessionAnalyzer      Silence-Clustering → Task-Erkennung (LLM)
      ├── SOPGenerator         Claude API → strukturierte SOPs + Tags
      ├── Anonymizer           PII-Redaktion (8+ Patterns)
      ├── Exporter             Markdown + manifest.json (atomare Operationen)
      ├── Metrics              Konsistenz · Reife · Aktualität · Qualität
      ├── PrivacyManager       Consent + Ausschlussregeln + Degradation
      └── ShadowingDB          SQLite WAL (11 Tabellen, Constraints, Indices)

  Integrations:
      ├── UIServer             REST-API (17 Endpoints) + HTML Dashboard
      ├── MCPServer            Model Context Protocol (17 Tools, stdio)
      ├── HookHandler          Claude Code Event-Verarbeitung
      └── Cartography          JGF Graph-Import aus agentic-ai-cartography
```

---

## Claude Code Integration

### MCP-Server (17 Tools)

```bash
shadowing mcp
```

Tools: `task_start`, `task_status`, `task_complete`, `task_pause`, `sop_list`, `sop_show`, `sop_generate`, `sop_update_status`, `observe_start`, `observe_stop`, `timeline_show`, `session_analyze`, `export_sops`, `stats_show`, `consent_manage`, `exclude_manage`, `config_show`

### Hook-Handler

```bash
# Automatische Konfiguration für Claude Code
shadowing setup-hooks
```

Empfängt Events (File-Open, Git-Commit, Tool-Use) und protokolliert automatisch Aktionen als Observation-Events.

---

## Public API

```typescript
import {
  ShadowingDB,
  TaskManager,
  SOPGenerator,
  Anonymizer,
  Exporter,
  Observer,
  SessionAnalyzer,
  calculateSOPMetrics,
  loadConfig,
} from '@datasynx/agentic-ai-shadowing';

// DB öffnen + Task starten
const db = new ShadowingDB('/path/to/shadowing.db');
const tm = new TaskManager(db);
const task = tm.startTask('Monatsabschluss SAP');

// Task abschließen → SOP generieren
const { task: completed } = tm.completeTask();
const gen = new SOPGenerator(loadConfig(), db);
const sop = await gen.generateSOP(completed);

// Metriken berechnen
const metrics = calculateSOPMetrics(db, sop.id);

// Anonymisiert exportieren
const config = loadConfig();
const exporter = new Exporter(db, new Anonymizer(config.anonymization), config);
exporter.exportSOPs([sop.id]);
```

---

## Configuration

Config: `~/.datasynx/shadowing/config.json`

```json
{
  "version": "1.0.0",
  "language": "de",
  "polling_interval_minutes": 15,
  "editor": "code",
  "ui_port": 3847,
  "cartography_graph_path": null,
  "anonymization": {
    "redact_emails": true,
    "redact_ips": true,
    "redact_urls": true,
    "redact_phone_numbers": true,
    "redact_file_paths": true,
    "custom_replacements": {}
  },
  "sop_generation": {
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 4096,
    "temperature": 0.3,
    "include_cartography_context": true,
    "auto_generate_tags": true,
    "sop_language": "de"
  }
}
```

---

## Development

```bash
npm run dev    # tsx src/cli.ts
npm run test   # vitest (373 Tests, 19 Testdateien)
npm run lint   # tsc --noEmit
npm run build  # tsup
```

---

<div align="center">

## Built by

[![Datasynx AI on LinkedIn](https://img.shields.io/badge/Datasynx_AI-Follow_on_LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/company/datasynx-ai/)

</div>

---

## License

MIT — © [Datasynx AI](https://www.linkedin.com/company/datasynx-ai/)
