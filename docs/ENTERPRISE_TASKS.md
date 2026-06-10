# Enterprise Readiness — Task-Spezifikation

> Erzeugt aus dem Enterprise npm Evaluation Report (2026-03-06).
> Gesamtbewertung Report: **7/10** — Conditional Approval.
> Alle Tasks sind Voraussetzung für eine produktive Enterprise-Nutzung.

---

## Status (2026-06-10): ✅ alle 14 Tasks umgesetzt

| Task | Umsetzung |
|------|-----------|
| TASK-01 Structured Logging | `src/logger.ts` (NDJSON via `LOG_FORMAT=json`, `LOG_LEVEL`), migriert inkl. `mcp-server`/`config`; einzige bewusste Ausnahme: CLI-Guidance in `cartography-check.ts` |
| TASK-02 SOP Audit-Trail | `audit_log`-Tabelle + Logging in `src/db.ts` |
| TASK-03 API Response Size Limit | `response_too_large`-Guard in `src/sop-generator.ts` |
| TASK-04 REST-API Auth | Bearer-Token (`SHADOWING_UI_TOKEN`/generiert) in `src/ui-server.ts` |
| TASK-05 Rate-Limiting | Sliding-Window + 429/`Retry-After` in `src/ui-server.ts` |
| TASK-06 Zentraler Error-Handler | zentrales Mapping inkl. `ShadowingError.httpStatus` in `src/ui-server.ts` |
| TASK-07 PII-Redaktion-Logging | `RedactionSummary` in `src/anonymizer.ts`, aggregiert im Export-Manifest |
| TASK-08 Input-Validierung | Zod-Limits in `src/ui-server.ts` **+ zentrale DB-Layer-Guards** in `src/db.ts` (Titel ≤ 500, Beschreibung ≤ 10 000, SOP-Content ≤ 500 000 Bytes; `test/db-input-limits.test.ts`) |
| TASK-09 Concurrency-Tests | `test/db-concurrency.test.ts` |
| TASK-10 API-Kosten-Tracking | `api_usage`-Tabelle, Stats-Aggregation |
| TASK-11 Performance-Metriken | `duration_ms` in `api_usage` |
| TASK-12 Error-Codes | `ShadowingError` + Code-Union in `src/errors.ts` |
| TASK-13 UI/MCP-Negative-Tests | `test/mcp-server-negative.test.ts`, `test/ui-server-enterprise.test.ts` |
| TASK-14 Request-Tracing | `X-Request-Id`-Generierung/-Propagation in `src/ui-server.ts` |

Die folgende Spezifikation bleibt als historische Referenz erhalten.

---

## TASK-01: Structured Logging mit Log-Levels und Timestamps einführen

| Feld | Inhalt |
|------|--------|
| **Typ** | Blocker |
| **Priorität** | P0 – Kritisch |
| **Komponente** | Observability |
| **Aufwand** | L |
| **Abhängigkeiten** | — |

### User Story

Als **Security & Compliance Officer** möchte ich, dass alle Anwendungsereignisse strukturiert und mit Zeitstempel protokolliert werden, damit ich im Audit-Fall nachvollziehen kann, was wann passiert ist und die Anwendung regulatorischen Anforderungen genügt.

### Hintergrund

Report-Abschnitt **Logging & Observability** bewertet mit 🔴 MINIMAL. Aktuell wird ausschließlich unstrukturierter Plaintext via `process.stderr.write()` ausgegeben (16 Dateien). Es existieren keine Log-Levels (debug/info/warn/error), keine Zeitstempel, kein maschinenlesbares Format. Für Enterprise-Betrieb ist ein Audit-Trail zwingend erforderlich.

### Akzeptanzkriterien

* [ ] Ein Logger-Modul (`src/logger.ts`) existiert und wird von allen Modulen importiert (kein direktes `process.stderr.write()` mehr, außer in CLI-Output-Funktionen)
* [ ] Log-Levels `debug`, `info`, `warn`, `error` sind implementiert und konfigurierbar (z. B. `LOG_LEVEL` Env-Variable oder Config-Feld)
* [ ] Jeder Log-Eintrag enthält mindestens: ISO-8601-Timestamp, Level, Modul-Name, Nachricht
* [ ] Im JSON-Modus (für Maschinen) wird jeder Eintrag als eine JSON-Zeile ausgegeben (NDJSON)
* [ ] Im Human-Modus (Default für CLI) bleibt die Ausgabe lesbar auf stderr
* [ ] Alle bestehenden `process.stderr.write()`-Aufrufe in `src/` sind auf den neuen Logger migriert
* [ ] Mindestens 5 Unit-Tests für Logger (Level-Filterung, JSON-Format, Timestamp-Format)

### Technische Hinweise

- Leichtgewichtige Optionen: `pino` (NDJSON-nativ, <50 KB), `tslog`, oder ein eigenes Minimal-Modul (da Projekt „fully local" sein soll)
- Logger sollte `stderr` nutzen (gemäß CLAUDE.md: „Output to stderr")
- Greppen nach `process.stderr.write` in `src/` liefert alle Migrationsstellen
- Config-Erweiterung: `ShadowingConfig.log_level?: 'debug' | 'info' | 'warn' | 'error'`

### Definition of Done

* [ ] Code reviewed & gemergt
* [ ] Tests vorhanden und grün
* [ ] Keine direkten `process.stderr.write()`-Aufrufe mehr in Nicht-CLI-Modulen
* [ ] Dokumentation aktualisiert (README: neues `LOG_LEVEL`-Flag)

---

## TASK-02: Audit-Trail für SOP-Änderungen implementieren

| Feld | Inhalt |
|------|--------|
| **Typ** | Blocker |
| **Priorität** | P0 – Kritisch |
| **Komponente** | Security / Compliance |
| **Aufwand** | M |
| **Abhängigkeiten** | TASK-01 |

### User Story

Als **Compliance Officer** möchte ich, dass jede Erstellung, Änderung und Statusänderung einer SOP nachvollziehbar protokolliert wird, damit ich die Dokumentenhistorie lückenlos auditieren kann.

### Hintergrund

Report-Abschnitt **Logging & Observability**: „No audit trail for SOP modifications". Die Tabelle `sop_versions` existiert bereits für Inhaltsversionierung, aber es wird nicht geloggt, *wer/was* die Änderung ausgelöst hat (CLI, API, MCP) und es gibt kein Log für Statusübergänge (draft→reviewed→approved).

### Akzeptanzkriterien

* [ ] Jede SOP-Mutation (create, update content, update status, delete) erzeugt einen strukturierten Log-Eintrag mit: Timestamp, SOP-ID, Aktion, alter Wert, neuer Wert, Quelle (cli/api/mcp)
* [ ] Log-Einträge werden über den Logger aus TASK-01 ausgegeben (Level `info`)
* [ ] Statusänderungen werden zusätzlich in einer neuen DB-Tabelle `audit_log` persistiert (id, entity_type, entity_id, action, old_value, new_value, source, created_at)
* [ ] `GET /api/sops/:id` liefert optional `audit_history` mit
* [ ] Mindestens 6 Tests: create, update, status change, delete, API-Abruf, leere History

### Technische Hinweise

- `audit_log` Tabelle in `src/db.ts` Schema-Migration hinzufügen
- Alle SOP-Methoden in `ShadowingDB` um Audit-Logging erweitern
- source-Parameter: `'cli' | 'api' | 'mcp' | 'system'`

### Definition of Done

* [ ] Code reviewed & gemergt
* [ ] Tests vorhanden und grün
* [ ] Dokumentation: Audit-Log-Schema in PRODUCT_SPEC.md ergänzt

---

## TASK-03: API-Response-Size-Validierung vor DB-Persistierung

| Feld | Inhalt |
|------|--------|
| **Typ** | Blocker |
| **Priorität** | P0 – Kritisch |
| **Komponente** | Security / Resilience |
| **Aufwand** | S |
| **Abhängigkeiten** | — |

### User Story

Als **Betriebsverantwortlicher** möchte ich, dass übermäßig große Claude-API-Antworten abgefangen werden, bevor sie in die Datenbank geschrieben werden, damit kein Out-of-Memory oder DB-Bloat entsteht.

### Hintergrund

Report-Abschnitt **Critical Recommendations**: „Validate API response sizes before saving to DB (prevent OOM)". SOP-Content wird aktuell ohne Größenprüfung direkt in SQLite gespeichert. Bei fehlerhaften API-Antworten oder Prompt-Injection könnte dies zu Problemen führen.

### Akzeptanzkriterien

* [ ] `sop-generator.ts`: Nach API-Aufruf wird `content_md.length` gegen ein konfigurierbares Maximum geprüft (Default: 500 KB)
* [ ] Bei Überschreitung wird ein `SOPGenerationError` mit code `response_too_large` geworfen
* [ ] Config-Feld `sop_generation.max_response_size_bytes` existiert im Zod-Schema mit Default `512000`
* [ ] Mindestens 3 Tests: unter Limit (pass), über Limit (reject), exakt am Limit (pass)

### Technische Hinweise

- Prüfung als Guard direkt nach `parseSopResponse()` in `sop-generator.ts`
- `Buffer.byteLength(content_md, 'utf-8')` für exakte Byte-Prüfung
- Config-Schema in `src/config.ts` erweitern

### Definition of Done

* [ ] Code reviewed & gemergt
* [ ] Tests vorhanden und grün
* [ ] Config-Dokumentation aktualisiert

---

## TASK-04: REST-API-Authentifizierung implementieren

| Feld | Inhalt |
|------|--------|
| **Typ** | Feature |
| **Priorität** | P1 – Hoch |
| **Komponente** | Security |
| **Aufwand** | M |
| **Abhängigkeiten** | — |

### User Story

Als **IT-Administrator** möchte ich, dass die REST-API des Dashboards nur mit gültigem Token erreichbar ist, damit kein unautorisierter Zugriff auf SOP-Daten und Task-Informationen möglich ist.

### Hintergrund

Report-Abschnitt **High Priority**: „Implement API authentication (currently unauthenticated)". `src/ui-server.ts` akzeptiert alle Requests ohne jede Authentifizierung. Das Dashboard exponiert SOP-Inhalte, Task-Daten und ermöglicht Statusänderungen.

### Akzeptanzkriterien

* [ ] Beim Start des UI-Servers wird ein zufälliger Bearer-Token generiert und auf stderr ausgegeben
* [ ] Alternativ kann ein fixer Token via Config-Feld `ui_auth_token` oder Env-Variable `SHADOWING_UI_TOKEN` gesetzt werden
* [ ] Alle `/api/*`-Endpunkte erfordern `Authorization: Bearer <token>` Header
* [ ] Requests ohne oder mit falschem Token erhalten HTTP 401 mit JSON-Body `{ "error": "Unauthorized" }`
* [ ] Statische Dashboard-HTML-Seite (`GET /`) bleibt ohne Auth erreichbar, aber enthält ein Token-Eingabefeld
* [ ] Mindestens 5 Tests: fehlender Header (401), falscher Token (401), korrekter Token (200), konfigurierter Token, generierter Token

### Technische Hinweise

- Token-Generierung: `crypto.randomBytes(32).toString('hex')`
- Middleware-Funktion in `ui-server.ts` die vor allen API-Routen prüft
- Dashboard-HTML: Token im `localStorage` speichern, bei allen Fetch-Calls mitsenden
- Config-Schema: `ui_auth_token?: string` (optional)

### Definition of Done

* [ ] Code reviewed & gemergt
* [ ] Tests vorhanden und grün
* [ ] README aktualisiert (Auth-Abschnitt)

---

## TASK-05: Rate-Limiting für REST-API-Endpunkte

| Feld | Inhalt |
|------|--------|
| **Typ** | Feature |
| **Priorität** | P1 – Hoch |
| **Komponente** | Security / Resilience |
| **Aufwand** | S |
| **Abhängigkeiten** | TASK-04 |

### User Story

Als **Betriebsverantwortlicher** möchte ich, dass die REST-API gegen übermäßige Anfragen geschützt ist, damit ein einzelner Client den Service nicht durch Request-Flooding destabilisieren kann.

### Hintergrund

Report-Abschnitt **High Priority**: „Add rate limiting to REST API endpoints". Aktuell existiert kein Request-Throttling.

### Akzeptanzkriterien

* [ ] Ein In-Memory-Rate-Limiter begrenzt Requests pro IP auf konfigurierbare Werte (Default: 100 Requests/Minute)
* [ ] Bei Überschreitung wird HTTP 429 mit `Retry-After`-Header zurückgegeben
* [ ] Rate-Limit-Werte sind über Config konfigurierbar: `ui_rate_limit_per_minute`
* [ ] Write-Endpunkte (PUT, POST, DELETE) haben ein separates, niedrigeres Limit (Default: 20/Minute)
* [ ] Mindestens 4 Tests: unter Limit, Limit erreicht (429), Retry-After Header korrekt, Reset nach Zeitfenster

### Technische Hinweise

- Einfache Implementierung: Sliding-Window-Counter mit `Map<string, { count: number, resetAt: number }>`
- Kein externes Paket nötig bei Single-Instance-Betrieb
- `setInterval` zum Cleanup abgelaufener Einträge

### Definition of Done

* [ ] Code reviewed & gemergt
* [ ] Tests vorhanden und grün

---

## TASK-06: Zentralen Error-Handler für REST-API implementieren

| Feld | Inhalt |
|------|--------|
| **Typ** | Feature |
| **Priorität** | P1 – Hoch |
| **Komponente** | Observability / Resilience |
| **Aufwand** | M |
| **Abhängigkeiten** | TASK-01 |

### User Story

Als **Entwickler** möchte ich, dass alle unbehandelten Fehler in der REST-API zentral abgefangen, geloggt und als konsistente JSON-Antworten zurückgegeben werden, damit keine Stack-Traces an Clients leaken und alle Fehler im Log nachvollziehbar sind.

### Hintergrund

Report-Abschnitt **High Priority**: „Add centralized error handler middleware for REST API". Aktuell handhabt jede Route Fehler individuell; unbehandelte Exceptions können Raw-Errors an Clients senden.

### Akzeptanzkriterien

* [ ] Eine zentrale Error-Handler-Funktion fängt alle unbehandelten Exceptions in `ui-server.ts`-Routen ab
* [ ] Fehler-Responses folgen einheitlichem Schema: `{ "error": string, "code"?: string, "status": number }`
* [ ] Stack-Traces werden **nie** an den Client gesendet, aber via Logger (TASK-01) auf Level `error` geloggt
* [ ] Bekannte Fehlertypen (`SOPGenerationError`, Zod-Validierungsfehler) werden auf passende HTTP-Statuscodes gemappt (400, 404, 422, 500)
* [ ] Mindestens 5 Tests: Validierungsfehler (400), nicht gefunden (404), interner Fehler (500), SOPGenerationError-Mapping, kein Stack-Trace in Response

### Technische Hinweise

- Pattern: Wrapper-Funktion `asyncHandler(fn)` die try/catch um Route-Handler legt
- Zod-Errors → 422 mit `issues`-Array
- `SOPGenerationError` → 502 (upstream API error)
- Sonstige → 500 mit generischer Nachricht

### Definition of Done

* [ ] Code reviewed & gemergt
* [ ] Tests vorhanden und grün
* [ ] Alle bestehenden Route-Handler nutzen den zentralen Error-Handler

---

## TASK-07: PII-Redaktion protokollieren für Compliance-Nachweis

| Feld | Inhalt |
|------|--------|
| **Typ** | Feature |
| **Priorität** | P1 – Hoch |
| **Komponente** | Security / Compliance |
| **Aufwand** | S |
| **Abhängigkeiten** | TASK-01 |

### User Story

Als **Datenschutzbeauftragter** möchte ich nachvollziehen können, welche PII-Kategorien bei einem Export anonymisiert wurden, damit ich den Nachweis der DSGVO-konformen Verarbeitung führen kann.

### Hintergrund

Report-Abschnitt **High Priority**: „Log all PII redaction operations for compliance audits". Die Anonymisierung selbst ist exzellent (🟢), aber es wird nicht protokolliert, *was* redacted wurde.

### Akzeptanzkriterien

* [ ] `Anonymizer.anonymize()` gibt zusätzlich zum anonymisierten Text ein `RedactionSummary`-Objekt zurück: `{ email_count, ip_count, url_count, phone_count, filepath_count, iban_count, credit_card_count, custom_count }`
* [ ] Bei jedem Export wird das aggregierte `RedactionSummary` über Logger (Level `info`) ausgegeben
* [ ] Das Summary wird im `manifest.json` unter `redaction_summary` gespeichert
* [ ] Mindestens 4 Tests: Summary-Zählung korrekt, leerer Text (alle 0), gemischte PII-Typen, Integration mit Exporter

### Technische Hinweise

- `anonymize()` Signatur erweitern auf `{ text: string, summary: RedactionSummary }`
- Alle Aufrufer von `anonymize()` anpassen (primär `src/exporter.ts`)
- Bestehende Tests anpassen (Rückgabetyp ändert sich)

### Definition of Done

* [ ] Code reviewed & gemergt
* [ ] Tests vorhanden und grün
* [ ] `manifest.json`-Schema in PRODUCT_SPEC.md aktualisiert

---

## TASK-08: Input-Validierung für Task-Titel, SOP-Content und API-Query-Parameter erweitern

| Feld | Inhalt |
|------|--------|
| **Typ** | Feature |
| **Priorität** | P2 – Mittel |
| **Komponente** | Security / Input Validation |
| **Aufwand** | M |
| **Abhängigkeiten** | — |

### User Story

Als **Entwickler** möchte ich, dass alle Nutzereingaben (Task-Titel, Beschreibungen, SOP-Inhalte, API-Query-Parameter) gegen definierte Größenlimits und Formate validiert werden, damit keine überdimensionierten Einträge die Datenbank belasten oder unerwartete Query-Ergebnisse auftreten.

### Hintergrund

Report-Abschnitt **Input Validation — Gaps**: „Task titles/descriptions: no length limits enforced", „API query parameters: minimal validation before DB query", „SOP content: no size limits before saving to DB".

### Akzeptanzkriterien

* [ ] Task-Titel: maximal 500 Zeichen, nicht leer (Zod-Validierung in `task-manager.ts` oder `db.ts`)
* [ ] Task-Description: maximal 10.000 Zeichen
* [ ] SOP `content_md`: maximal 500.000 Bytes (konsistent mit TASK-03)
* [ ] SOP `title`: maximal 500 Zeichen
* [ ] API-Query-Parameter `status` wird gegen erlaubte Enum-Werte validiert (nicht blind an DB weitergereicht)
* [ ] API-Query-Parameter `search` wird auf maximal 200 Zeichen begrenzt
* [ ] Validierungsfehler geben aussagekräftige Fehlermeldungen zurück (CLI: stderr, API: 422)
* [ ] Mindestens 8 Tests: je ein Grenzwert-Test pro Feld + API-Parameter-Validierung

### Technische Hinweise

- Zod-Schemas für `CreateTaskInput`, `UpdateSOPInput` definieren
- In `ui-server.ts` Query-Parameter über Zod validieren (z. B. `z.enum(['active','paused','completed','cancelled']).optional()`)
- DB-Layer: `CHECK`-Constraints als zusätzliche Absicherung möglich, aber Validierung primär in der Application-Schicht

### Definition of Done

* [ ] Code reviewed & gemergt
* [ ] Tests vorhanden und grün

---

## TASK-09: Concurrent-DB-Access-Tests implementieren

| Feld | Inhalt |
|------|--------|
| **Typ** | Chore |
| **Priorität** | P2 – Mittel |
| **Komponente** | Testing |
| **Aufwand** | M |
| **Abhängigkeiten** | — |

### User Story

Als **Entwickler** möchte ich sicherstellen, dass die SQLite-Datenbank bei gleichzeitigem Zugriff (z. B. CLI + UI-Server + MCP-Server) korrekt funktioniert, damit im produktiven Einsatz keine Datenkorruption oder Deadlocks auftreten.

### Hintergrund

Report-Abschnitt **Test Coverage — Gaps**: „No concurrent task tests (DB handles single active task, but not tested under race conditions)". Die Anwendung kann theoretisch über CLI, REST-API und MCP gleichzeitig auf die DB zugreifen. WAL-Modus ist aktiv, aber es gibt keine Tests dafür.

### Akzeptanzkriterien

* [ ] Mindestens 8 Concurrency-Tests in `test/db-concurrency.test.ts`
* [ ] Tests decken ab: parallele Reads, Read+Write gleichzeitig, zwei gleichzeitige Writes, doppelter `startTask`-Versuch, gleichzeitiger Status-Update auf dieselbe SOP
* [ ] Tests verwenden echte SQLite-DB (nicht gemockt), um WAL-Verhalten korrekt zu prüfen
* [ ] Alle Tests sind grün und stabil (kein Flaky-Verhalten)
* [ ] Ergebnis dokumentiert: WAL-Modus verhält sich korrekt bei Concurrency Level X

### Technische Hinweise

- `better-sqlite3` ist synchron — Concurrency entsteht durch mehrere DB-Instanzen auf derselbe Datei
- Testansatz: Mehrere `ShadowingDB`-Instanzen öffnen, die auf dieselbe DB-Datei zeigen
- `PRAGMA busy_timeout` prüfen/setzen (Default in better-sqlite3: 0ms → sollte auf 5000ms gesetzt werden)
- Vitest: `Promise.all()` mit mehreren DB-Operationen

### Definition of Done

* [ ] Code reviewed & gemergt
* [ ] Tests vorhanden und grün
* [ ] Ggf. `busy_timeout` PRAGMA in `db.ts` gesetzt, falls Tests Probleme aufdecken

---

## TASK-10: Claude-API-Kosten-Tracking implementieren

| Feld | Inhalt |
|------|--------|
| **Typ** | Feature |
| **Priorität** | P2 – Mittel |
| **Komponente** | Observability |
| **Aufwand** | M |
| **Abhängigkeiten** | TASK-01 |

### User Story

Als **Kostenverantwortlicher** möchte ich nachvollziehen können, wie viele Tokens und API-Calls die SOP-Generierung verbraucht, damit ich die Betriebskosten kalkulieren und Budgets planen kann.

### Hintergrund

Report-Abschnitt **Observability Gap**: „No tracking of API usage (tokens, costs)". Die Anthropic-SDK-Response enthält `usage.input_tokens` und `usage.output_tokens`, diese werden aktuell nicht erfasst.

### Akzeptanzkriterien

* [ ] Neue DB-Tabelle `api_usage` (id, sop_id, model, input_tokens, output_tokens, created_at)
* [ ] Nach jedem erfolgreichen Claude-API-Call werden Token-Counts aus der Response in `api_usage` gespeichert
* [ ] `shadowing stats` zeigt aggregierte API-Nutzung an: Gesamt-Tokens, Anzahl Calls, Durchschnitt pro SOP
* [ ] `GET /api/stats` enthält `api_usage_summary` Objekt
* [ ] Token-Verbrauch wird via Logger auf Level `info` ausgegeben
* [ ] Mindestens 4 Tests: Usage-Logging, Stats-Aggregation, leere Usage, API-Endpoint

### Technische Hinweise

- Anthropic SDK Response: `response.usage.input_tokens`, `response.usage.output_tokens`
- Tabelle `api_usage` in Schema-Migration in `db.ts` hinzufügen
- Kosten-Berechnung ist *nicht* Scope dieses Tasks (Preise ändern sich) — nur Token-Tracking

### Definition of Done

* [ ] Code reviewed & gemergt
* [ ] Tests vorhanden und grün
* [ ] `shadowing stats` Output-Dokumentation aktualisiert

---

## TASK-11: Performance-Metriken für SOP-Generierung erfassen

| Feld | Inhalt |
|------|--------|
| **Typ** | Feature |
| **Priorität** | P2 – Mittel |
| **Komponente** | Observability |
| **Aufwand** | S |
| **Abhängigkeiten** | TASK-01, TASK-10 |

### User Story

Als **Betriebsverantwortlicher** möchte ich wissen, wie lange die SOP-Generierung dauert, damit ich Engpässe identifizieren und SLAs definieren kann.

### Hintergrund

Report-Abschnitt **Medium Priority**: „Add performance metrics for SOP generation latency". Es gibt keine Messung der API-Latenz.

### Akzeptanzkriterien

* [ ] `api_usage`-Tabelle (aus TASK-10) wird um Spalte `duration_ms` (INTEGER) erweitert
* [ ] SOP-Generierung misst die Wall-Clock-Dauer des API-Calls und speichert sie
* [ ] `shadowing stats` zeigt durchschnittliche Generierungsdauer an
* [ ] Langsame Calls (>30s) werden auf Log-Level `warn` geloggt
* [ ] Mindestens 3 Tests: Duration-Logging, Stats-Anzeige, Warn-Threshold

### Technische Hinweise

- `performance.now()` vor und nach dem API-Call in `sop-generator.ts`
- Duration in `api_usage` speichern
- Threshold konfigurierbar: `sop_generation.slow_threshold_ms` (Default: 30000)

### Definition of Done

* [ ] Code reviewed & gemergt
* [ ] Tests vorhanden und grün

---

## TASK-12: Error-Codes für Task-Manager- und DB-Operationen einführen

| Feld | Inhalt |
|------|--------|
| **Typ** | Chore |
| **Priorität** | P2 – Mittel |
| **Komponente** | Error Handling |
| **Aufwand** | S |
| **Abhängigkeiten** | — |

### User Story

Als **Entwickler** möchte ich, dass Fehler aus Task- und DB-Operationen maschinenlesbare Error-Codes enthalten, damit ich programmatisch auf spezifische Fehler reagieren kann (z. B. im MCP-Server oder in Integrationen).

### Hintergrund

Report-Abschnitt **Error Handling — Gaps**: „Most database operations throw generic `Error('...')` without codes" und „Task operations throw errors but could benefit from error codes". `SOPGenerationError` zeigt bereits das richtige Pattern mit `code`-Feld.

### Akzeptanzkriterien

* [ ] Neue Custom Error Class `ShadowingError` mit Feld `code: string` (analog zu `SOPGenerationError`)
* [ ] Alle `throw new Error(...)` in `src/db.ts` und `src/task-manager.ts` verwenden `ShadowingError` mit spezifischem Code
* [ ] Error-Codes folgen Schema: `task_not_found`, `task_already_active`, `sop_not_found`, `invalid_status_transition`, `db_constraint_error`, etc.
* [ ] Error-Codes sind als Union-Type in `types.ts` definiert
* [ ] Mindestens 6 Tests: je ein Test pro Error-Code-Kategorie

### Technische Hinweise

- `ShadowingError` in `src/types.ts` oder eigenem `src/errors.ts` definieren
- Pattern von `SOPGenerationError` übernehmen (extends Error, code, retryable)
- Grep nach `throw new Error` in `src/db.ts` und `src/task-manager.ts` für alle Migrationsstellen

### Definition of Done

* [ ] Code reviewed & gemergt
* [ ] Tests vorhanden und grün
* [ ] `SOPGenerationError` ggf. auf `ShadowingError` umgestellt oder davon abgeleitet

---

## TASK-13: UI-Server-Error-Handling-Tests und MCP-Negative-Tests ergänzen

| Feld | Inhalt |
|------|--------|
| **Typ** | Chore |
| **Priorität** | P3 – Niedrig |
| **Komponente** | Testing |
| **Aufwand** | S |
| **Abhängigkeiten** | TASK-06 |

### User Story

Als **Entwickler** möchte ich, dass die REST-API- und MCP-Server-Fehlerpfade durch Tests abgedeckt sind, damit Regressionen bei Error-Handling frühzeitig erkannt werden.

### Hintergrund

Report-Abschnitt **Test Coverage — Gaps**: „No tests for UI server REST error handling" und „Limited negative test cases for MCP server malformed requests".

### Akzeptanzkriterien

* [ ] Mindestens 8 neue Tests für UI-Server-Fehlerpfade: ungültige JSON-Bodys, fehlende Pflichtfelder, nicht existierende SOP-ID, ungültiger Status-Übergang, malformed Query-Parameter
* [ ] Mindestens 5 neue Tests für MCP-Server: malformed Tool-Calls, fehlende Parameter, ungültige Tool-Namen, überlange Inputs
* [ ] Alle neuen Tests sind grün und in CI integriert

### Technische Hinweise

- Bestehende Testdateien erweitern: `test/ui-server.test.ts`, ggf. neues `test/mcp-server-negative.test.ts`
- Für UI-Server: HTTP-Requests mit `fetch()` oder Test-Helper simulieren
- Für MCP-Server: Tool-Call-Objekte direkt an Handler-Funktionen übergeben

### Definition of Done

* [ ] Code reviewed & gemergt
* [ ] Tests vorhanden und grün

---

## TASK-14: Request-Tracing mit Correlation-IDs für REST- und MCP-Server

| Feld | Inhalt |
|------|--------|
| **Typ** | Feature |
| **Priorität** | P3 – Niedrig |
| **Komponente** | Observability |
| **Aufwand** | M |
| **Abhängigkeiten** | TASK-01, TASK-06 |

### User Story

Als **Support-Mitarbeiter** möchte ich einzelne Requests anhand einer eindeutigen ID durch alle Log-Einträge verfolgen können, damit ich Fehler schneller diagnostizieren kann.

### Hintergrund

Report-Abschnitt **Logging & Observability**: „No request tracing. No correlation IDs or distributed tracing support." Bei mehreren gleichzeitigen Clients (Dashboard + MCP) sind Logs ohne Correlation-ID nicht zuordenbar.

### Akzeptanzkriterien

* [ ] Jeder eingehende HTTP-Request erhält eine `X-Request-Id` (generiert oder aus Header übernommen)
* [ ] Jeder MCP-Tool-Call erhält eine Correlation-ID
* [ ] Alle Log-Einträge innerhalb eines Requests enthalten die Correlation-ID
* [ ] Response-Header `X-Request-Id` wird zurückgegeben
* [ ] Mindestens 4 Tests: ID-Generierung, ID-Propagation im Log, Header-Übernahme, Response-Header

### Technische Hinweise

- `crypto.randomUUID()` für ID-Generierung
- AsyncLocalStorage (Node.js) für kontextuelle Propagation innerhalb eines Requests — oder einfacher: Request-ID als Parameter an Logger-Aufrufe durchreichen
- Für MVP reicht das einfachere Pattern (Parameter) — AsyncLocalStorage ist optional

### Definition of Done

* [ ] Code reviewed & gemergt
* [ ] Tests vorhanden und grün

---

# Umsetzungs-Roadmap

## Phase 0 — Blocker & Pflichtbedingungen (vor Go-Live)

```
TASK-01  Structured Logging          [L]  ─── Basis für TASK-02, 06, 07, 10, 11, 14
TASK-02  Audit-Trail für SOPs        [M]  ─── abhängig von TASK-01
TASK-03  API-Response-Size-Limit     [S]  ─── unabhängig
```

> **Begründung:** Ohne Logging und Audit-Trail ist kein Compliance-Nachweis möglich. Response-Size-Limit verhindert kritische Stabilitätsprobleme. Diese drei Tasks müssen vor produktivem Einsatz abgeschlossen sein.

## Phase 1 — Härtung & Absicherung

```
TASK-04  REST-API-Auth               [M]  ─── unabhängig
TASK-05  Rate-Limiting               [S]  ─── abhängig von TASK-04
TASK-06  Zentraler Error-Handler     [M]  ─── abhängig von TASK-01
TASK-07  PII-Redaktion-Logging       [S]  ─── abhängig von TASK-01
TASK-12  Error-Codes einführen       [S]  ─── unabhängig
```

> **Begründung:** Sicherheitslücken in der API schließen, Error-Handling vereinheitlichen, Compliance für PII-Verarbeitung sicherstellen.

## Phase 2 — Qualität & Validierung

```
TASK-08  Input-Validierung erweitern [M]  ─── unabhängig
TASK-09  Concurrency-Tests           [M]  ─── unabhängig
TASK-10  API-Kosten-Tracking         [M]  ─── abhängig von TASK-01
TASK-11  Performance-Metriken        [S]  ─── abhängig von TASK-01, TASK-10
```

> **Begründung:** Zusätzliche Härtung der Eingaben, Nachweis der DB-Stabilität unter Last, Betriebskostentransparenz.

## Phase 3 — Langfristige Maßnahmen (Backlog)

```
TASK-13  UI/MCP-Negative-Tests       [S]  ─── abhängig von TASK-06
TASK-14  Request-Tracing             [M]  ─── abhängig von TASK-01, TASK-06
```

> **Begründung:** Nice-to-have für Diagnosefähigkeit und Testabdeckung. Kein Blocker für Go-Live.

---

# Aufwands-Übersicht

| Task | Titel | Typ | Priorität | Aufwand | Phase |
|------|-------|-----|-----------|---------|-------|
| TASK-01 | Structured Logging | Blocker | P0 | L | 0 |
| TASK-02 | SOP Audit-Trail | Blocker | P0 | M | 0 |
| TASK-03 | API Response Size Limit | Blocker | P0 | S | 0 |
| TASK-04 | REST-API Auth | Feature | P1 | M | 1 |
| TASK-05 | Rate-Limiting | Feature | P1 | S | 1 |
| TASK-06 | Zentraler Error-Handler | Feature | P1 | M | 1 |
| TASK-07 | PII-Redaktion-Logging | Feature | P1 | S | 1 |
| TASK-08 | Input-Validierung | Feature | P2 | M | 2 |
| TASK-09 | Concurrency-Tests | Chore | P2 | M | 2 |
| TASK-10 | API-Kosten-Tracking | Feature | P2 | M | 2 |
| TASK-11 | Performance-Metriken | Feature | P2 | S | 2 |
| TASK-12 | Error-Codes | Chore | P2 | S | 1 |
| TASK-13 | UI/MCP-Negative-Tests | Chore | P3 | S | 3 |
| TASK-14 | Request-Tracing | Feature | P3 | M | 3 |

**Gesamt: 4× S, 7× M, 1× L, 2× undetermined (if using SP: ~50-65 SP estimated)**

---

# Dependency Graph

```
                    TASK-03 (Size Limit) ────────── standalone
                    TASK-04 (Auth) ──────────────── standalone
                    TASK-08 (Input Validation) ──── standalone
                    TASK-09 (Concurrency Tests) ─── standalone
                    TASK-12 (Error Codes) ───────── standalone

TASK-01 (Logging) ─┬── TASK-02 (Audit Trail)
                   ├── TASK-06 (Error Handler) ──┬── TASK-13 (Negative Tests)
                   │                             └── TASK-14 (Request Tracing)
                   ├── TASK-07 (PII Logging)
                   └── TASK-10 (Cost Tracking) ──── TASK-11 (Perf Metrics)

TASK-04 (Auth) ────── TASK-05 (Rate Limiting)
```
