# Agentic AI Shadowing — Product Specification v0.1.0

## 1. Overview

**Agentic AI Shadowing** is a CLI tool that shadows the daily workflows of employees like a silent observer and automatically generates Standard Operating Procedures (SOPs) from them.

**Core Principles:**
- Fully local — no cloud, no external services (except Claude API for SOP generation)
- Employee-driven — the employee starts, pauses, and completes tasks themselves
- Anonymized — all exports are automatically scrubbed of PII
- Minimally invasive — pure terminal tool, no agent, no background daemon

## 2. Architecture

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

## 3. Data Model

### 3.1 SQLite Schema

**tasks** — Employee Tasks
| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | hex(randomblob(8)) |
| title | TEXT NOT NULL | Task title |
| description | TEXT | Notes/description |
| status | TEXT | active, paused, completed, cancelled |
| started_at | TEXT | ISO 8601 UTC |
| completed_at | TEXT | ISO 8601 UTC |
| duration_seconds | INTEGER | Calculated duration |
| created_at | TEXT | ISO 8601 UTC |
| updated_at | TEXT | ISO 8601 UTC |

**sops** — Standard Operating Procedures
| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | hex(randomblob(8)) |
| task_id | TEXT FK | Linked task |
| title | TEXT NOT NULL | SOP title |
| description | TEXT | Short description |
| content_md | TEXT NOT NULL | Markdown content |
| version | INTEGER | Auto-increment on content change |
| status | TEXT | draft, reviewed, approved, exported, archived |
| ai_generated | INTEGER | 1=AI-generated |
| reviewed_at | TEXT | Time of review |
| exported_at | TEXT | Time of export |

**sop_versions** — Version History
| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | hex(randomblob(8)) |
| sop_id | TEXT FK | Linked SOP |
| version | INTEGER | Version number |
| title | TEXT | Title at this point in time |
| content_md | TEXT | Content at this point in time |
| changed_at | TEXT | Time of change |
| change_summary | TEXT | Optional summary |

**tags** — Categorization (case-insensitive)
**sop_tags** — N:M mapping SOP↔Tag
**task_executions** — Execution log with duration and complexity
**exports** — Export log
**export_sops** — N:M mapping Export↔SOP

## 4. SOP Generation

### 4.1 Prompt Structure

**System Prompt:**
- Role: SOP Analyst
- Language: configurable (en/de)
- Markdown structure: Objective → Prerequisites → Steps → Expected Result → Notes
- Tag generation as JSON block at the end

**User Prompt:**
- Task title and description/notes
- Duration
- Optional: Cartography graph context (relevant systems)

### 4.2 Markdown Structure
```markdown
# [SOP Title]
## Objective
## Prerequisites
## Steps
### Step 1: [Label]
...
## Expected Result
## Notes
## Linked Systems
```

### 4.3 Tag Generation
Categories: Department, Tool/System, Process Type, Frequency, Complexity.
3-8 tags per SOP, lowercase.

## 5. Metrics

### 5.1 Consistency Score
`max(0, 100 - CV * 2)` — based on the coefficient of variation of execution durations.

### 5.2 Maturity Score (weighted)
- ≥5 executions → 30%
- Review performed → 30%
- ≥1 revision → 20%
- Tags present → 10%
- Description present → 10%

### 5.3 Freshness Score
Based on review age and execution frequency. Frequently executed SOPs become outdated faster.

### 5.4 Overall Quality Score
`consistency * 0.35 + maturity * 0.35 + freshness * 0.30`

## 6. Anonymization

### 6.1 Configurable Patterns
- Email addresses → `[email@example.com]`
- IPv4/IPv6 addresses → `[internal-ip]`
- URLs → `[internal-system]/path`
- Phone numbers → `[phone-number]`
- File paths → `/Users/[user]/...`

### 6.2 Always-Active Patterns
- IBAN → `[IBAN]`
- Credit card numbers → `[credit-card-number]`
- Tax ID → `[tax-id]`
- Social security number → `[ssn]`
- GitHub tokens (`ghp_`, `gho_`, `github_pat_`, …) → `[github-token]`
- Anthropic keys (`sk-ant-…`) → `[anthropic-api-key]`, generic `sk-…` → `[api-key]`
- AWS access key IDs (`AKIA`/`ASIA`) → `[aws-access-key-id]`, Secrets Manager ARNs → `[aws-secret-arn]`
- Slack tokens (`xox?-`) → `[slack-token]`
- JWTs → `[jwt]`, Bearer header values → `Bearer [api-token]`
- PEM private-key blocks → `[private-key]`
- Unknown high-entropy tokens → `[high-entropy-string]` (configurable: `redact_high_entropy`; skips git SHAs, UUIDs, ordinary identifiers)

### 6.3 Custom Replacements
Configurable via `config.anonymization.custom_replacements`.

### 6.4 Redact-on-Capture
With `anonymization.redact_on_capture` (default `true`), window titles, shell
commands, file paths, task titles/descriptions, and task notes are redacted
**before** they are persisted to SQLite — enforced at the DB layer
(`createTask`/`updateTask`/`logObservedAction`), so every entry path (CLI, MCP
tools, hook handler) is covered. Export-time anonymization remains as a second
layer. The pipeline is idempotent (re-running over redacted text is a no-op);
`shadowing scrub` retroactively redacts databases written by older versions.

## 7. Export

### 7.1 Directory Structure
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
  "tags_summary": ["accounting", "sap"],
  "metrics_summary": {
    "avg_completion_time_seconds": 1800,
    "avg_quality_score": 75,
    "total_executions": 42
  },
  "sops": [...]
}
```

## 8. Web Dashboard

REST API on a configurable port (default: 3847).

### 8.1 API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/stats | Global statistics |
| GET | /api/tasks | Task list (filter: ?status=) |
| GET | /api/tasks/active | Active task |
| GET | /api/sops | SOP list (filter: ?status=, ?tag=, ?search=) |
| GET | /api/sops/:id | SOP detail with metrics + versions |
| PUT | /api/sops/:id/status | Change status |
| GET | /api/sops/:id/diff | Diff to previous version |
| GET | /api/tags | All tags |
| GET | /api/exports | Export history |

### 8.2 HTML Dashboard
Embedded single-page HTML with dark theme. Features:
- Statistics tiles
- Active task with runtime
- SOP list with filter and search
- SOP detail with Markdown preview, metrics, version history
- Status workflow: Draft → Reviewed → Approved

## 9. Cartography Integration

Optional: Imported JSON graph from `@datasynx/agentic-ai-cartography`.

- Zod-validated schema (nodes + edges)
- Automatic keyword extraction from task title/description
- Focused context: only relevant systems in SOP prompt
- Fallback to full overview when no matches

## 10. Configuration

Path: `~/.datasynx/shadowing/config.json`

```json
{
  "version": "1.0.0",
  "language": "en",
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
    "sop_language": "en"
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
