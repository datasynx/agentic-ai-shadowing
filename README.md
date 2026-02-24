# @datasynx/agentic-ai-shadowing

Beobachtet wie ein Schatten die täglichen Arbeitsabläufe von Mitarbeitern und generiert daraus automatisch Standard Operating Procedures (SOPs) — vollständig lokal und anonymisiert.

## Highlights

- **Automatische Workflow-Erfassung** — Shell-History, aktive Fenster und Claude Code Hooks
- **KI-gestützte SOP-Generierung** via Claude (Anthropic SDK)
- **Cross-Platform** — Linux (X11), macOS, Windows (PowerShell)
- **Qualitäts-Metriken** — Konsistenz, Reife, Aktualität pro SOP
- **Anonymisierter Export** — PII-Redaktion für E-Mail, IP, URL, Telefon, Dateipfade, IBAN, Steuer-ID
- **Versionshistorie** — jede SOP-Änderung wird versioniert mit Diff-Ansicht
- **Web-Dashboard** — REST-API + HTML-Frontend (Dark-Theme)
- **Claude Code Integration** — MCP-Server + Hook-Handler für nahtlose IDE-Integration
- **Cartography-Integration** — Systemlandschaft aus `@datasynx/agentic-ai-cartography` als Kontext
- **SQLite-Datenbank** — alles lokal, keine Cloud, kein Daemon

## Voraussetzungen

- Node.js >= 20.0.0
- `ANTHROPIC_API_KEY` Umgebungsvariable (für SOP-Generierung)
- Optional: `@datasynx/agentic-ai-cartography` (für Systemlandschaft-Kontext)

## Installation

```bash
npm install -g @datasynx/agentic-ai-shadowing
```

Oder als Dependency in einem Projekt:

```bash
npm install @datasynx/agentic-ai-shadowing
```

## Quickstart

```bash
# 1. Einrichtung
shadowing init

# 2. Manueller Modus: Task starten, SOP generieren lassen
shadowing start

# 3. Automatischer Modus: Workflow beobachten
shadowing observe --auto-sop

# 4. SOPs anzeigen und exportieren
shadowing list
shadowing show <id>
shadowing export --all
```

## CLI-Befehle

### Task-Management

| Befehl | Beschreibung |
|--------|-------------|
| `shadowing init` | Erstmalige Einrichtung (DB + Config anlegen) |
| `shadowing start` | Interaktiven Shadowing-Modus starten |
| `shadowing status` | Aktuellen Task und Statistiken anzeigen |

### SOP-Verwaltung

| Befehl | Beschreibung |
|--------|-------------|
| `shadowing list` | SOPs auflisten (`--status`, `--tag`, `--search`) |
| `shadowing show <id>` | SOP im Terminal anzeigen |
| `shadowing edit <id>` | SOP im Standard-Editor bearbeiten |
| `shadowing delete <id>` | SOP unwiderruflich löschen |
| `shadowing history <id>` | Versionshistorie einer SOP anzeigen |
| `shadowing diff <id> [version]` | Diff zwischen SOP-Versionen anzeigen |
| `shadowing tag <id> <tags...>` | Tags hinzufügen (`+tag`) / entfernen (`-tag`) |

### Automatische Beobachtung

| Befehl | Beschreibung |
|--------|-------------|
| `shadowing observe` | Beobachtungsmodus starten |
| `shadowing observe --auto-sop` | Mit automatischer SOP-Generierung nach Stop |
| `shadowing observe --no-window` | Ohne Fenster-Erkennung |
| `shadowing sessions` | Beobachtungssessions auflisten |
| `shadowing timeline [session-id]` | Zeitachse einer Session anzeigen |
| `shadowing analyze [session-id]` | Session analysieren → Tasks erkennen → SOPs generieren |

### Metriken & Export

| Befehl | Beschreibung |
|--------|-------------|
| `shadowing stats` | Metriken-Dashboard im Terminal |
| `shadowing export` | Interaktiver Export-Wizard |
| `shadowing export --all` | Alle approved SOPs exportieren |

### Integration & Infrastruktur

| Befehl | Beschreibung |
|--------|-------------|
| `shadowing import-graph <path>` | Cartography-Graph (JGF) importieren |
| `shadowing infra [dir]` | Infrastruktur-Kontext aus Projektverzeichnis extrahieren |
| `shadowing ui` | Web-Dashboard starten (Port 3847) |

### Datenschutz

| Befehl | Beschreibung |
|--------|-------------|
| `shadowing consent` | Zustimmungsmanagement für Beobachtung |
| `shadowing exclude` | Ausschlussregeln für die Beobachtung verwalten |

### Claude Code Integration

| Befehl | Beschreibung |
|--------|-------------|
| `shadowing mcp` | MCP-Server starten (stdio-Transport) |
| `shadowing hook` | Hook-Events verarbeiten (intern) |
| `shadowing setup-hooks` | Claude Code Hooks + MCP-Server konfigurieren |

### Sonstiges

| Befehl | Beschreibung |
|--------|-------------|
| `shadowing config` | Konfiguration im Editor bearbeiten |
| `shadowing reset` | Alle Daten unwiderruflich löschen |
| `shadowing guide` | Komplette Anleitung und Workflow-Beschreibung |

## Architektur

```
┌─────────────────────────────────────────────────────────────┐
│                        CLI (commander)                       │
│  init · start · observe · list · show · export · stats · …  │
└────────┬───────────────┬──────────────────┬─────────────────┘
         │               │                  │
    ┌────▼────┐    ┌─────▼──────┐    ┌──────▼───────┐
    │  Task   │    │  Observer  │    │ SOP Generator│
    │ Manager │    │ (auto)     │    │ (Claude API) │
    └────┬────┘    └─────┬──────┘    └──────┬───────┘
         │               │                  │
         │    ┌──────────┼──────────┐       │
         │    │          │          │       │
    ┌────▼────▼──┐  ┌────▼───┐  ┌──▼───────▼──┐
    │ ShadowingDB│  │ Shell  │  │  Anonymizer  │
    │  (SQLite)  │  │ History│  │  (PII-Redak.)│
    └────────────┘  └────────┘  └──────────────┘
         │                           │
    ┌────▼─────┐              ┌──────▼──────┐
    │ Metrics  │              │  Exporter   │
    └──────────┘              └─────────────┘

    ┌──────────┐  ┌──────────┐  ┌───────────┐
    │ MCP      │  │ Hook     │  │ UI Server │
    │ Server   │  │ Handler  │  │ (REST+HTML)│
    └──────────┘  └──────────┘  └───────────┘
```

## Module

| Modul | Datei | Beschreibung |
|-------|-------|-------------|
| **ShadowingDB** | `src/db.ts` | SQLite-Wrapper mit WAL-Modus, 9 Tabellen, Migrations |
| **TaskManager** | `src/task-manager.ts` | Task-Lifecycle (start → pause → resume → complete) |
| **SOPGenerator** | `src/sop-generator.ts` | Claude API SOP-Generierung mit Prompt-Aufbau |
| **Anonymizer** | `src/anonymizer.ts` | PII-Redaktion (E-Mail, IP, URL, Telefon, Dateipfade, IBAN, Steuer-ID, SV-Nr) |
| **Exporter** | `src/exporter.ts` | Markdown-Export mit manifest.json |
| **Metrics** | `src/metrics.ts` | Konsistenz-, Reife-, Aktualitäts- und Qualitäts-Scores |
| **Observer** | `src/observer.ts` | Automatische Workflow-Erfassung (Shell + Fenster) |
| **SessionAnalyzer** | `src/session-analyzer.ts` | KI-gestützte Session-Analyse mit Silence-Clustering |
| **WindowDetector** | `src/window-detector.ts` | Cross-Platform Fenster-Erkennung (Linux/macOS/Windows) |
| **ShellHistory** | `src/shell-history.ts` | Shell-History-Parser (Zsh, Bash, Fish, PowerShell) |
| **PrivacyManager** | `src/privacy.ts` | Consent-Management und Ausschlussregeln |
| **UIServer** | `src/ui-server.ts` | REST-API + HTML-Dashboard |
| **MCPServer** | `src/mcp-server.ts` | Model Context Protocol Server (17 Tools) |
| **HookHandler** | `src/hook-handler.ts` | Claude Code Hook-Event-Verarbeitung |
| **Cartography** | `src/cartography.ts` | Graph-Import (JGF + Legacy-Format) |
| **Diff** | `src/diff.ts` | Text-Diff für SOP-Versionsvergleich |
| **InfraContext** | `src/infra-context.ts` | Infrastruktur-Erkennung aus Projektdateien |

## Cross-Platform Support

### Fenster-Erkennung

| Plattform | Methode |
|-----------|---------|
| **Linux** (X11) | `xdotool` — `getactivewindow` + `getwindowpid` |
| **macOS** | `osascript` — AppleScript für frontmost Application |
| **Windows** | PowerShell P/Invoke — `user32.dll` (GetForegroundWindow, GetWindowText) |

### Shell-History

| Shell | Format | Timestamps |
|-------|--------|-----------|
| **Zsh** | Extended format (`: timestamp:duration;command`) | Exakt |
| **Bash** | `#timestamp` + Kommandozeilen | Exakt |
| **Fish** | YAML-artig (`- cmd:` / `when:`) | Exakt |
| **PowerShell** | PSReadLine ConsoleHost_history.txt | Lesezeit |

Die Shell wird automatisch erkannt (`$SHELL`, `$MSYSTEM` für Git Bash, Platform-Fallback).

## Datenschutz & Anonymisierung

### Prinzipien

- Alle Daten bleiben **lokal** auf dem Rechner
- Kein automatischer Upload, kein Cloud-Sync
- Der Mitarbeiter kontrolliert Start, Stop und Export
- Exports werden automatisch anonymisiert

### Konfigurierbare Anonymisierung

| Pattern | Ersetzung | Config-Key |
|---------|----------|------------|
| E-Mail-Adressen | `[email@example.com]` | `redact_emails` |
| IPv4/IPv6-Adressen | `[interne-ip]` | `redact_ips` |
| URLs | `[internes-system]/pfad` | `redact_urls` |
| Telefonnummern | `[Telefonnummer]` | `redact_phone_numbers` |
| Dateipfade | `/Users/[user]/...` | `redact_file_paths` |

### Immer aktive Patterns

| Pattern | Ersetzung |
|---------|----------|
| IBAN | `[IBAN]` |
| Kreditkartennummern | `[Kreditkartennummer]` |
| Steuer-ID | `[Steuer-ID]` |
| Sozialversicherungsnummer | `[SV-Nummer]` |

### Custom Replacements

```json
{
  "anonymization": {
    "custom_replacements": {
      "Firmenname GmbH": "[Unternehmen]",
      "geheim123": "[REDACTED]"
    }
  }
}
```

## Metriken

### Konsistenz-Score

`max(0, 100 - CV * 2)` — basierend auf dem Variationskoeffizienten der Ausführungsdauern. Niedrigerer CV = konsistenterer Prozess.

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

## Claude Code Integration

### MCP-Server

Shadowing bietet einen MCP-Server (Model Context Protocol) mit 17 Tools für die nahtlose Integration in Claude Code:

```bash
# MCP-Server starten
shadowing mcp
```

Tools umfassen: `task_start`, `task_status`, `task_complete`, `sop_list`, `sop_show`, `sop_generate`, `observe_start`, `observe_stop`, `timeline_show` und mehr.

### Hook-Handler

Der Hook-Handler empfängt Events von Claude Code und protokolliert automatisch Aktionen:

```bash
# Automatische Konfiguration
shadowing setup-hooks
```

## Konfiguration

Config-Pfad: `~/.datasynx/shadowing/config.json`

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
  },
  "metrics": {
    "quality_score_weights": {
      "consistency": 0.35,
      "maturity": 0.35,
      "freshness": 0.30
    }
  }
}
```

## Export-Format

```
exports/export_YYYY-MM-DDTHH-mm-ss/
├── manifest.json
└── sops/
    ├── sop_001.md
    ├── sop_002.md
    └── ...
```

Die `manifest.json` enthält Metadaten, Tag-Zusammenfassung und Metriken-Übersicht.

## Web-Dashboard

```bash
shadowing ui
# → http://localhost:3847
```

REST-API-Endpunkte:

| Methode | Pfad | Beschreibung |
|---------|------|-------------|
| GET | `/api/stats` | Globale Statistiken |
| GET | `/api/tasks` | Task-Liste (Filter: `?status=`) |
| GET | `/api/tasks/active` | Aktiver Task |
| GET | `/api/sops` | SOP-Liste (Filter: `?status=`, `?tag=`, `?search=`) |
| GET | `/api/sops/:id` | SOP-Detail mit Metriken + Versionen |
| PUT | `/api/sops/:id/status` | Status ändern |
| GET | `/api/sops/:id/diff` | Diff zur Vorgängerversion |
| GET | `/api/tags` | Alle Tags |
| GET | `/api/exports` | Export-Historie |

## Entwicklung

```bash
npm run dev    # tsx src/cli.ts
npm run test   # vitest (358 Tests, 19 Testdateien)
npm run lint   # tsc --noEmit
npm run build  # tsup
```

### Projektstruktur

```
src/
├── cli.ts               # Commander CLI (25+ Befehle)
├── index.ts             # Public API Exports
├── db.ts                # SQLite-Wrapper (9 Tabellen, WAL-Modus)
├── types.ts             # TypeScript-Typen + Zod-Schemas
├── config.ts            # Config-Management
├── task-manager.ts      # Task-Lifecycle
├── sop-generator.ts     # Claude API SOP-Generierung
├── metrics.ts           # Qualitäts-Scores
├── anonymizer.ts        # PII-Redaktion
├── exporter.ts          # Markdown-Export
├── diff.ts              # Text-Diff
├── observer.ts          # Automatische Beobachtung
├── session-analyzer.ts  # KI Session-Analyse
├── window-detector.ts   # Cross-Platform Fenster-Erkennung
├── shell-history.ts     # Shell-History-Parser (4 Shells)
├── privacy.ts           # Consent + Ausschlussregeln
├── ui-server.ts         # REST-API + HTML-Dashboard
├── dashboard-html.ts    # Eingebettetes Dark-Theme HTML
├── mcp-server.ts        # MCP-Server (17 Tools)
├── hook-handler.ts      # Claude Code Hook-Verarbeitung
├── cartography.ts       # Graph-Import (JGF)
├── cartography-check.ts # Cartography-Prüflogik
└── infra-context.ts     # Infrastruktur-Erkennung
test/
├── 19 Testdateien       # 358+ Tests
└── ...
```

### Programmatische Nutzung

```typescript
import {
  ShadowingDB,
  TaskManager,
  SOPGenerator,
  Anonymizer,
  Exporter,
  calculateSOPMetrics,
  loadConfig,
} from '@datasynx/agentic-ai-shadowing';

// DB öffnen
const db = new ShadowingDB('/path/to/shadowing.db');

// Task starten
const tm = new TaskManager(db, loadConfig());
const task = tm.startTask('Monatsabschluss SAP');

// Task abschließen → SOP generieren
const { task: completed } = tm.completeTask();
const generator = new SOPGenerator(loadConfig(), db);
const sop = await generator.generateSOP(completed);

// Metriken berechnen
const metrics = calculateSOPMetrics(db, sop.id);

// Anonymisiert exportieren
const exporter = new Exporter(db, new Anonymizer(loadConfig().anonymization), loadConfig());
const result = exporter.exportSOPs([sop.id]);
```

## Lizenz

MIT
