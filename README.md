# @datasynx/cartography-shadow

> **Work in progress** — noch nicht veröffentlicht.

Shadow Daemon für [`@datasynx/agentic-ai-cartography`](https://github.com/datasynx-ai/agentic-ai-discovery).

Kontinuierliches System-Monitoring via Claude Haiku:
- Snapshots alle 30s (ss + ps + optional xdotool)
- Diff-Analyse per AI — NUR bei Änderungen (Claude Haiku, günstig)
- Task-Tracking & SOP-Generierung (Claude Sonnet, einmalig beim Stop)
- IPC via UNIX-Socket (`~/.cartography/daemon.sock`)
- Desktop-Notifications via node-notifier

## Spec

Alle Details zur Architektur, Typen, IPC-Protokoll, CLI-Kommandos und Implementierungs-Entscheidungen:

→ [`docs/SHADOW_SPEC.md`](docs/SHADOW_SPEC.md)

## Ursprung

Extrahiert aus `@datasynx/agentic-ai-cartography` v0.2.6.
Quell-Dateien befinden sich in `src/`.
