---
name: shadowing
description: Track the user's work as tasks and turn it into SOPs. Use whenever the user starts a distinct piece of work (call shadowing_start_task), finishes one (shadowing_complete_task), or asks about SOPs, task tracking, work documentation, or standard operating procedures.
---

# Shadowing — task tracking and SOP generation

Shadowing observes work and generates anonymized Standard Operating Procedures
(SOPs). Everything is stored locally; PII and secrets are redacted before they
reach disk.

## When to act

- The user begins a distinct piece of work → `shadowing_start_task` with a
  concise title.
- Notable mid-task events (decisions, commands, gotchas) →
  `shadowing_log_observation`.
- The work is done → `shadowing_complete_task` (optionally with a 1–5
  complexity rating). This records duration and enables SOP generation.
- The user asks "what am I working on" / "show my SOPs" →
  `shadowing_get_status`, `shadowing_list_sops`, `shadowing_get_sop`.

## SOP review workflow

SOPs start as drafts. Help the user review with `shadowing_get_sop`, refine
with `shadowing_update_sop` (auto-versioned), then `shadowing_approve_sop`.
Only approved SOPs are exported (`shadowing_export_sops` — anonymized markdown
plus a manifest).

## Rules

- One active task at a time — complete or pause before starting another.
- Never invent task content; track what the user actually does.
- Do not approve SOPs on your own initiative; approval is the user's call.

If the MCP tools are unavailable, the CLI equivalent is `npx shadowing`
(`init`, `start`, `status`, `list`, `export`).
