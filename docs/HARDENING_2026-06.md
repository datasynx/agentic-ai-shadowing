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
  ersten `mcp-publisher`-Registry-Lauf verifizieren (OIDC, Owner-Setup)
- [#37](https://github.com/datasynx/agentic-ai-shadowing/issues/37) —
  Watch: MCP SDK v2 GA inkl. der aus #34 verschobenen Tool-Konsolidierung
- [#38](https://github.com/datasynx/agentic-ai-shadowing/issues/38) —
  Watch: SEP-2640 (Skills over MCP) → Auswirkung auf die Publish-Pipeline
- [#39](https://github.com/datasynx/agentic-ai-shadowing/issues/39) —
  Watch: OpenClaw/Hermes/Codex-Config-Churn, CLI-first-Adapter aktuell halten
