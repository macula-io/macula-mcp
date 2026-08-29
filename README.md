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

Every tool takes an optional `host` (`"host[:port]"`) to pick which station
to connect through; all default to `MACULA_MESH_STATION` (see
[Environment](#environment)).

## Resources

| Resource | Content |
|---|---|
| `mesh://identity` | This node's Ed25519 identity (node ID), minted and persisted locally by `macula-cli`. |

## Prerequisites

- [`macula-cli`](https://github.com/macula-io/macula-cli) installed and on
  `PATH` — `curl -fsSL https://raw.githubusercontent.com/macula-io/macula-cli/master/install.sh | bash`
  (Windows: `irm https://raw.githubusercontent.com/macula-io/macula-cli/master/install.ps1 | iex`).
  Run `macula-mcp status` (or `npx @macula/mcp status`) to check.
- Node.js 20+.

## Install

```bash
npm install
npm run build
npm link            # puts `macula-mcp` on PATH
```

Then register it with your MCP client:

```bash
macula-mcp-install                 # detects Claude Code, Claude Desktop, Cursor, Windsurf
macula-mcp-status                  # read-only check: is macula-cli found, which clients are configured
macula-mcp-uninstall               # removes the registered entry only — doesn't touch macula-cli
```

## Environment

| Variable | Purpose | Default |
|---|---|---|
| `MACULA_CLI_BIN` | Override the `macula-cli` binary path/name. | `macula-cli` (resolved via `PATH`) |
| `MACULA_MESH_STATION` | Default station every tool connects through when a call doesn't override `host`. | `station-de-frankfurt.macula.io:4433` |

## Status

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
design** — `macula-cli` is a one-shot process with no daemon and no
storage, so none of these have an honest equivalent without `macula-mcp`
itself becoming a stateful daemon (a real design fork that was deliberately
not taken; see `macula-io/macula-cli`'s own project memory for the
tradeoff):
- **Standing subscriptions + inbox.** The old `mesh_subscribe`/
  `mesh_unsubscribe`/`mesh_subscriptions`/`mesh_inbox` quartet relied on
  the daemon's own event-sourced background subscription that outlived any
  one call. Replaced by `mesh_watch`, which blocks for a bounded duration
  and returns what arrived — call it again to keep watching.
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

## License

Apache-2.0. See [LICENSE](LICENSE).
