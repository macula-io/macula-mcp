# macula-mcp

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
**not** speak QUIC, DHT, or Macula RPC. It speaks MCP over stdio to the
agent, and HTTP over a Unix socket to the **local `hecate-daemon`**, which is
already a mesh client and already the realm-accountable leaf. The daemon does
the actual mesh work; `macula-mcp` carries no mesh logic and no identity
logic. Same shape as [`git-remote-mesh`](https://codeberg.org/macula-io/git-remote-mesh).

```
┌───────────────┐   MCP/stdio   ┌────────────┐   HTTP/Unix   ┌───────────────┐   QUIC    ┌──────────────┐
│ agent harness │ ────────────▶ │ macula-mcp │ ────────────▶ │ hecate-daemon │ ─────────▶│ Macula mesh  │
└───────────────┘               └────────────┘               └───────────────┘           └──────────────┘
```

## Why a mesh-MCP at all

As agents do more of the typing, the scarce resources stop being "code
completion" and become **provenance**, **federated shared memory**, and
**cross-party agent coordination** — exactly what Macula provides and what a
centralised, US-owned AI coding tool structurally cannot:

- Every action goes through the daemon, which records a ReckonDB event and
  can publish an accountable integration fact to a realm topic. Every Macula
  leaf chains to an accountable realm + foundation — actions carry that chain.
- `mesh://activity/{realm}` surfaces what agents *across the federation* are
  doing to code you depend on, with provenance, live.
- Right-to-erasure applies for free (it's ReckonDB underneath).

## Tools

| Tool | Primitive | What it does |
|---|---|---|
| `mesh_call` | RPC | Invoke a capability a peer advertises (build, test, search, deploy) over the mesh. Returns the result + the `fact_id` of the recorded event. |
| `mesh_put` | Content Sharing | Publish a content-addressed artifact; returns its hash + `fact_id`. |
| `mesh_get` | Content Sharing | Fetch a content-addressed artifact by hash. |
| `mesh_publish` | Pub/Sub | Emit an integration fact to a realm-scoped topic (business verbs only, never CRUD). Returns `fact_id`. |

## Resources

| Resource | Content |
|---|---|
| `mesh://identity` | This node's mesh identity: node id, realm membership, advertised capabilities. An agent should read this before acting. |
| `mesh://peers` | Reachable peers and the capabilities they advertise (valid `mesh_call` targets). |
| `mesh://activity/{realm}` | Recent agent-activity facts on a realm topic, each with its provenance chain. |

## Prerequisites

- A running `hecate-daemon` on the local machine (every hecate-ish tool
  assumes this). `macula-mcp` is a mesh shim, not a fallback client.
- Node.js 20+.
- The daemon-side `/api/mesh/*` endpoints — see
  [`plans/PLAN_MACULA_MCP.md`](plans/PLAN_MACULA_MCP.md) for the contract and
  status. Until they land, `macula-mcp` builds and registers but its calls
  return daemon errors.

## Install

```bash
npm install
npm run build
npm link            # puts `macula-mcp` on PATH
```

## Environment

| Variable | Purpose | Default |
|---|---|---|
| `HECATE_DAEMON_SOCKET` | Override the daemon Unix-socket path. | `$HOME/.hecate/hecate-daemon/sockets/api.sock` |

## Status

v0.2 — daemon-side endpoints implemented in `hecate-daemon` as
doctrine-compliant CMD/EMITTER/PRJ/QRY apps (`guide_mesh_publications`,
`guide_mesh_artifacts`, `project_mesh_activity`, `query_mesh_activity`)
plus REQUESTER slices (`call_mesh`, `fetch_mesh_artifact`,
`get_mesh_identity`). Both sides compile clean; not yet deployed or
pushed. See `plans/PLAN_MACULA_MCP.md` for the full contract + status.

Known mesh limits at time of writing: cross-station DHT replication and
`streaming_rpc` are not fully shipped — `mesh_put/get` is reliable
same-station, best-effort cross-station; `mesh_call` is unary.
`mesh://peers` returns an empty list until `hecate_mesh:get_peers/0`
(a pre-existing stub) is fixed upstream. `mesh_get` does not surface
`content_type` in v1.

## License

Apache-2.0. See [LICENSE](LICENSE).
