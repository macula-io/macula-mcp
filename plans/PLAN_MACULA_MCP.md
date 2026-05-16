# PLAN: macula-mcp

Status: **Phase 1 + 2 landed.** Doctrine-compliant daemon endpoints implemented and aligned. Not yet committed or pushed.

## Goal

Expose the Macula mesh to any MCP-speaking agent harness, as a thin stdio
server that forwards to the local `hecate-daemon`. Mirrors
`macula-io/git-remote-mesh`.

## Architecture

```
agent harness  ──MCP/stdio──▶  macula-mcp (TS)  ──HTTP/UDS──▶  hecate-daemon  ──QUIC──▶  mesh
```

- `macula-mcp` owns: the MCP tool/resource surface, the UDS HTTP client.
- `macula-mcp` owns NOT: QUIC, DHT, RPC, identity, realm membership. All of
  that is the daemon's (it is the accountable leaf).
- Doctrinal flows (per `hecate-daemon/CLAUDE.md` MESH INTEGRATION DOCTRINE):
  - **Publish:** HTTP → CMD → AGGREGATE → DOMAIN EVENT → EMITTER → mesh FACT.
  - **Share artifact:** HTTP → CMD → handler-calls-put_content → DOMAIN EVENT
    (no emitter; content is content-addressed, MCID is the FACT).
  - **Call:** REQUESTER (no event sourcing for v1 — matches existing
    REQUESTER patterns in the codebase like `probe_mesh_rpc`).
  - **Fetch artifact:** REQUESTER (read-only get_content).
  - **Activity:** projection on the domain event stores into a unified
    ETS read model, served via QRY.

## Daemon-side implementation (as shipped)

| Endpoint | Daemon umbrella app | Doctrinal role |
|---|---|---|
| `GET /api/mesh/identity` | `apps/hecate_mesh/src/get_mesh_identity` | Read |
| `GET /api/mesh/peers` | `apps/hecate_mesh/src/get_mesh_peers` (pre-existing) | Read — currently returns empty list, `hecate_mesh:get_peers/0` is a pre-existing stub |
| `GET /api/mesh/activity` | `apps/query_mesh_activity/src/get_mesh_activity` | QRY |
| `POST /api/mesh/call` | `apps/hecate_mesh/src/call_mesh` | REQUESTER |
| `POST /api/mesh/artifact/put` | `apps/guide_mesh_artifacts/src/share_mesh_artifact` | CMD |
| `GET /api/mesh/artifact/:hash` | `apps/guide_mesh_artifacts/src/fetch_mesh_artifact` | REQUESTER |
| `POST /api/mesh/publish` | `apps/guide_mesh_publications/src/publish_mesh_fact` | CMD + EMITTER |

Stores registered in `hecate_app.erl`:
- `mesh_publications_store` — agent FACT publishes (event `mesh_fact_published_v1`).
- `mesh_artifacts_store` — agent content-sharing (event `mesh_artifact_shared_v1`).

Projections in `project_mesh_activity`:
- `mesh_fact_published_v1_to_mesh_activity` (from `mesh_publications_store`)
- `mesh_artifact_shared_v1_to_mesh_activity` (from `mesh_artifacts_store`)
Both write into ETS named table `mesh_activity` (ordered_set keyed by
`{ts_ms, monotonic_seq}`).

## Final request/response shapes

```jsonc
// GET /api/mesh/identity
{ "ok": true, "node_id": "<hex>", "mri": "...", "realm": null,
  "membership": "idle|joining|joined|failed",
  "mesh": { "activated": true, "connected": true } }

// POST /api/mesh/call
// request:  { "procedure": "mri:proc:...", "args": {...}, "timeout_ms": 30000 }
// reply:    { "ok": true, "result": <term>, "duration_ms": N }
//        |  { "ok": false, "error": "...", "duration_ms": N }

// POST /api/mesh/artifact/put
// request:  { "content": "<b64>", "content_type": "..." }
// reply:    { "ok": true, "mcid_hex": "<68 hex>", "size_bytes": N, "fact_id": "mesh_artifacts@<ver>" }

// GET /api/mesh/artifact/:hash    (hash = 68-char hex MCID)
// reply:    { "ok": true, "content": "<b64>", "size_bytes": N }

// POST /api/mesh/publish
// request:  { "topic": "agents.module_generated", "fact": {...} }
// reply:    { "ok": true, "topic": "...", "requested_at": N, "fact_id": "mesh_publications@<ver>" }

// GET /api/mesh/activity?since=<ms>&limit=<n>
// reply:    { "ok": true, "events": [
//   { "fact_id": "mesh_publications@3", "kind": "mesh_fact_published", "ts_ms": ..., "payload": {topic, fact} },
//   { "fact_id": "mesh_artifacts@1",    "kind": "mesh_artifact_shared", "ts_ms": ..., "payload": {mcid_hex, content_type, size_bytes} }
// ] }
```

`fact_id` is `stream_id@version` — synthesised from the evoq event stream.

## Known limits documented in the surface

- **`mesh://peers`** — `hecate_mesh:get_peers/0` returns `[]` (pre-existing
  stub; not in scope for this work).
- **`mesh_get` does not surface `content_type`** — the MCID addresses only
  the bytes; metadata in `mesh_artifacts_store` is local, not retrievable
  by hash. v2 fix: wrap bytes in a tiny envelope or maintain a local
  MCID→metadata index.
- **`mesh_call` is unary** — `streaming_rpc` is not yet shipped
  cross-station (memory: `project_inter_station_routing_unshipped`);
  promote when it is.
- **`mesh://activity`** surfaces only this daemon's own outgoing activity.
  External-FACT subscription via a LISTENER lands in Phase 3 once
  realm-scoped agent-activity topic conventions are agreed.
- **DHT replication** is partly unshipped cross-station — `mesh_put/get`
  reliable same-station, best-effort cross-station.

## Phases

- **Phase 0 — scaffold (done, 2026-05-16).** TS server, stdio, UDS client.
- **Phase 1+2 — daemon endpoints + doctrine compliance (done).**
  Three new umbrella apps (`guide_mesh_publications`, `guide_mesh_artifacts`,
  `project_mesh_activity`, `query_mesh_activity`), facade extensions
  (`hecate_mesh:put_content/1`, `get_content/1`), store registrations,
  route discovery, relx ordering. `rebar3 compile` clean; dialyzer shows
  only the codebase's universal "evoq behaviour not in PLT" pattern (down
  from 1140 to 1136 — the 4 real warnings my code introduced are fixed).
  macula-mcp TS rebuilds clean; types aligned to final shapes.
- **Phase 3 — external activity (deferred).** Add a LISTENER in a new
  desk that subscribes to realm-scoped agent-activity topics, converts
  incoming FACTs to commands in `guide_mesh_activity`, and joins the
  existing projection. Requires deciding the realm activity-topic
  convention.
- **Phase 4 — cross-station + streaming.** Re-test `mesh_put/get`
  cross-station once DHT replication ships; promote `mesh_call` to
  streaming once `streaming_rpc` ships cross-station. Use
  `macula-e2e` cross-station probes as regression detectors.

## Audit-trail next steps

- **`mesh_call` event sourcing.** REQUESTER currently does not record
  domain events for HOPE/FEEDBACK. Adding `mesh_call_invoked_v1` /
  `mesh_call_feedback_received_v1` would give `mesh://activity` a unified
  picture (publish + share + call). Optional; matches existing REQUESTER
  patterns to leave it out for v1.
- **Real evoq `event_id`** in `fact_id`. Today `fact_id` is synthesised
  `stream@version`. Surfacing the daemon-assigned `event_id` would make
  it match what shows up in `reckon-db` directly. Requires evoq dispatcher
  to return the event_id from `dispatch/2`.

## Demo target (for funders / NGI / EU framing)

An agent running inside Claude Code, on commons hardware, that: reads
`mesh://identity` to know its realm; calls `mesh_call` to run a build on a
peer's box; `mesh_put`s the artifact; a second node's agent `mesh_get`s it by
hex MCID; both actions appear in `mesh://activity` with `fact_id` audit
anchors back to the daemon's accountable event stores. Pitch: *European
federated substrate for accountable AI software agents.* Maps onto workload
classes 1 (runners), 2 (`serve_llm`), 3 (federated AI).
