# @datasynx/agentic-ai-shadowing

> **Work in progress** — v0.1.0 MVP

Beobachtet wie ein Schatten die Tasks aller Mitarbeiter und erstellt daraus vollständig lokal und anonymisiert Standard Operating Procedures (SOPs).

- Interaktiver CLI-basierter Task-Lifecycle (Start / Pause / Complete / Cancel)
- SOP-Generierung via Claude (Anthropic SDK)
- Qualitäts-Metriken: Konsistenz, Reife, Aktualität
- Anonymisierter Markdown-Export mit manifest.json
- SQLite-Datenbank — alles lokal, keine Cloud

## Installation

```bash
npm install -g @datasynx/agentic-ai-shadowing
```

## Quickstart

```bash
shadowing init          # DB + Config anlegen
shadowing start         # Interaktiven Task-Loop starten
shadowing list          # Alle SOPs auflisten
shadowing show <id>     # SOP im Terminal anzeigen
shadowing export --all  # Approved SOPs exportieren
```

## CLI-Befehle

| Befehl | Beschreibung |
|---|---|
| `shadowing init` | Erstmalige Einrichtung |
| `shadowing start` | Interaktiven Shadowing-Modus starten |
| `shadowing status` | Aktuellen Task und Statistiken anzeigen |
| `shadowing list` | SOPs auflisten (mit `--status`, `--tag`, `--search`) |
| `shadowing show <id>` | SOP im Terminal anzeigen |
| `shadowing edit <id>` | SOP im Editor bearbeiten |
| `shadowing delete <id>` | SOP löschen |
| `shadowing tag <id> <tags...>` | Tags hinzufügen (`+tag`) / entfernen (`-tag`) |
| `shadowing stats` | Metriken-Dashboard |
| `shadowing export` | Interaktiver Export-Wizard |
| `shadowing export --all` | Alle approved SOPs exportieren |
| `shadowing import-graph <path>` | Cartography-Graph importieren |
| `shadowing config` | Konfiguration bearbeiten |
| `shadowing reset` | Alle Daten löschen |

## Datenschutz

- Alle Daten bleiben lokal auf dem Rechner
- Kein automatischer Upload, kein Cloud-Sync
- Mitarbeiter kontrolliert Start/Stop/Export
- Export ist immer anonymisiert (PII-Redaktion)

## Entwicklung

```bash
npm run dev    # tsx src/cli.ts
npm run test   # vitest (33 Tests)
npm run lint   # tsc --noEmit
npm run build  # tsup
```

## Lizenz

MIT
