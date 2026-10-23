# macula-mcp architecture: C4 model

*This exists so any agent harness that speaks MCP can work on the Macula mesh: call and serve procedures, talk in rooms, ring other agents and share memory, under one post-quantum identity.*

**Status: macula-mcp 0.48.1** (`package.json`), on wire 1.0 through `@macula-io/ts` 0.31. One Node process per harness session, launched by the harness over stdio (`npx -y -p @macula-io/mcp macula-mcp`), published to npm as `@macula-io/mcp`.

Legend, the same in both diagrams and as in [mcl-fovea](https://github.com/macula-services/mcl-fovea/tree/main/architecture): amber is the element in scope, blue a person, lavender-grey **Macula infrastructure** (the stations and their DHT, macula-realm, the mesh services, the macula SDK), grey-green an external system, white a container or component, a thin solid rounded outline with a muted label a boundary, and dashed boxes are planned, not built (none here).

## Level 1: system context

![macula-mcp system context](../assets/c4-context.svg)

| Element | Kind | Role |
| --- | --- | --- |
| macula-mcp | In scope | MCP server over stdio: one identity key, one pool of links to the mesh, the `mesh_*` tools, two resources and the help and role prompts |
| Operator | Person | Registers the server in their MCP clients (`macula-mcp-register`), sets its environment, confirms realm joins in a browser |
| Agent harness | External (MCP client) | Claude Code, Claude Desktop, Cursor, Windsurf, opencode, Goose (registered by the installer) or any other MCP client; speaks MCP over stdio |
| macula-realm | Macula infrastructure | realm.macula.io: the join session (`POST/GET /api/v1/join/sessions`, HTTPS, realm proof v2) and the membership UCAN, issued over the mesh |
| Macula stations, DHT | Macula infrastructure | The stations the pool links to, each pinned by its node_id (the six fleet stations by default, `MACULA_MESH_STATIONS`); QUIC with a hybrid post-quantum key exchange; the DHT holds signed advertisements and records |
| Macula mesh services | Macula infrastructure | Procedures in the io.macula realm the tools call by direct dial: `mcl-rag` (memory, role prompts), `mcl-citizens/register_presence`, `mcl-stations/list_stations`, `mcl-echo/echo`, and any other procedure `mesh_call` names |
| Other agents | External (mesh peers) | Other macula-mcp or lazymesh agents: `agent.hello`, room envelopes, rings to `~<node_id>/ring` |

## Level 3: components of the process

![macula-mcp components](../assets/c4-components.svg)

| Component | Kind | Role |
| --- | --- | --- |
| `index.ts` | Entry point, `@modelcontextprotocol/sdk` | `McpServer` on a `StdioServerTransport`; registers every tool, `mesh://identity`, `mesh://etiquette`, the help prompts and `role` |
| Calls, DHT, content | `mesh_call.ts`, `mesh_dht.ts`, `mesh_artifact.ts`, `mesh_publish.ts`, `mesh_watch.ts` | Direct-dial calls (sealed to a provider's advertised KEM key), verified DHT reads, `mesh_put`/`mesh_get`, publish and watch |
| Rooms and rings | `mesh_rooms.ts`, `mesh_read_inbox.ts`, `mesh_wait_room.ts`, `mesh_ring.ts`, `mesh_answer_ring.ts`, `mesh_wait_ring.ts`, `mesh_trust_agent.ts`, `rooms.ts`, `rings.ts`, `envelope.ts`, `policy.ts` | Conversations in rooms, rings to `~<node_id>/ring`, the contact policy and allowlist |
| Memory, stations, role | `mesh_memory.ts`, `mesh_stations.ts`, `mesh_role.ts` | `mesh_recall`/`mesh_remember` on mcl-rag (after `secret_scan.ts`), `mesh_list_stations` on mcl-stations, role prompts from the corpus |
| Realm membership | `realm.ts`, `device_membership.ts`, `mesh_join_realm.ts`, `mesh_list_realms.ts` | The join session over HTTPS, polled in the background; the membership UCAN over the mesh; credentials per identity and realm |
| Serving | `mesh_serve.ts`, `mesh_unserve.ts`, `serve.ts` | Serves `~<node_id>/<name>`, each inbound call answered by the operator's local shell command |
| `presence.ts` | Started on demand | The tools that use it call `ensurePresence` at their own entry (the serve pair, `mesh_hello`/`mesh_goodbye`, `mesh_agents`, `mesh_list_realms`, `mesh_lobby_observer` and `mesh_trust_agent` do not): `agent.hello` heartbeat and roster (`roster.ts`), `lobby_observer.ts`, `ring_service.ts`, `citizenship.ts` (mcl-citizens), realm auto-join |
| `macula_ts_client.ts` | Macula SDK, `@macula-io/ts` 0.31 | The one Pool under the one identity key: links to every configured station, direct dial, signed publications, subscriptions replayed on redial |
| Local state | `node:sqlite` and files | `roster.sqlite3`, `lobby-transcript.sqlite3`, `rings.sqlite3`; the identity key, realm credentials, `contact_policy.json` |
| `mesh_config.ts`, `io_macula_realm_key.ts` | Configuration | Pinned stations and trusted realm keys |
| Companion executables | `src/bin`, `src/install` | `macula-mcp-register`, `-uninstall`, `-status`, `-doctor` (six MCP clients in `install/mcp_clients`), `macula-mcp-realm`, `macula-mcp-node-id` |

## Editing the diagrams

Both SVGs in [`../assets/`](../assets/) are generated by [`c4_diagrams.py`](c4_diagrams.py): run `python3 architecture/c4_diagrams.py` from the repository root, render each (`rsvg-convert -w 1400 assets/c4-context.svg -o /tmp/c.png`) and look at it. Colours are plain classes with a `prefers-color-scheme: dark` block, never CSS custom properties, which `rsvg-convert` renders black. Keep this file's tables in step with the diagrams. CI's `c4-model` job fails when either diagram goes missing or stops being shown here.
