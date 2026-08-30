# macula-mcp

[![CI](https://img.shields.io/github/actions/workflow/status/macula-io/macula-mcp/ci.yml?branch=main&label=CI)](https://github.com/macula-io/macula-mcp/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](#license)
[![Node](https://img.shields.io/badge/node-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow.svg)](https://buymeacoffee.com/rlefever)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/macula-mcp-full-dark.svg">
    <img src="assets/macula-mcp-full-light.svg" alt="Macula MCP" width="320">
  </picture>
</p>

A [Model Context Protocol](https://modelcontextprotocol.io) server that
exposes the Macula mesh to any agent harness: Claude Code, Cursor, Cline,
Continue, and anything else that speaks MCP.

```jsonc
// .mcp.json (or your harness's MCP config)
{
  "mcpServers": {
    "macula": { "command": "macula-mcp" }
  }
}
```

## What it is

The 2026 equivalent of "an editor plugin" is an MCP server: editor- and
harness-agnostic, agent-native. `macula-mcp` is deliberately thin — it does
**not** speak QUIC, DHT, or Macula RPC itself. It speaks MCP over stdio to
the agent, and shells out to
[`macula-cli`](https://github.com/macula-io/macula-cli), a one-shot
scriptable CLI built directly on `macula-go-sdk`, for every mesh operation.
`macula-cli` does the actual QUIC handshake/call/publish/watch/content
transfer as a subprocess per tool call; `macula-mcp` carries no mesh logic
of its own.

```
┌───────────────┐   MCP/stdio   ┌────────────┐  spawns, parses stdout  ┌────────────┐   QUIC    ┌──────────────┐
│ agent harness │ ────────────▶ │ macula-mcp │ ──────────────────────▶ │ macula-cli │ ─────────▶│ Macula mesh  │
└───────────────┘               └────────────┘                        └────────────┘           └──────────────┘
```

**Reworked 2026-08-29** from an earlier design that proxied to a local
`hecate-daemon` over a Unix socket. `hecate-daemon` is a leftover of an
abandoned local browser/UI plan and is no longer something this server
depends on. This is a deliberately **lean** rework, not a like-for-like
swap: `macula-cli` is a one-shot process with no daemon and no storage, so
a few things the daemon-backed version had don't carry over — see
[Status](#status).

## Why a mesh-MCP at all

As agents do more of the typing, the scarce resources stop being "code
completion" and become **federated shared memory** and **cross-party agent
coordination** — exactly what Macula provides and what a centralised,
US-owned AI coding tool structurally cannot. `mesh_call`/`mesh_publish`/
`mesh_watch`/`mesh_put`/`mesh_get` let an agent reach a peer's advertised
capability, emit a fact other parties' agents can react to, watch for
inbound facts, and exchange content-addressed artifacts — all over real
QUIC/DHT wire protocol, not a mock.

## Tools

| Tool | Primitive | What it does |
|---|---|---|
| `mesh_call` | RPC | Invoke a capability a peer advertises (build, test, search, deploy) over the mesh. Returns the result + `duration_ms`. |
| `mesh_put` | Content Sharing | Publish a content-addressed artifact; returns its MCID hex. |
| `mesh_get` | Content Sharing | Fetch a content-addressed artifact by MCID hex. |
| `mesh_publish` | Pub/Sub | Emit an integration fact to a topic (business verbs only, never CRUD). Returns `topic`/`seq`. |
| `mesh_watch` | Pub/Sub | Watch a topic for up to `duration_seconds` (max 120) and return whatever arrived. **Blocks for the call's duration** — there's no standing background subscription; call again to keep watching. |
| `mesh_hello` | Presence | Announce this agent on the mesh: prints a welcome banner, publishes an `agent.hello` immediately, and starts a periodic heartbeat (default 60s) plus a durable subscription to everyone else's hellos. A deliberate action, not automatic on startup — see [Presence](#presence). |
| `mesh_agents` | Presence | A paged list of agents seen via `agent.hello`, sorted most-recently-seen first. Reads a local cache; only reflects agents heard from while this process has been running. |
| `mesh_goodbye` | Presence | Leave deliberately: publishes one `agent.goodbye` (so others drop this node immediately, not on a staleness timeout), then stops the heartbeat and subscription started by `mesh_hello`. |

Every tool takes an optional `host` (`"host[:port]"`) to pick which station
to connect through; all default to `MACULA_MESH_STATION` (see
[Environment](#environment)).

### Presence

`mesh_hello`/`mesh_agents`/`mesh_goodbye` are the one deliberate exception
to "every tool is a one-shot `macula-cli` subprocess call": together they
manage this server's own standing presence, backed by one internally-managed
`macula-cli daemon` (see that repo's own README's Daemon mode section) held
open for as long as this process runs. This reverses `mesh_watch`'s own
earlier design note that a standing subscription wasn't built because
`macula-cli` had no daemon at the time — it does now, and presence is this
server narrowly taking that fork back up, scoped to exactly this one use.

The roster (`mesh_agents`' data) persists to a local SQLite database (via
`better-sqlite3`, not kept in memory), so a restart doesn't forget everyone
seen minutes ago — `$HOME/.macula-mcp/roster.sqlite3` by default, overridable
with `MACULA_MCP_ROSTER_DB`. Each row carries `last_seen_at`; `mesh_agents`
prunes entries unseen for 15 minutes on every read, and an explicit
`agent.goodbye` removes its sender immediately rather than waiting on that
window. The heartbeat itself is an ordinary one-shot `pubsub publish` on a
timer, not routed through the daemon — `macula-cli`'s daemon protocol has
no publish-via-daemon method, only call/serve/subscribe.

Customize what a hello carries with `MACULA_MCP_OPERATOR_NAME` (a
human-readable name for whoever's behind this agent), `MACULA_MCP_HELLO_MESSAGE`
(a default greeting/status), and `MACULA_MCP_BANNER_FILE` (a path to custom
ASCII art, falling back to a small bundled default). Both env vars are
overridable per call via `mesh_hello`'s own `operator_name`/`message`
arguments.

## Resources

| Resource | Content |
|---|---|
| `mesh://identity` | This macula-mcp server process's own Ed25519 identity (node ID) — minted fresh per process since v0.4.0, not the same as running `macula-cli` by hand. |
| `mesh://etiquette` | The reasoning and receipts behind the mesh-citizenship rules also condensed into this server's MCP `instructions` (wire-format limits, naming norms, what this server deliberately doesn't do). |

## Prompts

For a HUMAN in the conversation, not the agent — surfaces as a slash command in clients that support MCP prompts (e.g. `/mcp__macula__help` in Claude Code). Five zero-argument prompts rather than one with a topic argument: `@modelcontextprotocol/sdk` 1.30.0 errors on a bare invocation (no `arguments` field at all — the normal way to invoke a plain slash command) of a prompt whose args are all optional, so separate prompts sidestep it.

| Prompt | Asks the model to explain |
|---|---|
| `help` | Full quick-start: tool overview, one example each, top gotchas. |
| `help_identity` | How identity works, `mesh_watch`'s separate identity, pinning with env vars. |
| `help_wire_format` | The no-bool / naming rules, with a valid and invalid example. |
| `help_watch` | What `mesh_watch` is actually for, and the mistake to avoid. |
| `help_install` | Install, register, verify (`doctor`), what a failure means. |

## Prerequisites

- Node.js 20+ (the one thing the installer below checks but won't install for
  you — get it from [nodejs.org](https://nodejs.org), nvm, fnm, or volta).

Everything else — [`macula-cli`](https://github.com/macula-io/macula-cli),
the `@macula-io/mcp` package itself, and registering with your MCP client — is
handled by the installer.

## Install

**Linux / macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/macula-io/macula-mcp/main/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/macula-io/macula-mcp/main/install.ps1 | iex
```

Both check Node.js, install `macula-cli` if it isn't already on `PATH`,
`npm install -g @macula-io/mcp`, then run `macula-mcp-install` to register the
`macula` MCP server with every detected client (Claude Code, Claude Desktop,
Cursor, Windsurf) — safe-merges into existing configs and backs them up
first. Idempotent; re-running is a no-op if everything's already current.
If more than one client is detected in a real terminal, it asks which to
register with (Enter for all).

Then verify it actually works, not just that the config file has the
entry:

```bash
macula-mcp-doctor
```

To uninstall (unregisters from every MCP client, then removes the `npm`
package — leaves `macula-cli` untouched, that has its own
[install/uninstall](https://github.com/macula-io/macula-cli#quick-start)):

```bash
curl -fsSL https://raw.githubusercontent.com/macula-io/macula-mcp/main/uninstall.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/macula-io/macula-mcp/main/uninstall.ps1 | iex
```

**From source** (contributing, or before a version is published):

```bash
npm install
npm run build
npm link            # puts `macula-mcp` on PATH
macula-mcp-install  # register with detected MCP clients
```

See the [guide](guides/HOWTO.md) for env var overrides (pinning a version,
skipping the `macula-cli` step, installing without registering any client)
and troubleshooting.

## Environment

| Variable | Purpose | Default |
|---|---|---|
| `MACULA_CLI_BIN` | Override the `macula-cli` binary path/name. | `macula-cli` (resolved via `PATH`) |
| `MACULA_MESH_STATION` | Default station every tool connects through when a call doesn't override `host`. | `station-de-frankfurt.macula.io:4433` |
| `MACULA_MCP_IDENTITY` | Pin the identity `mesh_call`/`mesh_put`/`mesh_get`/`mesh_publish` use to a fixed path, instead of a fresh one minted per process. | fresh temp file per process, deleted on exit |
| `MACULA_MCP_WATCH_IDENTITY` | Same, for `mesh_watch`'s identity (kept separate from every other tool's — see the [guide](guides/HOWTO.md) §2). | fresh temp file per process, deleted on exit |
| `MACULA_MCP_PRESENCE_IDENTITY` | Same, for the internal daemon `mesh_hello`/`mesh_agents`/`mesh_goodbye` hold open (a third identity, separate from both of the above for the same collision reason). | fresh temp file per process, deleted on exit |
| `MACULA_MCP_ROSTER_DB` | Where `mesh_agents`' SQLite roster lives. | `$HOME/.macula-mcp/roster.sqlite3` |
| `MACULA_MCP_OPERATOR_NAME` | Default `operator_name` for `mesh_hello`, when the agent doesn't pass one explicitly. | none |
| `MACULA_MCP_HELLO_MESSAGE` | Default `message` for `mesh_hello`, when the agent doesn't pass one explicitly. | none |
| `MACULA_MCP_BANNER_FILE` | Path to a custom ASCII banner `mesh_hello` prints. | a small bundled default |

## Status

**v0.5.0 — mesh_hello/mesh_agents/mesh_goodbye, real presence, 2026-08-30.** The first
tools that aren't a bare one-shot `macula-cli` subprocess call: an
internally-managed `macula-cli daemon` (new in that repo's own v0.2.0, which
this raises `MIN_MACULA_CLI_VERSION` to) backs a periodic `agent.hello`
heartbeat and a durable subscription to everyone else's, feeding a
SQLite-backed roster (`better-sqlite3`, not in-memory — a restart doesn't
forget who was seen minutes ago). Verified live end to end against the real
demo fleet: two independent processes each see the other's hello in their
own roster within one heartbeat, and an explicit `mesh_goodbye` removes its
sender from the other's roster immediately (confirmed against the wall-clock
timing of when it was actually sent, not just "eventually disappeared").
Also fixed in the same pass: a version-string drift where the MCP server
itself reported `0.4.0` to clients while `package.json` already said
`0.4.1`.

**v0.4.0 — per-process identity, MCP `instructions`, `doctor`, in-conversation help, 2026-08-29.**
Re-verified live from inside a real Claude Code session (the actual
`mcp__macula__*` tools, not just a bare MCP `Client`) and found a real
concurrency bug in the process: every tool but `mesh_watch` shared one
identity machine-wide, which failed 5/6 of the time under genuine
concurrent use (two sessions, two subagents). Fixed by minting a fresh
identity per server process instead — see [Environment](#environment)
and the [guide](guides/HOWTO.md) §2-3 for the full story and the one real
behavior change it carries. Also new this round: an `instructions` field
and `mesh://etiquette` resource carrying mesh-citizenship norms to any
connecting client, an interactive client picker on install, and a
`doctor` command that spawns the real configured entry and talks MCP to
it rather than just checking a config file's shape — the class of check
that would have caught two config-registration bugs this project
shipped, immediately, instead of a human finding them by hand.

**v0.3.0 — reworked onto `macula-cli`, 2026-08-29.** Every tool shells out
to a real `macula-cli` subprocess and has been exercised against the live
demo fleet through `macula-cli` itself (see that repo's own README/HOWTO
guide for the underlying live verification). `npm run typecheck`/`build`
are clean; `parseWatchOutput`'s NDJSON-vs-error-envelope parsing has a real
unit test (`src/macula_cli.test.ts`) guarding a bug caught while writing
it — a naive try/catch around `JSON.parse` never distinguishes a
wrong-shape-but-valid-JSON error envelope from a real event, so it needs
an explicit shape check.

**Dropped in this rework, not carried over from the daemon-backed
design** — at the time (`macula-cli` was a one-shot process with no daemon
and no storage), none of these had an honest equivalent without `macula-mcp`
itself becoming a stateful daemon, a fork deliberately not taken then (see
`macula-io/macula-cli`'s own project memory for that tradeoff). `macula-cli`
gained a real daemon later (v0.2.0) — presence (`mesh_hello`/`mesh_agents`/
`mesh_goodbye`, see [Presence](#presence)) is this server narrowly taking
that fork back up for exactly one use, not a reversal of the rework below:
- **Standing subscriptions + inbox.** The old `mesh_subscribe`/
  `mesh_unsubscribe`/`mesh_subscriptions`/`mesh_inbox` quartet relied on
  the daemon's own event-sourced background subscription that outlived any
  one call. Replaced by `mesh_watch`, which blocks for a bounded duration
  and returns what arrived — call it again to keep watching. (Presence's
  own `agent.hello`/`agent.goodbye` subscription is the one exception, and
  exists for a narrower reason: feeding `mesh_agents`' roster, not a
  general-purpose standing watch on an arbitrary topic.)
- **Activity audit log** (`mesh://activity/{realm}`, `fact_id` on every
  write). That was hecate-daemon's own ReckonDB-backed accountability
  trail. Writes still happen for real on the mesh; there's just no local
  log of them anymore.
- **`mesh://peers`.** Already an admitted stub even under the old
  design ("v1 surfaces an empty list until `hecate_mesh:get_peers/0`
  returns real data") — `macula-go-sdk` has no peer-listing API either, so
  there was nothing real to carry forward.

Known mesh limits, unchanged from before (memory:
`project_inter_station_routing_unshipped`): cross-station DHT replication
is not fully shipped — `mesh_put`/`mesh_get` is reliable same-station,
best-effort cross-station.

## Documentation

| Guide | Description |
|---|---|
| [HOW-TO Guide](guides/HOWTO.md) | Install/uninstall env var reference, each tool's exact behavior, troubleshooting a failed tool call, the two real gotchas found live-testing this rework |
| [CHANGELOG](CHANGELOG.md) | What changed in each released version, and what's on `main` but not yet tagged |
| [CONTRIBUTING](CONTRIBUTING.md) | Build/test/verify locally, the native-dependency gotcha, how a release actually gets published |

## License

Apache-2.0. See [LICENSE](LICENSE).
