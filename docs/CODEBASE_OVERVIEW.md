# Codebase Overview — @datasynx/agentic-ai-shadowing

## What This Project Does

Agentic AI Shadowing is a CLI tool that **observes employee workflows** (shell commands, active windows, git activity, file changes) and **automatically generates Standard Operating Procedures (SOPs)** using Claude. Everything runs locally with SQLite — no cloud sync, no background daemon.

Two modes of operation:
1. **Manual mode** (`shadowing start`) — employee explicitly starts/pauses/completes tasks, then generates an SOP
2. **Automatic mode** (`shadowing observe`) — passively watches shell history, window switches, git commits, and file changes, then uses an LLM to cluster observations into tasks and generate SOPs

---

## Architecture

```
src/
├── cli.ts              # 1605 LOC — Commander CLI with 27 commands
├── db.ts               #  894 LOC — SQLite wrapper (11 tables, WAL mode)
├── types.ts            #  265 LOC — All TypeScript interfaces
├── config.ts           #       — Config management (~/.datasynx/shadowing/)
├── task-manager.ts     #       — Task lifecycle (start/pause/resume/complete/cancel)
├── sop-generator.ts    #       — Claude API integration for SOP generation
├── metrics.ts          #       — Quality scoring (consistency, maturity, freshness)
├── anonymizer.ts       #       — PII redaction (emails, IPs, URLs, IBAN, etc.)
├── exporter.ts         #       — Markdown export with manifest.json
├── observer.ts         #  314 LOC — Heartbeat-based workflow capture
├── session-analyzer.ts #  404 LOC — Silence-based clustering + LLM task detection
├── window-detector.ts  #  244 LOC — Cross-platform window tracking (Linux/macOS/Windows)
├── shell-history.ts    #  268 LOC — Multi-shell history parser (zsh/bash/fish/powershell)
├── privacy.ts          #       — Consent management + exclusion rules + data degradation
├── ui-server.ts        #       — Express REST API (17 endpoints) + HTML dashboard
├── dashboard-html.ts   # 1123 LOC — Embedded single-page dark-theme dashboard
├── mcp-server.ts       #  491 LOC — Model Context Protocol server (17 tools, stdio)
├── hook-handler.ts     #  203 LOC — Claude Code hook event processing
├── cartography.ts      #  216 LOC — JGF graph import from agentic-ai-cartography
├── cartography-check.ts#       — Cartography availability detection
├── infra-context.ts    #  426 LOC — Local infrastructure detection (docker, k8s, etc.)
├── diff.ts             #       — Line-by-line diff for SOP version comparison
└── index.ts            #       — Public API re-exports
```

Total: ~8,000 LOC source, ~6,300 LOC tests (596 tests across 24 test files).

---

## Data Model (SQLite)

11 tables in `~/.datasynx/shadowing/shadowing.db`:

| Table | Purpose |
|-------|---------|
| `tasks` | Employee tasks with status lifecycle (active/paused/completed/cancelled) |
| `sops` | Generated SOPs linked to tasks, with version tracking |
| `sop_versions` | Full version history of SOP content changes |
| `tags` | Case-insensitive tag storage |
| `sop_tags` | N:M mapping between SOPs and tags |
| `task_executions` | Execution log per SOP (duration, complexity 1-5) |
| `exports` | Export audit log |
| `export_sops` | N:M mapping between exports and SOPs |
| `observation_sessions` | Automatic observation sessions |
| `observed_actions` | Individual observed events (window/shell/git/file/manual) |
| `consent_log` | Privacy consent records |
| `exclusion_rules` | Apps/patterns to exclude from observation |

Key constraints:
- At most **one active task** at any time (unique partial index)
- At most **one active observation session** (unique partial index)
- Foreign keys with `ON DELETE CASCADE`
- WAL journal mode for concurrent reads

---

## Module Responsibilities

### Core Modules

**`db.ts` — ShadowingDB**
SQLite wrapper using `better-sqlite3`. Handles all CRUD for tasks, SOPs, tags, executions, exports, observation sessions, observed actions, consent, and exclusion rules. Includes schema migration support and data degradation (purge/anonymize old actions).

**`task-manager.ts` — TaskManager**
Orchestrates the manual task lifecycle: `startTask()` → `pauseTask()` → `resumeTask()` → `completeTask()`. Handles pause time tracking, note appending, and duration formatting. Enforces single-active-task constraint.

**`sop-generator.ts` — SOPGenerator**
Builds structured prompts (system + user) and calls the Claude API via `@anthropic-ai/sdk`. Parses the response to extract Markdown content and auto-generated tags (department, tool, process type, frequency, complexity). Supports cartography context injection for infrastructure-aware SOPs.

**`metrics.ts` — Quality Scoring**
Four scoring dimensions:
- **Consistency** (`max(0, 100 - CV * 2)`) — based on coefficient of variation of execution durations
- **Maturity** — weighted: executions (30%), review (30%), revisions (20%), tags (10%), description (10%)
- **Freshness** — based on review age and execution frequency
- **Overall** — `consistency * 0.35 + maturity * 0.35 + freshness * 0.30`

**`anonymizer.ts` — Anonymizer**
Regex-based PII redaction. Configurable patterns: emails, IPs (IPv4/v6 with private range detection), URLs, phone numbers, file paths. Always-on patterns: IBAN, credit cards (with Luhn validation), tax IDs, social security numbers. Custom replacements via config.

**`exporter.ts` — Exporter**
Creates export directory structure (`exports/export_YYYY-MM-DDTHH-mm-ss/sops/`), anonymizes SOP content, writes individual Markdown files, generates `manifest.json` with metadata and metrics summary, and logs exports to the database.

### Observation Modules

**`observer.ts` — Observer**
Heartbeat-based workflow capture. Polls at configurable intervals to detect:
- Active window changes (via `window-detector.ts`)
- New shell commands (via `shell-history.ts`)
- Git commits (via `git log`)
- File modifications (via `fs.stat`)

Applies exclusion rules (app name, title pattern, URL pattern, path pattern) and work-hours filtering. Logs everything as `observed_actions` in the database.

**`window-detector.ts` — Cross-Platform Window Detection**
- **Linux**: `xdotool` (X11)
- **macOS**: `osascript` (AppleScript)
- **Windows**: PowerShell with `user32.dll` P/Invoke (`GetForegroundWindow` + `GetWindowText`)

**`shell-history.ts` — Multi-Shell History Parser**
Parses shell history files with timestamps:
- **Zsh**: Extended format (`: timestamp:duration;command`)
- **Bash**: `#timestamp` + command lines
- **Fish**: YAML-like (`- cmd:` / `when:`)
- **PowerShell**: PSReadLine `ConsoleHost_history.txt`

Auto-detects shell from `$SHELL` (Unix) or `$MSYSTEM`/PowerShell fallback (Windows).

**`session-analyzer.ts` — SessionAnalyzer**
Analyzes observation sessions to detect tasks:
- **Silence clustering**: Groups actions by time gaps (configurable threshold)
- **Task summarization**: Describes what each cluster of actions represents
- **LLM integration**: Uses Claude to detect task boundaries and generate SOPs from observation data

**`privacy.ts` — PrivacyManager**
Manages consent (grant/revoke per scope), exclusion rules, and data degradation (purge old action metadata, anonymize command contents after configurable retention periods).

### Integration Modules

**`ui-server.ts` — Web Dashboard**
Express-based REST API with 17 endpoints serving a single-page HTML dashboard. Features:
- Statistics tiles, active task display, SOP list with filters
- SOP editor with Markdown preview
- Version history with diff viewer
- Tag management, export workflow
- Observation session timeline

**`mcp-server.ts` — MCPServer**
Model Context Protocol server (stdio transport) exposing 17 tools for Claude Code integration:
`task_start`, `task_status`, `task_complete`, `task_pause`, `sop_list`, `sop_show`, `sop_generate`, `sop_update_status`, `observe_start`, `observe_stop`, `timeline_show`, `session_analyze`, `export_sops`, `stats_show`, `consent_manage`, `exclude_manage`, `config_show`

**`hook-handler.ts` — Claude Code Hooks**
Processes Claude Code events (file-open, git-commit, tool-use) and automatically logs them as observation actions. Classifies tool actions and builds human-readable descriptions.

**`cartography.ts` — Cartography Integration**
Imports JGF (JSON Graph Format) files from `@datasynx/agentic-ai-cartography`. Extracts keywords from task descriptions to find relevant infrastructure nodes, then injects focused context into SOP generation prompts.

**`infra-context.ts` — Infrastructure Detection**
Scans the local project directory for infrastructure signals: `docker-compose.yml`, `Dockerfile`, `k8s/` manifests, `package.json` dependencies, CI/CD configs. Builds a lightweight infrastructure graph without requiring the full cartography package.

**`diff.ts` — Version Diffing**
Line-by-line diff algorithm for comparing SOP versions. Produces colored terminal output and structured diff results for the dashboard.

---

## CLI Commands (27 total)

### Task Management
| Command | Description |
|---------|-------------|
| `shadowing init` | Create DB + config |
| `shadowing start` | Interactive task mode |
| `shadowing status` | Show current task + stats |

### SOP Management
| Command | Description |
|---------|-------------|
| `shadowing list` | List SOPs (--status, --tag, --search) |
| `shadowing show <id>` | Display SOP in terminal |
| `shadowing edit <id>` | Edit in $EDITOR |
| `shadowing delete <id>` | Delete SOP |
| `shadowing history <id>` | Version history |
| `shadowing diff <id>` | Diff between versions |
| `shadowing tag <id> <tags>` | Add (+tag) / remove (-tag) |

### Automatic Observation
| Command | Description |
|---------|-------------|
| `shadowing observe` | Start observation (--auto-sop, --no-window, --no-shell) |
| `shadowing sessions` | List sessions |
| `shadowing timeline [id]` | Show session timeline |
| `shadowing analyze [id]` | Detect tasks + generate SOPs |

### Metrics & Export
| Command | Description |
|---------|-------------|
| `shadowing stats` | Terminal metrics dashboard |
| `shadowing export` | Interactive export wizard |
| `shadowing export --all` | Export all approved SOPs |
| `shadowing ui` | Web dashboard (default port 3847) |

### Privacy
| Command | Description |
|---------|-------------|
| `shadowing consent` | Consent management |
| `shadowing exclude` | Manage exclusion rules |

### Integration
| Command | Description |
|---------|-------------|
| `shadowing import-graph <path>` | Import cartography JGF |
| `shadowing infra [dir]` | Extract infrastructure context |
| `shadowing mcp` | Start MCP server |
| `shadowing setup-hooks` | Configure Claude Code hooks |
| `shadowing config` | Open config in editor |
| `shadowing reset` | Delete all data |
| `shadowing guide` | Show complete guide |

---

## Configuration

Stored at `~/.datasynx/shadowing/config.json`:

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
    "model": "claude-sonnet-4-6",
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

---

## Test Suite

596 tests across 24 files:

| Test File | Coverage |
|-----------|----------|
| `db.test.ts` | CRUD for all 11 tables, constraints, cascading deletes |
| `db-migrations.test.ts` | Versioned `user_version` upgrades from a legacy schema: data preservation, idempotency, error surfacing, atomic rollback |
| `db-edge-cases.test.ts` | Edge cases: concurrent access, empty states |
| `task-manager.test.ts` | Task lifecycle, pause/resume, duration formatting |
| `task-manager-edge-cases.test.ts` | Error conditions, note appending, special characters |
| `sop-generator.test.ts` | Prompt construction, response parsing, tag extraction |
| `metrics.test.ts` | All four scoring dimensions |
| `metrics-edge-cases.test.ts` | Zero executions, extreme values |
| `anonymizer.test.ts` | Each PII pattern, custom replacements |
| `anonymizer-edge-cases.test.ts` | Malformed inputs, markdown preservation, combined PII |
| `exporter.test.ts` | Directory structure, manifest format, anonymization |
| `observer.test.ts` | Heartbeat capture, exclusion rules, work hours |
| `session-analyzer.test.ts` | Silence clustering, task detection |
| `window-detector.test.ts` | Platform detection, output parsing |
| `shell-history.test.ts` | All 4 shell formats, auto-detection |
| `privacy.test.ts` | Consent, exclusion rules, data degradation |
| `config.test.ts` | Load/save, defaults, schema validation |
| `cartography.test.ts` | JGF loading, keyword matching, focused context |
| `cartography-check.test.ts` | Availability detection, fallback |
| `infra-context.test.ts` | Docker, k8s, package.json detection |
| `diff.test.ts` | Line-by-line diff, additions/deletions |
| `hook-handler.test.ts` | Event processing, tool classification |
| `mcp-server.test.ts` | All 17 MCP tools |
| `ui-server.test.ts` | REST API endpoints |
| `e2e-full.test.ts` | End-to-end CLI smoke tests |

---

## Build & Development

```bash
npm run build   # tsup → dist/cli.js + dist/index.js + dist/index.d.ts
npm run dev     # tsx src/cli.ts (direct execution)
npm run test    # vitest run (596 tests)
npm run lint    # tsc --noEmit (strict mode)
```

Build output:
- `dist/cli.js` — CLI binary with shebang (registered as `shadowing` in package.json `bin`)
- `dist/index.js` + `dist/index.d.ts` — Library entry for programmatic usage

---

## Key Design Decisions

1. **Single active task constraint** — enforced at the database level via unique partial index, not just application logic
2. **WAL mode** — enables concurrent reads while the CLI writes, important for the web dashboard
3. **Cascade deletes** — deleting a task cascades to SOPs, which cascade to tags, executions, and versions
4. **No daemon** — everything is on-demand; observation uses a foreground polling loop, not a background service
5. **Cartography is optional** — the peer dependency is marked optional; SOPs work without infrastructure context
6. **Cross-platform from day one** — window detection and shell history have platform-specific implementations for Linux, macOS, and Windows
7. **Privacy by default** — consent must be explicitly granted, exclusion rules are respected, old data degrades automatically
