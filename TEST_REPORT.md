# Testreport — @datasynx/agentic-ai-shadowing v1.12.x

**Datum:** 2026-06-10
**Tester:** End-to-End-Verifikation nach Enterprise-Hardening (v1.1.0–v1.12.x)
**Node:** v22.22.2 | TypeScript 5.7+ | Vitest 3.x

> Ersetzt den Report vom 2026-02-25 (v0.1.0). Der alte Stand ist über die
> Git-Historie abrufbar. Die dort gemeldeten Bugs (BUG-001–004) sind im Zuge
> des Hardenings behoben worden.

---

## 1. Zusammenfassung

| Kategorie | Ergebnis |
|-----------|----------|
| `npm install` | OK — 0 Vulnerabilities |
| `tsc --noEmit` (Lint) | OK — keine Fehler |
| `tsup` Build | OK — CLI 211 KB, Library + Types |
| Unit-/Integrationstests | **1295/1295 bestanden** (64 Dateien) |
| E2E (CLI + MCP stdio + MCP HTTP + UI-Server) | bestanden (Details unten) |
| **Gesamtergebnis** | **BESTANDEN** — 2 Befunde gefunden und im selben Lauf behoben |

---

## 2. E2E-Testumfang

Vollständiger Durchstich in isoliertem `$HOME` gegen den gebauten `dist/cli.js`,
SOP-Generierung gegen einen lokalen Mock-Anthropic-Endpoint via
`sop_generation.base_url` + `api_key_env` (No-Egress-Verifikation des
Enterprise-Gateway-Features aus #26).

| Pfad | Getestet | Ergebnis |
|------|----------|----------|
| `init` → Verzeichnis-/DB-/Config-Anlage | ✓ | OK |
| `status`, `list`, `show`, `stats`, `guide` | ✓ | OK |
| MCP stdio: `initialize` (Protokoll 2025-06-18), `tools/list` (18 Tools), `resources/list` (`shadowing://stats`) | ✓ | OK |
| MCP: Task-Lifecycle (`start_task` → `get_status` → `complete_task`) | ✓ | OK (Befund 1, s. u.) |
| MCP: Observation-Session (`start_observation`, 4× `log_observation`, `stop_observation`) | ✓ | OK — Redact-on-Capture greift (Token/E-Mail vor SQLite-Write ersetzt) |
| MCP: Schema-Validierung (ungültige `source`-Enum, fehlende Pflichtfelder) | ✓ | korrekt abgelehnt |
| `analyze <session>` → Task-Erkennung → SOP-Generierung (Mock-API) | ✓ | OK (Befund 2, s. u.) |
| MCP: `update_sop`, `add_tags`, `approve_sop`, `export_sops` | ✓ | OK |
| Export: Anonymisierung (E-Mail, IP, URL, Pfad, GitHub-Token), `manifest.json` mit `redaction_summary` | ✓ | **0 Leaks** im Exportverzeichnis |
| `shadowing scrub` (retroaktive Redaction) | ✓ | OK — verseuchter Alt-Datensatz bereinigt, idempotent |
| UI-Server: Bearer-Token-Pflicht (401 ohne Token), CORS-Lockdown (403 cross-origin, same-origin OK), Token-Durchstich `/api/stats`, `/api/sops` | ✓ | OK |
| MCP Streamable HTTP: Loopback-POST 200, fremde Origin 403, GET 405 | ✓ | OK |
| `setup --dry-run`, `setup-hooks --dry-run` (Diff-Ausgabe, kein Write) | ✓ | OK |
| Unique-Active-Task-Constraint (zweiter aktiver Task abgelehnt) | ✓ | OK |

---

## 3. Befunde und Behebung (in diesem Lauf gefixt)

### Befund 1 (P1, Security): Redact-on-Capture griff nicht für Task-Titel/-Beschreibung

**Symptom:** `shadowing_start_task` (MCP) bzw. Task-Anlage generell persistierte
GitHub-Token, E-Mail-Adresse und interne IP **unredigiert** in SQLite. Nur
Notizen (`TaskManager.addNote`) und Observations waren abgedeckt — im
Widerspruch zur Zusage „Secrets never persisted" (#20/#21).

**Fix:** Redaction zentral in die DB-Schicht verlagert: `db.createTask()` und
`db.updateTask()` wenden jetzt den installierten Capture-Redactor auf Titel und
Beschreibung an. Damit sind alle Eintrittspfade abgedeckt (CLI, MCP inkl.
`complete_task`-Notes-Append, Hook-Handler, Session-Analyzer). Opt-out
(`redact_on_capture: false`) bleibt funktional. `shadowing scrub` bereinigt
Alt-Datenbanken weiterhin retroaktiv (im Lauf verifiziert).

**Tests:** 3 neue Tests in `test/redact-on-capture.test.ts`
(createTask/updateTask/Opt-out). Retest des Original-Szenarios via MCP:
`Mail an [email@example.com], Token [github-token], Server [internal-ip]` —
0 leckende Zeilen in der DB.

### Befund 2 (P2, Konsistenz): Session-Analyzer nutzte den strukturierten Tool-use-Output nicht

**Symptom:** Die SOP-Generierung über `shadowing analyze`
(`SessionAnalyzer.generateSOPFromCluster`) lief noch über Freitext + lenienten
Parser — Issue #25 (Structured Output via `emit_sop`-Tool) war nur im
`SOPGenerator` gelandet. Folge: WARN-Logs („No tags found / No title heading"),
fehlende Tags, fragiles Parsing.

**Fix:** Tool-Definition und Extraktion (`SOP_TOOL_NAME`, `SOP_TOOL_DEFINITION`,
`extractStructuredSOP`) aus `sop-generator.ts` exportiert und im
Session-Analyzer wiederverwendet — gleicher Vertrag, gleicher lauter
Text-Fallback, `use_structured_output`-Config wird respektiert. Zusätzlich ist
der Client jetzt injizierbar (`AnthropicLikeClient`), analog zum SOPGenerator.

**Tests:** 3 neue Integrationstests in `test/session-analyzer.test.ts`
(Tool forciert + strukturierte Übernahme inkl. Tags, Text-Fallback,
`use_structured_output=false`). E2E-Retest gegen Mock: SOP-Request kommt als
Tool-use an, Titel/Tags stammen aus dem strukturierten Ergebnis, keine
Parser-Warnungen mehr.

---

## 4. Sicherheitsbewertung (Stand v1.12.x + Fixes)

| Aspekt | Bewertung | Verifikation |
|--------|-----------|--------------|
| Secrets-never-persisted (Tasks, Notizen, Observations) | OK | E2E + Testkorpus (`redact-on-capture.test.ts`, `anonymizer-secrets.test.ts`) |
| Export-Anonymisierung (zweite Schicht) | OK | E2E: 0 Leaks, `redaction_summary` im Manifest |
| Dashboard: Bearer-Auth + CORS-Lockdown + XSS-Escaping | OK | E2E (401/403) + `dashboard-xss.test.ts`, `ui-server-cors.test.ts` |
| MCP HTTP: Loopback-Default, Origin-Validierung, Token off-loopback | OK | E2E (200/403/405) + `mcp-http.test.ts` |
| Keine stillen Config-Writes (Diff + Confirm, `--dry-run`) | OK | E2E `setup`/`setup-hooks` Dry-Runs |
| Konfigurierbarer Endpoint (`base_url`) → No-Egress-Betrieb | OK | E2E komplett gegen lokalen Mock gefahren |

---

## 5. Fazit

Alle 16 Hardening-Issues (siehe `docs/HARDENING_2026-06.md`) sind umgesetzt und
im E2E-Durchstich verifiziert. Die beiden im Lauf gefundenen Lücken — eine
echte P1-Redaction-Lücke auf dem Task-Pfad und eine #25-Konsistenzlücke im
Session-Analyzer — wurden direkt behoben, mit Tests abgesichert (1289 → 1295)
und erneut end-to-end verifiziert.

**Empfehlung: Merge nach `main` (Release via semantic-release).**
