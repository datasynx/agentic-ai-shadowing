# Implementation Plan — @datasynx/agentic-ai-shadowing v0.1.0

## Analysis: Current State vs. Target State

### Key Insight
The current repo contains the **old Shadow Daemon** from `@datasynx/agentic-ai-cartography` —
a system monitoring tool (TCP snapshots, processes, IPC daemon). The new specification describes
a **fundamentally different product**: an interactive, employee-driven task tracking tool
with SOP generation, HTML frontend, and export engine.

**Consequence:** All source files (`src/*.ts`) will be completely replaced. The following will be kept:
- Build infrastructure: `tsconfig.json`, `tsup.config.ts`, `.gitignore`
- Project metadata: `LICENSE`, `CLAUDE.md`
- `package.json` (will be modified: new dependencies, different binaries)

### Old Files → Decision

| File | Action | Reason |
|------|--------|--------|
| `src/daemon.ts` | **Delete** | No daemon concept in new spec |
| `src/ipc.ts` | **Delete** | No IPC/Unix socket needed |
| `src/client.ts` | **Delete** | No attach/foreground client |
| `src/notify.ts` | **Delete** | No desktop notifications in MVP |
| `src/agent.ts` | **Delete** | Completely different SOP generation |
| `src/types.ts` | **Delete** | Completely new type system |
| `src/cli.ts` | **Delete** | Completely different CLI commands |
| `src/index.ts` | **Delete** | New public API |
| `test/ipc.test.ts` | **Delete** | IPC no longer exists |
| `docs/SHADOW_SPEC.md` | **Replace** | With new product specification |

---

## Implementation Steps (Phase 1 — MVP)

### Step 1: Project Restructuring
**Goal:** Remove old files, update dependencies, create new directory structure.

**1.1 Delete old source files:**
- Delete all `src/*.ts`
- Delete `test/ipc.test.ts`

**1.2 Update `package.json`:**
- Binary `datasynx-shadow` → `shadowing`
- Remove `node-notifier` (not in MVP)
- Remove `@anthropic-ai/claude-code` (use `@anthropic-ai/sdk` directly)
- Add `@inquirer/prompts` (interactive terminal prompts)
- Add `express` (REST API for frontend, prepare for Phase 2)
- `marked` + `dompurify` NOT yet (Phase 2)
- Set `engines.node` to `>=20`
- Remove peer dependency on `@datasynx/agentic-ai-cartography` (optional in new spec)

**1.3 Update `CLAUDE.md`** with new project description

**1.4 Replace `docs/SHADOW_SPEC.md`** with new product specification

**1.5 Replace `docs/tasks.md`** with new task list

**1.6 New directory structure:**
```
src/
├── cli.ts              # Commander CLI (main entry)
├── index.ts            # Public API
├── db.ts               # SQLite schema + database class
├── types.ts            # All TypeScript types
├── config.ts           # Config management (~/.datasynx/shadowing/config.json)
├── task-manager.ts     # Task lifecycle (start, pause, complete, cancel)
├── sop-generator.ts    # Claude SDK SOP generation
├── metrics.ts          # Metrics calculation (scores)
├── anonymizer.ts       # PII detection and redaction
├── exporter.ts         # Markdown export with manifest
└── ui-server.ts        # Express REST server + HTML frontend (Phase 2 preparation)
test/
├── db.test.ts
├── task-manager.test.ts
├── sop-generator.test.ts
├── metrics.test.ts
├── anonymizer.test.ts
└── exporter.test.ts
```

**1.7 Verify build:** `npm install && npm run lint && npm run build`

---

### Step 2: `src/types.ts` — Type System
**Goal:** Define all interfaces and Zod schemas from the DB spec (Section 4).

**Define:**
- `Task` interface (id, title, description, status, started_at, completed_at, duration_seconds, created_at, updated_at)
- `TaskStatus` type: `'active' | 'paused' | 'completed' | 'cancelled'`
- `SOP` interface (id, task_id, title, description, content_md, version, status, ai_generated, reviewed_at, exported_at, created_at, updated_at)
- `SOPStatus` type: `'draft' | 'reviewed' | 'approved' | 'exported' | 'archived'`
- `Tag` interface (id, name)
- `SOPTag` interface (sop_id, tag_id, ai_generated)
- `TaskExecution` interface (id, sop_id, duration_seconds, complexity_rating, notes, executed_at)
- `ExportRecord` interface (id, exported_at, sop_count, export_path, anonymized)
- `ShadowingConfig` interface (from Section 10.1)
- `SOPMetrics` interface (execution_count, avg_duration, median_duration, min_duration, max_duration, std_deviation, cv, avg_complexity, consistency_score, maturity_score, freshness_score)
- `GlobalStats` interface

---

### Step 3: `src/config.ts` — Configuration Management
**Goal:** Read/write `~/.datasynx/shadowing/config.json` with defaults.

**Functions:**
- `getConfigDir(): string` → `~/.datasynx/shadowing/`
- `getDefaultConfig(): ShadowingConfig` → Defaults from spec Section 10.1
- `loadConfig(): ShadowingConfig` → reads config.json or creates with defaults
- `saveConfig(config: ShadowingConfig): void`
- `getDbPath(): string` → `~/.datasynx/shadowing/shadowing.db`

**Defaults:**
- `polling_interval_minutes: 15`
- `editor: "code"` (VS Code)
- `ui_port: 3847`
- `sop_generation.model: "claude-sonnet-4-20250514"`
- `sop_generation.temperature: 0.3`
- `sop_generation.sop_language: "en"`
- `anonymization.*`: all true

---

### Step 4: `src/db.ts` — SQLite Database
**Goal:** better-sqlite3 wrapper with the schema from Section 4.1.

**Class: `ShadowingDB`**

**Schema migration (in `initialize()`):**
- `tasks` table
- `sops` table
- `tags` table
- `sop_tags` table
- `task_executions` table
- `exports` table
- `export_sops` table
- All indexes

**Methods — Tasks:**
- `createTask(title: string, description?: string): Task`
- `getTask(id: string): Task | null`
- `getActiveTask(): Task | null`
- `listTasks(filter?: { status?: TaskStatus }): Task[]`
- `updateTask(id: string, updates: Partial<Task>): Task`
- `completeTask(id: string): Task` — sets status, completed_at, calculates duration_seconds
- `pauseTask(id: string): Task`
- `resumeTask(id: string): Task`
- `cancelTask(id: string): Task`
- `deleteTask(id: string): void`

**Methods — SOPs:**
- `createSOP(taskId: string, data: { title, description, content_md, tags?: string[] }): SOP`
- `getSOP(id: string): SOP | null`
- `listSOPs(filter?: { status?, tag?, search? }): SOP[]`
- `updateSOP(id: string, updates: Partial<SOP>): SOP` — increments version on content_md change
- `updateSOPStatus(id: string, status: SOPStatus): SOP`
- `deleteSOP(id: string): void`

**Methods — Tags:**
- `getOrCreateTag(name: string): Tag`
- `addTagToSOP(sopId: string, tagName: string, aiGenerated?: boolean): void`
- `removeTagFromSOP(sopId: string, tagId: string): void`
- `listTags(): Tag[]`
- `getTagsForSOP(sopId: string): (Tag & { ai_generated: boolean })[]`

**Methods — Executions:**
- `logExecution(sopId: string, data: { duration_seconds, complexity_rating?, notes? }): TaskExecution`
- `getExecutions(sopId: string): TaskExecution[]`

**Methods — Exports:**
- `logExport(data: { sop_count, export_path, sop_ids: string[] }): ExportRecord`
- `getExports(): ExportRecord[]`

**Methods — Stats:**
- `getGlobalStats(): GlobalStats`

**Tests:** `test/db.test.ts`
- Table creation
- CRUD for tasks, SOPs, tags
- Task lifecycle (active → paused → active → completed)
- SOP versioning
- Tag assignment
- Execution logging

---

### Step 5: `src/task-manager.ts` — Task Lifecycle
**Goal:** Orchestrates task lifecycle and interactive prompts.

**Class: `TaskManager`**

Requires: `ShadowingDB`, `ShadowingConfig`

**Methods:**
- `startTask(title: string, description?: string): Task` — checks if an active task already exists
- `pauseTask(): Task` — pauses the active task
- `resumeTask(): Task` — resumes a paused task
- `completeTask(complexityRating?: number): { task: Task; duration: string }` — completes task, formats duration
- `cancelTask(): Task`
- `getActiveTask(): Task | null`
- `addNote(note: string): void` — saves note to the active task (appended to description)

**Helper functions:**
- `formatDuration(seconds: number): string` — "1h 23min 45s"

**Tests:** `test/task-manager.test.ts`
- Start/complete flow
- Pause/resume
- Error when no active task
- Error on duplicate start

---

### Step 6: `src/sop-generator.ts` — Claude SOP Generation
**Goal:** Generates SOPs via Anthropic Messages API based on task data.

**Class: `SOPGenerator`**

Requires: `ShadowingConfig`, `ShadowingDB`

**Methods:**
- `generateSOP(task: Task, notes?: string[]): Promise<{ title, description, content_md, tags }>` — System prompt from spec Section 6.1, Cartography graph as optional context
- `regenerateSOP(sopId: string): Promise<SOP>` — Regenerate SOP from task data

**Prompt construction:**
- System prompt defines role, rules, Markdown structure (Section 4.2)
- User prompt contains: task title, description, duration, notes, complexity, optional Cartography graph
- Response parsing: Markdown content + tags array from structured output

**AI tag generation:**
- Extract tags from generated content
- Categories: department, tool/system, process type, frequency, complexity (Section 6.2)

**Tests:** `test/sop-generator.test.ts`
- Test prompt construction (without API call)
- Test response parsing (mock response)
- Tag extraction

---

### Step 7: `src/metrics.ts` — Metrics Calculation
**Goal:** Calculate quality scores from execution data (Section 7).

**Functions:**
- `calculateSOPMetrics(db: ShadowingDB, sopId: string): SOPMetrics`
  - Execution statistics: count, avg, median, min, max, stddev, CV
  - avg_complexity from task_executions
- `calculateConsistencyScore(cv: number): number` — `max(0, 100 - (cv * 2))`
- `calculateMaturityScore(sop: SOP, executionCount: number, hasReview: boolean, revisionCount: number, hasTags: boolean, hasDescription: boolean): number` — weighted score
- `calculateFreshnessScore(sop: SOP, avgFrequencyDays: number): number` — freshness based on review age and frequency
- `calculateOverallQualityScore(consistency, maturity, freshness, weights): number`

**Tests:** `test/metrics.test.ts`
- Consistency score at various CVs
- Maturity score at various combinations
- Freshness score
- Edge cases (0 executions, no reviews)

---

### Step 8: `src/anonymizer.ts` — PII Detection and Redaction
**Goal:** Export anonymization according to Section 9.2.

**Class: `Anonymizer`**

Requires: `ShadowingConfig.anonymization`

**Methods:**
- `anonymize(text: string): string` — applies all rules
- Private methods:
  - `redactEmails(text: string): string` — `[email@example.com]`
  - `redactIPs(text: string): string` — `[internal-ip]`
  - `redactURLs(text: string): string` — generalize domain
  - `redactPhoneNumbers(text: string): string` — `[phone-number]`
  - `redactFilePaths(text: string): string` — `/Users/[user]/...`
  - `applyCustomReplacements(text: string): string` — from config

**Regex patterns:**
- Email: `/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g`
- IP: `/\b(?:\d{1,3}\.){3}\d{1,3}\b/g`
- URL: `/https?:\/\/[^\s)]+/g`
- Phone: `/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g`
- File paths: `/(?:\/Users\/|\/home\/|C:\\Users\\)[^\s"')]+/g`

**Tests:** `test/anonymizer.test.ts`
- Each PII type individually
- Custom replacements
- Text without PII remains unchanged
- Markdown structure remains intact

---

### Step 9: `src/exporter.ts` — Markdown Export
**Goal:** Anonymized export as Markdown files + manifest.json (Section 9.1).

**Class: `Exporter`**

Requires: `ShadowingDB`, `Anonymizer`, `ShadowingConfig`

**Methods:**
- `exportSOPs(sopIds: string[]): ExportResult` — Creates export directory
  1. Create directory: `~/.datasynx/shadowing/exports/export_YYYY-MM-DD_HH-mm/`
  2. For each SOP: Anonymize → write `sops/sop_NNN.md`
  3. Calculate metrics per SOP
  4. Write `manifest.json` (format from Section 9.1)
  5. Log export in DB
  6. Return path
- `exportAll(): ExportResult` — all SOPs with status='approved'
- `getExportHistory(): ExportRecord[]`

**Tests:** `test/exporter.test.ts`
- Export directory structure
- manifest.json format
- Anonymization is applied
- Export logging in DB

---

### Step 10: `src/cli.ts` — Commander CLI
**Goal:** Implement all CLI commands from Section 5.4.

**Binary:** `shadowing` (in package.json `bin`)

**Commands:**

**`shadowing init`**
- Create config directory
- Initialize DB
- Create config.json with defaults
- Success message

**`shadowing start`** (interactive task loop)
- Checks if DB is initialized
- Asks: "Are you starting a new task?"
- If yes: request title + optional description
- Loop: Every `config.polling_interval_minutes` minutes ask: "Are you still on the same task?"
- Options: [1] Complete task → generate SOP, [2] Pause, [3] Cancel, [4] Add note, [5] New task
- On completion: request complexity (1-5) → generate SOP → show review options

**`shadowing status`**
- Show current task (if active)
- Statistics: number of tasks, SOPs, last activity

**`shadowing list`**
- SOPs as table: ID (short), title, status, tags, date
- Options: `--status <status>`, `--tag <tag>`, `--search <query>`

**`shadowing show <sop-id>`**
- Render SOP Markdown in terminal (output content_md)
- Metadata: tags, version, status, metrics

**`shadowing edit <sop-id>`**
- Write SOP to temporary file
- Open default editor (`$EDITOR` or config.editor)
- After closing: save changes to DB, increment version

**`shadowing delete <sop-id>`**
- Confirmation prompt
- Delete SOP (CASCADE deletes tags, executions)

**`shadowing tag <sop-id> <tags...>`**
- Add tags (with `+tag`) or remove tags (with `-tag`)

**`shadowing stats`**
- Global statistics in terminal
- Top 5 most frequent tasks
- Quality score overview

**`shadowing export`**
- Interactive: show SOPs for selection (checkbox)
- Preview anonymization
- Confirmation → export

**`shadowing export --all`**
- Export all approved SOPs

**`shadowing import-graph <path>`**
- Import Cartography graph (JSON) and store in config

**`shadowing config`**
- Open config in editor

**`shadowing reset`**
- Confirmation prompt ("Are you sure? All data will be deleted.")
- Delete DB + config

---

### Step 11: `src/index.ts` — Public API
**Goal:** Clean re-exports for programmatic usage.

**Exports:**
- `ShadowingDB`
- `TaskManager`
- `SOPGenerator`
- `Anonymizer`
- `Exporter`
- All types
- `loadConfig`, `getDefaultConfig`
- Metrics functions

---

### Step 12: Update `tsup.config.ts`
**Goal:** Correctly configure CLI binary + library entry.

- CLI entry: `src/cli.ts` → `dist/cli.js` (with shebang)
- Library entry: `src/index.ts` → `dist/index.js` + `dist/index.d.ts`

---

### Step 13: Build, Lint, Test, Smoke Test
**Goal:** Everything builds, all tests green, CLI works.

- `npm run lint` — TypeScript without errors
- `npm run test` — all tests green
- `npm run build` — dist/ correct
- `npx tsx src/cli.ts init` → DB is created
- `npx tsx src/cli.ts status` → shows "No active task"
- `npx tsx src/cli.ts list` → shows empty list

---

### Step 14: Update Documentation
**Goal:** README.md, CLAUDE.md, docs/ up to date.

- `README.md` — new project description, installation, CLI commands
- `CLAUDE.md` — new coding rules, commands
- `docs/tasks.md` — update task list (mark Phase 1 as completed)
- `docs/PRODUCT_SPEC.md` — store product specification

---

### Step 15: Commit & Push
- Clean commit with all changes
- Push to feature branch

---

## Step Dependency Graph

```
Step 1 (Restructuring)
    │
    ├── Step 2 (types.ts) ─────────────────┐
    │                                       │
    ├── Step 3 (config.ts) ────────────────┤
    │                                       │
    └── Step 4 (db.ts) ◄──────────────────┤
         │                                  │
         ├── Step 5 (task-manager.ts) ◄────┘
         │        │
         │        └── Step 6 (sop-generator.ts)
         │
         ├── Step 7 (metrics.ts)
         │
         ├── Step 8 (anonymizer.ts)
         │        │
         │        └── Step 9 (exporter.ts)
         │
         └─── All ──► Step 10 (cli.ts)
                           │
                           ├── Step 11 (index.ts)
                           ├── Step 12 (tsup.config.ts)
                           ├── Step 13 (Build/Test)
                           ├── Step 14 (Docs)
                           └── Step 15 (Commit/Push)
```

## Estimated Files & Scope

| File | ~LOC | Complexity |
|------|------|------------|
| `src/types.ts` | 120 | Low |
| `src/config.ts` | 80 | Low |
| `src/db.ts` | 350 | Medium |
| `src/task-manager.ts` | 100 | Low |
| `src/sop-generator.ts` | 150 | Medium |
| `src/metrics.ts` | 120 | Medium |
| `src/anonymizer.ts` | 100 | Low |
| `src/exporter.ts` | 120 | Low |
| `src/cli.ts` | 350 | High |
| `src/index.ts` | 30 | Low |
| Tests (total) | 400 | Medium |
| **Total** | **~1920** | |

## Out of Scope (Phase 2+)

- HTML frontend + REST API server (`shadowing ui`)
- SOP editor with Markdown preview in browser
- Version history / diff view
- Heatmap / trend charts
- NER-based anonymization
- Cartography graph context usage (will be prepared but not fully implemented)
- `shadowing config` (config editor) — will be implemented as a stub
