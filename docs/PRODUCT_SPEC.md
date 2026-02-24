# Agentic AI Shadowing — Produktspezifikation v0.1.0

## 1. Überblick

**Agentic AI Shadowing** ist ein CLI-Tool, das wie ein Schatten die täglichen Arbeitsabläufe von Mitarbeitern beobachtet und daraus automatisch Standard Operating Procedures (SOPs) generiert.

**Kernprinzipien:**
- Vollständig lokal — keine Cloud, keine externen Services (außer Claude API für SOP-Generierung)
- Mitarbeiter-gesteuert — der Mitarbeiter startet, pausiert und beendet Tasks selbst
- Anonymisiert — alle Exporte werden automatisch von PII bereinigt
- Minimal invasiv — reines Terminal-Tool, kein Agent, kein Hintergrund-Daemon

## 2. Architektur

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   CLI (cli)  │────▶│  TaskManager │────▶│  ShadowingDB │
└──────────────┘     └──────────────┘     │  (SQLite)    │
       │                    │              └──────────────┘
       │              ┌─────▼──────┐             │
       │              │ SOPGenerator│             │
       │              │ (Claude API)│             │
       │              └────────────┘             │
       │                                         │
       │    ┌──────────┐  ┌──────────┐          │
       └───▶│ Anonymizer│──│ Exporter │◀─────────┘
            └──────────┘  └──────────┘
                                │
       ┌──────────┐      ┌─────▼──────┐
       │ Metrics  │◀─────│  exports/  │
       └──────────┘      └────────────┘

       ┌──────────┐
       │ UI Server│── HTTP → HTML Dashboard
       └──────────┘
```

## 3. Datenmodell

### 3.1 SQLite-Schema

**tasks** — Mitarbeiter-Tasks
| Spalte | Typ | Beschreibung |
|--------|-----|-------------|
| id | TEXT PK | hex(randomblob(8)) |
| title | TEXT NOT NULL | Task-Titel |
| description | TEXT | Notizen/Beschreibung |
| status | TEXT | active, paused, completed, cancelled |
| started_at | TEXT | ISO 8601 UTC |
| completed_at | TEXT | ISO 8601 UTC |
| duration_seconds | INTEGER | Berechnete Dauer |
| created_at | TEXT | ISO 8601 UTC |
| updated_at | TEXT | ISO 8601 UTC |

**sops** — Standard Operating Procedures
| Spalte | Typ | Beschreibung |
|--------|-----|-------------|
| id | TEXT PK | hex(randomblob(8)) |
| task_id | TEXT FK | Verknüpfter Task |
| title | TEXT NOT NULL | SOP-Titel |
| description | TEXT | Kurzbeschreibung |
| content_md | TEXT NOT NULL | Markdown-Inhalt |
| version | INTEGER | Auto-inkrement bei Content-Änderung |
| status | TEXT | draft, reviewed, approved, exported, archived |
| ai_generated | INTEGER | 1=KI-generiert |
| reviewed_at | TEXT | Zeitpunkt des Reviews |
| exported_at | TEXT | Zeitpunkt des Exports |

**sop_versions** — Versionshistorie
| Spalte | Typ | Beschreibung |
|--------|-----|-------------|
| id | TEXT PK | hex(randomblob(8)) |
| sop_id | TEXT FK | Verknüpfte SOP |
| version | INTEGER | Versionsnummer |
| title | TEXT | Titel zu diesem Zeitpunkt |
| content_md | TEXT | Content zu diesem Zeitpunkt |
| changed_at | TEXT | Änderungszeitpunkt |
| change_summary | TEXT | Optionale Zusammenfassung |

**tags** — Kategorisierung (case-insensitive)
**sop_tags** — N:M Zuordnung SOP↔Tag
**task_executions** — Ausführungsprotokoll mit Dauer und Komplexität
**exports** — Export-Protokoll
**export_sops** — N:M Zuordnung Export↔SOP

## 4. SOP-Generierung

### 4.1 Prompt-Aufbau

**System-Prompt:**
- Rolle: SOP-Analyst
- Sprache: konfigurierbar (de/en)
- Markdown-Struktur: Ziel → Voraussetzungen → Schritte → Erwartetes Ergebnis → Hinweise
- Tag-Generierung als JSON-Block am Ende

**User-Prompt:**
- Task-Titel und Beschreibung/Notizen
- Dauer
- Optional: Cartography-Graph-Kontext (relevante Systeme)

### 4.2 Markdown-Struktur
```markdown
# [SOP-Titel]
## Ziel
## Voraussetzungen
## Schritte
### Schritt 1: [Bezeichnung]
...
## Erwartetes Ergebnis
## Hinweise
## Verknüpfte Systeme
```

### 4.3 Tag-Generierung
Kategorien: Abteilung, Tool/System, Prozessart, Frequenz, Komplexität.
3-8 Tags pro SOP, lowercase.

## 5. Metriken

### 5.1 Konsistenz-Score
`max(0, 100 - CV * 2)` — basierend auf dem Variationskoeffizienten der Ausführungsdauern.

### 5.2 Reife-Score (gewichtet)
- ≥5 Ausführungen → 30%
- Review durchgeführt → 30%
- ≥1 Revision → 20%
- Tags vorhanden → 10%
- Beschreibung vorhanden → 10%

### 5.3 Aktualitäts-Score
Basierend auf Review-Alter und Ausführungsfrequenz. Häufig ausgeführte SOPs veralten schneller.

### 5.4 Gesamt-Qualitäts-Score
`consistency * 0.35 + maturity * 0.35 + freshness * 0.30`

## 6. Anonymisierung

### 6.1 Konfigurierbare Patterns
- E-Mail-Adressen → `[email@example.com]`
- IPv4/IPv6-Adressen → `[interne-ip]`
- URLs → `[internes-system]/pfad`
- Telefonnummern → `[Telefonnummer]`
- Dateipfade → `/Users/[user]/...`

### 6.2 Immer aktive Patterns
- IBAN → `[IBAN]`
- Kreditkartennummern → `[Kreditkartennummer]`
- Steuer-ID → `[Steuer-ID]`
- Sozialversicherungsnummer → `[SV-Nummer]`

### 6.3 Custom Replacements
Konfigurierbar über `config.anonymization.custom_replacements`.

## 7. Export

### 7.1 Verzeichnisstruktur
```
exports/export_YYYY-MM-DDTHH-mm-ss/
├── manifest.json
└── sops/
    ├── sop_001.md
    ├── sop_002.md
    └── ...
```

### 7.2 manifest.json
```json
{
  "version": "1.0.0",
  "exported_at": "ISO-8601",
  "source": "agentic-ai-shadowing",
  "sop_count": 5,
  "anonymized": true,
  "tags_summary": ["buchhaltung", "sap"],
  "metrics_summary": {
    "avg_completion_time_seconds": 1800,
    "avg_quality_score": 75,
    "total_executions": 42
  },
  "sops": [...]
}
```

## 8. Web-Dashboard

REST-API auf konfigurierbarem Port (default: 3847).

### 8.1 API-Endpunkte
| Methode | Pfad | Beschreibung |
|---------|------|-------------|
| GET | /api/stats | Globale Statistiken |
| GET | /api/tasks | Task-Liste (filter: ?status=) |
| GET | /api/tasks/active | Aktiver Task |
| GET | /api/sops | SOP-Liste (filter: ?status=, ?tag=, ?search=) |
| GET | /api/sops/:id | SOP-Detail mit Metriken + Versionen |
| PUT | /api/sops/:id/status | Status ändern |
| GET | /api/sops/:id/diff | Diff zur Vorgängerversion |
| GET | /api/tags | Alle Tags |
| GET | /api/exports | Export-Historie |

### 8.2 HTML-Dashboard
Eingebettetes Single-Page HTML mit Dark-Theme. Features:
- Statistik-Kacheln
- Aktiver Task mit Laufzeit
- SOP-Liste mit Filter und Suche
- SOP-Detail mit Markdown-Preview, Metriken, Versionshistorie
- Status-Workflow: Draft → Reviewed → Approved

## 9. Cartography-Integration

Optional: Importierter JSON-Graph aus `@datasynx/agentic-ai-cartography`.

- Zod-validiertes Schema (nodes + edges)
- Automatische Keyword-Extraktion aus Task-Titel/Beschreibung
- Fokussierter Kontext: nur relevante Systeme im SOP-Prompt
- Fallback auf vollständige Übersicht wenn keine Matches

## 10. Konfiguration

Pfad: `~/.datasynx/shadowing/config.json`

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
