# Using Shadowing inside Claude Code

This guide is for **end users** who want to run Agentic AI Shadowing from a
[Claude Code](https://claude.com/claude-code) conversation: start and complete
tasks, generate and review SOPs, and export them — all by talking to Claude,
without switching tools.

There is nothing to script. You install once, initialize a local database once,
and from then on you just ask Claude.

---

## What you get

Once connected, Claude Code can drive Shadowing through an **MCP server** (18
typed tools). In practice that means you can say things like *"start a task"*,
*"complete it and write an SOP"*, or *"export my approved SOPs"*, and Claude
calls the right tool for you.

Optionally, the **plugin** also installs observation **hooks**: as you work in
Claude Code (open files, run commands, make commits), Shadowing quietly logs
those actions to the active task so the generated SOP reflects what actually
happened. Everything stays **local** and is **anonymized** — no telemetry, and
the only external call is to the Claude API when *you* ask for an SOP.

---

## Prerequisites

- **Node.js >= 22.12** (`node --version`)
- **Claude Code** installed and working
- **`ANTHROPIC_API_KEY`** — only required to *generate* SOPs. Task tracking,
  observation, listing, and export all work without it.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

---

## Setup

### Step 1 — Install the plugin (recommended)

In a Claude Code session, add the Datasynx marketplace and install the plugin:

```
/plugin marketplace add datasynx/claude-plugins
/plugin install shadowing@datasynx
```

This bundles three things in one install:

| Component | What it does |
|-----------|--------------|
| **MCP server** | The 18 tools Claude uses to drive Shadowing |
| **Hooks** | Auto-log your actions (file open, commits, tool use) to the active task |
| **Skill** | Teaches Claude *when* to track a task and how to phrase SOPs |

The plugin starts the server with `npx -y @datasynx/agentic-ai-shadowing mcp`,
so you do **not** need a separate global install. **Restart Claude Code** when
prompted so the MCP server and hooks load.

> **Prefer MCP only, without hooks or the skill?** See
> [Manual MCP setup](#alternative-manual-mcp-setup-no-plugin) below.

### Step 2 — Initialize the local database (one-time)

In your terminal:

```bash
npx @datasynx/agentic-ai-shadowing init
```

This creates the local SQLite database and config under
`~/.datasynx/shadowing/`. You only do this once per machine.

### Step 3 — Verify the connection

Inside a Claude Code session, run:

```
/mcp
```

You should see **`shadowing`** listed with its tool count and a connected
status. If it is missing, see [Troubleshooting](#troubleshooting).

---

## Daily use — just talk to Claude

You never call tools by name. You describe what you want; Claude picks the tool.

### Track a task and generate an SOP

> **You:** Start a task called "Onboard a new vendor in SAP".
>
> *(Claude calls `shadowing_start_task`. You now do the work. If you installed
> the plugin, your file opens / commands / commits are logged automatically; you
> can also narrate steps and Claude will log them.)*
>
> **You:** Okay, I'm done. Complete the task and turn it into an SOP.
>
> *(Claude calls `shadowing_complete_task`, then generates a draft SOP from the
> task and its observations.)*

### Review and approve

> **You:** Show me that SOP.
> **You:** Looks good — approve it.

If your Claude Code client supports **elicitation**, Claude can ask you to
approve/reject/keep-as-draft right in the conversation
(`shadowing_review_sop`). Otherwise it just sets the status when you say so.

### Find, update, and export

> **You:** List my approved SOPs.
> **You:** Show SOP a3f8c210.
> **You:** Add the tags "monthly" and "finance" to it.
> **You:** Export all approved SOPs.

Exports are written as anonymized Markdown plus a `manifest.json` under
`~/.datasynx/shadowing/exports/`.

### Check status anytime

> **You:** What's my current Shadowing status?
> **You:** Show me the global stats.

---

## What Claude can do (tool reference)

You don't need these names, but here's the full surface so you know the limits.
Only `approved` SOPs are ever published or exported.

| Tool | What you'd say |
|------|----------------|
| `shadowing_start_task` | "Start a task called …" |
| `shadowing_complete_task` | "Complete the task" / "…and make an SOP" |
| `shadowing_pause_task` / `shadowing_resume_task` | "Pause this" / "Resume" |
| `shadowing_get_status` | "What's my status?" |
| `shadowing_list_tasks` | "List my tasks" |
| `shadowing_list_sops` | "List my SOPs" / "…approved ones" |
| `shadowing_get_sop` | "Show SOP <id>" |
| `shadowing_update_sop` | "Change the title/steps of …" (auto-versioned) |
| `shadowing_approve_sop` | "Approve it" |
| `shadowing_review_sop` | "Review this SOP" (in-session approve/reject) |
| `shadowing_add_tags` | "Tag it with …" |
| `shadowing_start_observation` / `shadowing_stop_observation` | "Start/stop observing" |
| `shadowing_log_observation` | "Log this step: …" |
| `shadowing_get_timeline` | "Show the timeline for this session" |
| `shadowing_get_stats` | "Show global stats" |
| `shadowing_export_sops` | "Export approved SOPs" |

---

## Alternative: manual MCP setup (no plugin)

If you want only the MCP tools — no hooks, no skill — register the server
yourself. First install the package so the `shadowing` binary is on your `PATH`:

```bash
npm install -g @datasynx/agentic-ai-shadowing
shadowing init
```

Then add it to Claude Code:

```bash
# Current project only (default scope)
claude mcp add --transport stdio shadowing -- shadowing mcp

# All your projects
claude mcp add --transport stdio --scope user shadowing -- shadowing mcp
```

Verify:

```bash
claude mcp list
claude mcp get shadowing
```

### Remote / HTTP transport

For advanced setups you can run the server over HTTP instead of stdio:

```bash
shadowing mcp --http                 # stateless /mcp endpoint on 127.0.0.1:3848
```

```bash
claude mcp add --transport http shadowing http://127.0.0.1:3848/mcp
```

It binds to loopback by default and validates the `Origin` header
(DNS-rebinding protection). To expose it beyond localhost you **must** set a
bearer token:

```bash
SHADOWING_MCP_TOKEN=… shadowing mcp --http --host 0.0.0.0
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `/mcp` doesn't list `shadowing` | Restart Claude Code after installing the plugin. Re-check with `/plugin` that `shadowing@datasynx` is installed. |
| "Database not initialized" / empty results | Run `npx @datasynx/agentic-ai-shadowing init` once. |
| SOP generation fails | Make sure `ANTHROPIC_API_KEY` is set in the environment Claude Code launched from. |
| `shadowing: command not found` (manual setup) | The global install didn't put the binary on `PATH`. Use the plugin instead, or pass an absolute path: `claude mcp add --transport stdio shadowing -- /full/path/to/shadowing mcp`. |
| Want to remove it | `/plugin uninstall shadowing@datasynx`, or `claude mcp remove shadowing` for a manual setup. |
| See diagnostic logs | Launch with `LOG_LEVEL=debug` (or `info`) to surface internal logs. |

---

## Privacy at a glance

- **Local-first:** all data lives in `~/.datasynx/shadowing/`. Nothing is sent
  anywhere except the Claude API call when you generate an SOP.
- **Redact-on-capture:** secrets and PII are stripped *before* they're written
  to the database, and again at export time.
- **No silent writes to agent context:** the plugin only adds clearly managed,
  fully removable entries; nothing is changed behind your back.

For the complete product specification see
[PRODUCT_SPEC.md](PRODUCT_SPEC.md); for the MCP server internals and the
registry listing see the [README](../README.md#mcp-server-18-tools).
