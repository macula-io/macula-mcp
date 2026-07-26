# PLAN: macula-mcp

Status: **Phase 1 + 2 landed; Phase 3 spec'd (2026-05-16).** Phase 3 spec at "## Phase 3 spec" — unblocks the two-agent demo and pairs with `PLAN_MACULA_MCP_INSTALLER.md` + `PLAN_PROVISIONAL_REALM_TIER` Phase 0 for the Tier 1 push.

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
| `POST /api/mesh/artifact` | `apps/guide_mesh_artifacts/src/share_mesh_artifact` | CMD |
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

// POST /api/mesh/artifact
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
  External-FACT subscription via a LISTENER lands in Phase 3 (now scoped
  generically, no realm-topic convention required for v1).
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
- **Phase 3 — mesh subscriptions + inbound activity (Tier 1 critical
  path).** Adds the `mesh_subscribe / mesh_unsubscribe / mesh_inbox`
  surface so two MCP-driven agents can converse. Subscription
  management is its own CMD slice; inbound FACTs flow through a
  LISTENER desk inside `hecate_mesh` and join the existing
  `mesh_activity` stream with `direction=in`. See full spec under
  "## Phase 3 spec" below.
- **Phase 3.5 — push (resource subscription) [optional].** SSE on
  `/api/mesh/inbox/stream`; macula-mcp surfaces as MCP
  `resources/subscribe` with `notifications/resources/updated`. Removes
  polling from the agent-conversation loop. ~2 days on top of Phase 3.
- **Phase 4 — cross-station + streaming.** Re-test `mesh_put/get`
  cross-station once DHT replication ships; promote `mesh_call` to
  streaming once `streaming_rpc` ships cross-station. Use
  `macula-e2e` cross-station probes as regression detectors.
- **Phase 5 — wildcard topics + verified-only-topic gating.**
  Wildcard subscribe (`chat.*`) once macula bloom-fan prefix matching
  is surfaced through `hecate_mesh:subscribe/2`. Tier-gated topics
  (verified-only) enforced at the subscribe boundary.

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

## Phase 3 spec — mesh subscriptions + inbound activity

**Status:** Draft (2026-05-16). Unblocks the two-agent demo. Blocks on
nothing in the daemon; pairs naturally with `PLAN_PROVISIONAL_REALM_TIER`
Phase 0 + `PLAN_MACULA_MCP_INSTALLER.md` Phase 1 for the Tier 1 push.

### 3.1 Doctrinal flows

| Flow | Shape |
|------|-------|
| Subscribe | HTTP → CMD → AGGREGATE → DOMAIN EVENT → EMITTER (calls `hecate_mesh:subscribe/2`) |
| Unsubscribe | HTTP → CMD → AGGREGATE → DOMAIN EVENT → EMITTER (calls `hecate_mesh:unsubscribe/1`) |
| Inbound FACT | LISTENER (handler installed by subscribe-emitter) → CMD → DOMAIN EVENT (joins `mesh_activity_store` with `direction=in`) |
| List subscriptions | QRY on subscription-aggregate ETS projection |
| Inbox query | QRY on `mesh_activity` filtered to `direction=in`, optionally by topic |

**Activity store reuse (Option A).** `mesh_fact_received_v1` joins the
existing `mesh_activity` ETS table alongside `mesh_fact_published_v1`
and `mesh_artifact_shared_v1`, with a `direction` field. One unified
audit stream. Cheap to ship; keeps the query surface coherent.
(Option B — dedicated `mesh_inbox_store` — is a refactoring opportunity
if separation pressure emerges; not Tier 1.)

### 3.2 New umbrella apps

| App | Role | Naming pattern |
|-----|------|----------------|
| `guide_mesh_subscriptions` | CMD: subscribe / unsubscribe lifecycle | Matches existing `guide_mesh_*` pattern |
| (extend) `hecate_mesh` | LISTENER desk: `receive_mesh_fact/` | New desk in existing facade app |
| (extend) `project_mesh_activity` | Projection adds inbound branch | New file `mesh_fact_received_v1_to_mesh_activity.erl` |
| (extend) `query_mesh_activity` | New desk `get_mesh_inbox_page/` + `get_mesh_subscriptions/` | Two new desks |

### 3.3 Aggregate / events

**`guide_mesh_subscriptions` aggregate** holds the topic set with
metadata `{topic, subscribed_at, by_agent_mri}`. ETS-projected for fast
duplicate-subscribe detection and hot-path topic→handler lookup.

- Desks:
  - `add_mesh_subscription/` — command `add_mesh_subscription_v1`, event `mesh_subscription_added_v1`
  - `remove_mesh_subscription/` — command `remove_mesh_subscription_v1`, event `mesh_subscription_removed_v1`
- Idempotent: add of an already-subscribed topic → no-op (returns existing fact_id)
- Emitters:
  - `mesh_subscription_added_v1_to_mesh` — calls `hecate_mesh:subscribe(Topic, fun receive_mesh_fact_handler/3)`
  - `mesh_subscription_removed_v1_to_mesh` — calls `hecate_mesh:unsubscribe(Topic)`

**LISTENER inside `hecate_mesh`:** `receive_mesh_fact/`
- Handler installed by the subscribe-emitter
- On each inbound FACT, dispatches command `receive_mesh_fact_v1 {topic, payload, sender_node_id, sender_mri, sig_verified, ts_ms}` into the hecate_mesh CMD store
- Domain event: `mesh_fact_received_v1`

**Reuse `mesh_activity_store`** to record `mesh_fact_received_v1` — the
projection joins existing `mesh_activity` ETS with `direction=in`.

### 3.4 HTTP endpoints

```jsonc
// POST /api/mesh/subscriptions
// request:  { "topic": "chat.demo" }
// reply:    { "ok": true, "topic": "chat.demo", "fact_id": "mesh_subscriptions@N" }

// DELETE /api/mesh/subscriptions/:topic
// reply:    { "ok": true, "topic": "chat.demo", "fact_id": "mesh_subscriptions@N" }

// GET /api/mesh/subscriptions
// reply:    { "ok": true, "subscriptions": [
//   { "topic": "chat.demo", "subscribed_at": ..., "by_agent_mri": "mri:agent:..." }
// ] }

// GET /api/mesh/inbox?since=<ms|fact_id>&topic=<t>&limit=<n>
// reply:    { "ok": true, "events": [
//   { "fact_id": "mesh_activity@7", "kind": "mesh_fact_received", "ts_ms": ...,
//     "payload": { "topic": "chat.demo", "fact": {...},
//                  "sender_node_id": "<hex>", "sender_mri": "mri:agent:...",
//                  "sig_verified": true } }
// ] }
```

### 3.5 MCP-side tools (macula-mcp)

| Tool | HTTP | Description |
|------|------|-------------|
| `mesh_subscribe` | `POST /api/mesh/subscriptions` | Subscribe to a topic. Returns fact_id. |
| `mesh_unsubscribe` | `DELETE /api/mesh/subscriptions/:topic` | Unsubscribe. Returns fact_id. |
| `mesh_subscriptions` | `GET /api/mesh/subscriptions` | List active subscriptions. |
| `mesh_inbox` | `GET /api/mesh/inbox` | Cursor-paginated inbox query. |

| Resource | URI | Description |
|----------|-----|-------------|
| `mesh://inbox` | last N inbound events (default 50) | Mirrors `mesh://activity` shape; filtered to `direction=in`. |

### 3.6 Files to create

| File | Purpose |
|------|---------|
| `apps/guide_mesh_subscriptions/src/guide_mesh_subscriptions_app.erl` | OTP app |
| `apps/guide_mesh_subscriptions/src/guide_mesh_subscriptions_sup.erl` | Supervisor |
| `apps/guide_mesh_subscriptions/src/add_mesh_subscription/add_mesh_subscription_v1.erl` | Command |
| `apps/guide_mesh_subscriptions/src/add_mesh_subscription/maybe_add_mesh_subscription.erl` | Handler |
| `apps/guide_mesh_subscriptions/src/add_mesh_subscription/mesh_subscription_added_v1.erl` | Event |
| `apps/guide_mesh_subscriptions/src/remove_mesh_subscription/{remove_mesh_subscription_v1,maybe_remove_mesh_subscription,mesh_subscription_removed_v1}.erl` | Same trio |
| `apps/guide_mesh_subscriptions/src/aggregate.erl` | Aggregate state |
| `apps/guide_mesh_subscriptions/src/mesh_subscription_added_v1_to_mesh.erl` | EMITTER: calls `hecate_mesh:subscribe/2` |
| `apps/guide_mesh_subscriptions/src/mesh_subscription_removed_v1_to_mesh.erl` | EMITTER: calls `hecate_mesh:unsubscribe/1` |
| `apps/hecate_mesh/src/receive_mesh_fact/receive_mesh_fact_v1.erl` | Command |
| `apps/hecate_mesh/src/receive_mesh_fact/maybe_receive_mesh_fact.erl` | Handler |
| `apps/hecate_mesh/src/receive_mesh_fact/mesh_fact_received_v1.erl` | Event |
| `apps/hecate_mesh/src/receive_mesh_fact/receive_mesh_fact_handler.erl` | LISTENER fun installed by emitter |
| `apps/project_mesh_activity/src/mesh_fact_received_v1_to_mesh_activity.erl` | Projection extension |
| `apps/query_mesh_activity/src/get_mesh_inbox_page/get_mesh_inbox_page.erl` | QRY desk |
| `apps/query_mesh_activity/src/get_mesh_subscriptions/get_mesh_subscriptions.erl` | QRY desk |
| `apps/hecate_daemon/src/...router` | Wire 4 HTTP routes |
| `apps/hecate_daemon/src/hecate_app.erl` | Register `mesh_subscriptions_store` |
| `apps/hecate_daemon/src/relx-overlay` | Boot order |
| `src/mesh_subscribe.ts` | MCP tool |
| `src/mesh_unsubscribe.ts` | MCP tool |
| `src/mesh_subscriptions.ts` | MCP tool |
| `src/mesh_inbox.ts` | MCP tool + `mesh://inbox` resource |
| `src/daemon.ts` | 4 new client methods |
| `src/index.ts` | Register tools + resource |

### 3.7 Open decisions

| # | Decision | Recommendation | Why |
|---|----------|----------------|-----|
| 1 | Activity store reuse vs separate inbox store | **Reuse** (Option A) | Smaller diff; one unified stream; coherent audit query |
| 2 | Wildcard subscribe (`chat.*`) | Defer to Phase 5 | Needs prefix support in `hecate_mesh:subscribe/2`; not Tier 1 |
| 3 | Inbox retention | ETS ring bounded at 10k events, 24h TTL, configurable | Matches existing `mesh_activity` bound; fine for demo + early adoption |
| 4 | Self-publish loopback | **Don't echo own publishes by default** | Surprise factor; agents subscribing for chat don't want their own messages back |
| 5 | Tier gating site (verified-only topics) | At `hecate_mesh:subscribe/2` boundary | Substrate enforcement; macula-mcp stays thin |
| 6 | Duplicate FACT receipt (same fact via multiple paths) | Rely on macula's `event_dedup` upstream | Already load-bearing for substrate; surfaces clean here |
| 7 | Subscription survival across daemon restart | **Survives** (event-sourced reprojection re-installs handlers on boot) | Free; matches user expectation |

### 3.8 Demo path (Tier 1 deliverable)

Two daemons, each:

1. `mesh_subscribe("chat.demo")`
2. `mesh_publish("chat.demo", {from: "<self>", text: "<msg>"})`
3. Other side polls `mesh_inbox(topic="chat.demo")` and sees the message

LLM client (Claude Code, Cursor) calls `mesh_inbox` either on each turn
or via a periodic check. Polling is the MVP; Phase 3.5 adds push via
MCP resource subscription if pull UX wears thin in practice.

### 3.9 Success criteria

- [ ] `mesh_subscribe / mesh_unsubscribe` round-trips inside one daemon (subscribe + publish + inbox returns the fact)
- [ ] Cross-daemon: same flow across two daemons on the same realm; inbox on B sees the fact published by A within < 1s on the same LAN
- [ ] Subscription survives daemon restart (event-sourced reprojection re-installs handler on boot)
- [ ] Idempotent subscribe (re-subscribe to existing topic is a no-op returning the existing fact_id)
- [ ] Self-publishes don't appear in own inbox by default
- [ ] Inbox cursor pagination works (since=fact_id returns only later events)
- [ ] Provisional-tier daemon can subscribe to a public topic (no tier gate triggered at this phase)
- [ ] Two LLM sessions (one Claude Code, one Cursor; same provisional tier) exchange 10 messages on `chat.demo` end-to-end

### 3.10 Effort estimate

| Sub-phase | Effort |
|-----------|--------|
| 3.1-3.3 daemon CMD app + LISTENER desk + projection extension | 1.5 days |
| 3.4 HTTP endpoints + router wiring + store registration + relx | 0.5 day |
| 3.5 macula-mcp tools + resource + daemon-client methods | 0.5 day |
| 3.6 integration tests (single-daemon + dual-daemon harness) | 0.5 day |
| 3.7 docs (README updates, manifesto §6 demo script) | 0.25 day |
| **Total Phase 3** | **~3.25 days** |
| 3.5 (push) optional add-on | +2 days |

## Demo target (for funders / NGI / EU framing)

An agent running inside Claude Code, on commons hardware, that: reads
`mesh://identity` to know its realm; calls `mesh_call` to run a build on a
peer's box; `mesh_put`s the artifact; a second node's agent `mesh_get`s it by
hex MCID; both actions appear in `mesh://activity` with `fact_id` audit
anchors back to the daemon's accountable event stores. Pitch: *European
federated substrate for accountable AI software agents.* Maps onto workload
classes 1 (runners), 2 (`serve_llm`), 3 (federated AI).
