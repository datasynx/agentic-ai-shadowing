# Security Policy

## Supported Versions

Only the latest published release of `@datasynx/agentic-ai-shadowing` receives
security fixes. Fixes ship automatically via semantic-release as soon as they
are merged.

| Version        | Supported |
| -------------- | --------- |
| latest release | ✅        |
| older releases | ❌        |

## Reporting a Vulnerability

Please report vulnerabilities **privately** via
[GitHub Private Vulnerability Reporting](https://github.com/datasynx/agentic-ai-shadowing/security/advisories/new)
(Security → Report a vulnerability). Do **not** open a public issue for
security reports.

What to include:

- Affected version and component (CLI, MCP server, UI server, exporter, …)
- Reproduction steps or a proof of concept
- Impact assessment (what an attacker gains)

You can expect an initial response within **7 days**. Confirmed issues are
fixed with priority; you will be credited in the release notes unless you
prefer otherwise.

## Scope Notes

- The tool is **local-first**: the UI server binds to loopback by default and
  requires a bearer token off-loopback; the MCP HTTP transport validates
  `Origin` and requires a token off-loopback. Reports that require a user to
  deliberately disable these protections are still welcome but triaged as
  lower severity.
- Secrets/PII handling is a core security surface: bypasses of the
  always-on secret redaction or of redact-on-capture (see
  `docs/HARDENING_2026-06.md`) are treated as **high severity**.
- The only external service contacted is the Anthropic API (SOP generation);
  there is no telemetry.
