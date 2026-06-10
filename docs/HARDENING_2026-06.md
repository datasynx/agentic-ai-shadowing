# Enterprise-Hardening & MCP-Modernisierung — Umsetzungsdokumentation

**Zeitraum:** Juni 2026 · **Releases:** v1.1.0 → v1.12.x (vollautomatisch via semantic-release)
**Roadmap & Decision Log:** [Issue #31](https://github.com/datasynx/agentic-ai-shadowing/issues/31)
**Verifikation:** siehe [`TEST_REPORT.md`](../TEST_REPORT.md) (E2E-Durchstich 2026-06-10)

Alle 16 Issues wurden umgesetzt, getestet und geschlossen. Diese Datei ist die
konsolidierte Referenz: was wurde gebaut, warum, und wo es im Code lebt.

---

## P1 · Trust & Safety (v1.1.0)

### [#21](https://github.com/datasynx/agentic-ai-shadowing/issues/21) — Always-on Secret-Redaction
Nicht abschaltbare Erkennung für GitHub-Tokens (`ghp_`, `gho_`, `github_pat_`),
Anthropic-/generische API-Keys (`sk-ant-`, `sk-`), AWS Access Key IDs +
Secrets-Manager-ARNs, Slack-Tokens (`xox?-`), JWTs, `Bearer`-Header-Werte und
PEM-Private-Key-Blöcke. Konservativer Entropie-Fallback
(`redact_high_entropy`) mit Ausnahmen für Git-SHAs, UUIDs und gewöhnliche
Bezeichner. — `src/anonymizer.ts`, Korpus in `test/anonymizer-secrets.test.ts`.

### [#20](https://github.com/datasynx/agentic-ai-shadowing/issues/20) — Redact-on-Capture
PII und Secrets werden **vor** dem SQLite-Write entfernt (Default an:
`anonymization.redact_on_capture`). Abgedeckt: Window-Titel, Shell-Kommandos,
Dateipfade, Task-Titel/-Beschreibungen und Notizen. Die Pipeline ist
idempotent; `shadowing scrub` redigiert Datenbanken älterer Versionen
retroaktiv. Export-Anonymisierung bleibt als zweite Schicht bestehen.
Bugfix im Zuge der Umsetzung: Regex-Backtracking im E-Mail-Redactor.
*Follow-up 2026-06-10:* Task-Titel/-Beschreibung wurden initial nur über
`TaskManager.addNote` abgedeckt — die Redaction sitzt jetzt zentral in
`db.createTask()`/`db.updateTask()` und greift damit für alle Eintrittspfade
(CLI, MCP, Hook-Handler). — `src/db.ts`, `src/anonymizer.ts`
(`createCaptureRedactor`), `test/redact-on-capture.test.ts`.

### [#18](https://github.com/datasynx/agentic-ai-shadowing/issues/18) — Dashboard-XSS-Härtung
Tag-Namen waren real injizierbar. Unit-testbare Escaping-Schicht: `esc`
(quote-sicher) für HTML-Kontexte, `escJs` für Inline-Handler. —
`src/dashboard-client.ts`, Payload-Korpus in `test/dashboard-xss.test.ts`.

### [#19](https://github.com/datasynx/agentic-ai-shadowing/issues/19) — CORS-Lockdown
Kein Wildcard mehr: Same-Origin erlaubt, Cross-Origin standardmäßig 403,
explizite Allowlist über `ui_allowed_origins`. Zusätzlich Bearer-Token-Pflicht
auf allen `/api/*`-Routen. — `src/ui-server.ts`, `test/ui-server-cors.test.ts`.

---

## P2 · Core-Modernisierung (v1.2–v1.5)

### [#22](https://github.com/datasynx/agentic-ai-shadowing/issues/22) — Migration auf `@modelcontextprotocol/sdk` v1.29
Ablösung des handgerollten MCP-Servers (Protokoll 2024-11-05) durch das
offizielle SDK (Spec bis 2025-11-25): Zod-Schemas, `outputSchema` +
`structuredContent`, Tool-Annotations, Server-Instructions. Toolnamen blieben
stabil; stdout-Purity ist test-gesichert. SDK bewusst auf **v1 gepinnt**
(v2 erst nach GA, siehe Decision Log). — `src/mcp-server.ts`,
`test/mcp-server-sdk.test.ts`.

### [#25](https://github.com/datasynx/agentic-ai-shadowing/issues/25) — SOP-Generierung via Tool-use Structured Output
Das Modell befüllt ein `emit_sop`-Tool-Schema statt Freitext; lenienter
Text-Fallback mit WARN-Logging (laut, nie still). Abschaltbar über
`sop_generation.use_structured_output`. *Follow-up 2026-06-10:* auch der
Session-Analyzer (`shadowing analyze`) nutzt jetzt denselben Tool-Vertrag —
`SOP_TOOL_DEFINITION`/`extractStructuredSOP` sind aus `sop-generator.ts`
exportiert und werden wiederverwendet. — `src/sop-generator.ts`,
`src/session-analyzer.ts`, `test/sop-generator-structured.test.ts`,
`test/session-analyzer.test.ts`.

### [#26](https://github.com/datasynx/agentic-ai-shadowing/issues/26) — `base_url` + `api_key_env`
Konfigurierbarer API-Endpoint und Credential-Env-Var für Enterprise-Gateways
und lokale Modelle → verifizierbares No-Egress-Deployment. Der E2E-Test fährt
die komplette SOP-Pipeline gegen einen lokalen Mock-Endpoint. —
`src/anthropic-client.ts`, `src/config.ts`.

### [#24](https://github.com/datasynx/agentic-ai-shadowing/issues/24) — `setup-hooks` neu
Korrektes (nested) Hook-Schema mit Timeout, MCP-Registrierung über `.mcp.json`
statt `settings.json`, `--scope`/`--dry-run`/`--uninstall`, fail-safe bei
korruptem JSON (vorher: Clobber-Bug). Idempotent, immer mit Diff. —
`src/claude-setup.ts`, `test/claude-setup.test.ts`.

---

## P3 · Distribution & Differenzierung (v1.6–v1.12)

### [#33](https://github.com/datasynx/agentic-ai-shadowing/issues/33) — Claude-Code-Plugin
Manifest + Hooks + MCP-Server + Skill in einem Install — der empfohlene
Distributionsweg. Dedupe-Guard verhindert Doppel-Registrierung neben
`setup-hooks`. — `plugin/`, `test/plugin-structure.test.ts`.

### [#32](https://github.com/datasynx/agentic-ai-shadowing/issues/32) — MCP-Registry
`server.json` + `mcpName` (`io.github.datasynx/agentic-ai-shadowing`), Version
release-synchronisiert, non-blocking Publish-Step via OIDC im Release-Workflow.
— `server.json`, `test/server-json.test.ts`.

### [#27](https://github.com/datasynx/agentic-ai-shadowing/issues/27) — Harness-Adapter (`shadowing setup`)
CLI-first-Registrierung für Codex, OpenClaw und Hermes (Fremd-Configs werden
nie direkt geschrieben) plus Managed-Section in `AGENTS.md` (<1 KiB, unterhalb
des 32-KiB-Caps von Codex). — `src/harness.ts`, `test/harness.test.ts`.

### [#28](https://github.com/datasynx/agentic-ai-shadowing/issues/28) — `shadowing publish`
Approved SOPs → agentskills.io-kompatible SKILL.md bzw. AGENTS.md-Index
(≤2 KiB). Approval-Gate, Diff + Confirm vor jedem Write, Re-Anonymisierung beim
Publish, `{{Variablen}}`-Parametrisierung. — `src/sop-publisher.ts`,
`test/sop-publisher.test.ts`.

### [#23](https://github.com/datasynx/agentic-ai-shadowing/issues/23) — Streamable-HTTP-Transport
`shadowing mcp --http`: stateless, Loopback-Default, Origin-Validierung,
Token-Pflicht off-loopback. — `src/mcp-server.ts`, `test/mcp-http.test.ts`.

### [#30](https://github.com/datasynx/agentic-ai-shadowing/issues/30) — `shadowing_review_sop`
Elicitation-basiertes In-Session-Approval, strikt capability-gated (nur wenn
der Client Elicitation unterstützt). — `test/mcp-elicitation.test.ts`.

### [#34](https://github.com/datasynx/agentic-ai-shadowing/issues/34) — Pagination + MCP-Resources
Listen-Tools paginieren (max. 200/Page, `next_cursor`); Read-only-Resources
`shadowing://stats` und approved SOPs. Tool-Konsolidierung bewusst auf v2
verschoben. — `src/mcp-server.ts`.

### [#29](https://github.com/datasynx/agentic-ai-shadowing/issues/29) — Task-Boundary-Heuristiken + File-Watching
Idle-Gap-, Branch-Switch- und cwd-Wechsel-Erkennung als Boundary-Vorschläge;
optionales File-Watching (chokidar) — consent-gated, **off by default**. —
`src/segmentation.ts`, `src/file-watcher.ts`.

---

## Zentrale Entscheidungen (Decision Log, #31)

- MCP SDK **v1 gepinnt** — v2 erst nach GA (~Q3 2026)
- **Kein PTY-Capture**, Recording **opt-in**, **keine Telemetrie**
- **Redact-by-default** auf Capture- UND Export-Ebene
- **Keine stillen Schreibzugriffe** auf Agent-Kontext: immer Diff + Confirm,
  immer deinstallierbar, immer idempotent
- Harness-Adapter **CLI-first** (Fremd-Configs nie direkt schreiben)
- Distributionspriorität: **Plugin > Registry > setup-hooks**

## Offene Punkte (extern, als Issues getrackt)

- [#35](https://github.com/datasynx/agentic-ai-shadowing/issues/35) —
  Plugin-Marketplace-Submission (braucht Owner-Account)
- [#36](https://github.com/datasynx/agentic-ai-shadowing/issues/36) —
  ✅ erledigt (2026-06-10): erster Lauf (v1.12.1) war still mit HTTP 422
  fehlgeschlagen (`description` > 100 Zeichen). Fix in `d4b2690`
  (Description gekürzt + Regressionstest in `test/server-json.test.ts`),
  v1.12.2 ist erfolgreich in der MCP Registry publiziert.
- [#37](https://github.com/datasynx/agentic-ai-shadowing/issues/37) —
  Watch: MCP SDK v2 GA inkl. der aus #34 verschobenen Tool-Konsolidierung
- [#38](https://github.com/datasynx/agentic-ai-shadowing/issues/38) —
  Watch: SEP-2640 (Skills over MCP) → Auswirkung auf die Publish-Pipeline
- [#39](https://github.com/datasynx/agentic-ai-shadowing/issues/39) —
  Watch: OpenClaw/Hermes/Codex-Config-Churn, CLI-first-Adapter aktuell halten

---

## Nachtrag 2026-06-10 — CI/CD-Wartung

- **#36 abgeschlossen** (siehe oben): MCP-Registry-Publish verifiziert; der
  Registry-Step emittiert bei Fehlschlag jetzt eine `::warning::`-Annotation
  auf der Run-Summary, statt (wie beim ersten Lauf) per `continue-on-error`
  vollständig still zu bleiben. — `.github/workflows/release.yml`.
- **Node-20-Runner-Deprecation** (Zwangsumstellung auf Node 24 ab
  2026-06-16): alle First-Party-Actions auf die Node-24-Majors gehoben —
  `checkout@v6`, `setup-node@v6`, `upload-artifact@v6`, `configure-pages@v6`,
  `upload-pages-artifact@v5`, `deploy-pages@v5`. —
  `.github/workflows/{ci,release,pages}.yml`.
- **Node 24 (aktuelles LTS) in die CI-Test-Matrix** aufgenommen (`20/22/24`);
  Quality-/Build-Jobs bleiben bewusst auf Node 20 (= `engines`-Minimum).
- **`bin`-Pfad in `package.json` normalisiert** (`./dist/cli.js` →
  `dist/cli.js`): beseitigt die irreführende `npm warn publish
  "bin[shadowing]" … invalid and removed`-Warnung. Das publizierte Paket war
  funktional nie betroffen (verifiziert: `npx @datasynx/agentic-ai-shadowing@1.12.2
  --version` → `1.12.2`, `bin` im Registry-Manifest vorhanden).

### Runde 2: Supply-Chain & Governance

- **Dependabot** (`.github/dependabot.yml`): wöchentliche Updates für npm
  (Minor/Patch gruppiert, Majors einzeln) und GitHub Actions — hält u. a.
  die Node-24-Action-Pins automatisch aktuell.
- **CodeQL-SAST** (`.github/workflows/codeql.yml`): `javascript-typescript`,
  Push/PR auf `main` + wöchentlicher Schedule, `codeql-action@v4`.
- **`SECURITY.md`**: Private Vulnerability Reporting, Support-Policy (nur
  letztes Release), Scope-Hinweise (Redaction-Bypässe = high severity).
- **TASK-08 vervollständigt**: Input-Limits jetzt zentral im DB-Layer
  (`db.createTask/updateTask/createSOP/updateSOP`) statt nur in der
  REST-API — deckt CLI, MCP und Hook-Handler ab. Neu:
  `test/db-input-limits.test.ts` (13 Tests).
- **TASK-01 vervollständigt**: letzte `process.stderr.write`-Reste in
  `mcp-server.ts` und `config.ts` auf den strukturierten Logger migriert;
  `cartography-check.ts` bleibt als dokumentierte CLI-Guidance-Ausnahme.
- **`docs/ENTERPRISE_TASKS.md`**: Status-Abgleich — alle 14 Tasks des
  Evaluation-Reports sind umgesetzt und referenziert.

### Runde 3: Dependency-Modernisierung → v2.0.0

- **Node 20 gedroppt** (EOL seit 2026-04-30): `engines.node >= 22.12.0`,
  CI-Matrix `22/24`. Auslöser: commander 15 verlangt ≥ 22.12 — ein Paket,
  das Node-20-Support verspricht, dessen Deps aber 22.12 voraussetzen, wäre
  unehrliche Metadata. **Breaking Change → Major-Release.**
- **Dependabot-Welle als ein atomarer Commit** statt sechs einzelner PRs
  (vermeidet sequenzielle Lockfile-Rebases): zod 4.4 (Migration:
  `z.record(key, value)`, `.default({})` → `.prefault({})`),
  commander 15, @inquirer/prompts 8.5, upload-artifact v7, Minor/Patch-Welle
  via `npm update`. Die PRs #40–#45 wurden als superseded geschlossen.
- **`@types/node` bewusst auf ^22 gepinnt** (= älteste unterstützte
  Runtime) + Dependabot-Ignore für Majors: neuere Typen würden tsc APIs
  durchwinken, die auf der Mindest-Node nicht existieren.
