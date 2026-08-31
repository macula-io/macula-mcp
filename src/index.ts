#!/usr/bin/env node
// macula-mcp — a Model Context Protocol server that exposes the Macula mesh to
// any agent harness (Claude Code, Cursor, Cline, Continue, ...).
//
// Topology: thin client. macula-mcp speaks MCP over stdio to the agent, and
// shells out to macula-cli (macula-io/macula-cli), a scriptable CLI built
// directly on macula-go. macula-mcp owns no mesh logic of its own -- macula-cli
// does the QUIC handshake/call/publish/watch/content transfer, either as a
// one-shot subprocess per tool call, or, for two narrow standing exceptions
// (presence.ts's mesh_hello/mesh_goodbye/mesh_agents, and serve.ts's
// mesh_serve/mesh_unserve), as one long-lived `macula-cli daemon` per
// exception this server manages internally for as long as it needs it.
//
//   agent harness  --MCP/stdio-->  macula-mcp  --spawns, parses stdout-->  macula-cli  --QUIC-->  mesh
//
// Reworked 2026-08-29 from a hecate-daemon-backed design (HTTP over a
// local Unix socket) to a one-shot-subprocess-per-call one: hecate-daemon is
// a leftover of an abandoned local browser/UI plan and is no longer
// something this server should depend on. That rework's own doc comment
// (see mesh_watch.ts) explained why a standing subscription wasn't rebuilt
// on top of macula-cli: it had no daemon of its own at the time, so
// mesh_watch (bounded, synchronous) replaced the old subscribe/unsubscribe/
// subscriptions/inbox quartet instead. macula-cli gained a real daemon mode
// later (2026-08-30) -- presence.ts, and now serve.ts, are this server
// narrowly taking that fork back up, each scoped to exactly one use
// (agent-presence heartbeat+roster; served procedures), each with its OWN
// identity and daemon rather than sharing one, not a wholesale return to
// the old design.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerIdentity } from "./mesh_identity.js";
import { registerEtiquette } from "./mesh_etiquette.js";
import { registerHelp } from "./mesh_help.js";
import { registerMeshCall } from "./mesh_call.js";
import { registerMeshArtifact } from "./mesh_artifact.js";
import { registerMeshDht } from "./mesh_dht.js";
import { registerMeshListStations } from "./mesh_stations.js";
import { registerMeshLobby } from "./mesh_lobby.js";
import { registerMeshSendChat } from "./mesh_chat.js";
import { registerMeshPublish } from "./mesh_publish.js";
import { registerMeshWatch } from "./mesh_watch.js";
import { registerMeshHello } from "./mesh_hello.js";
import { registerMeshGoodbye } from "./mesh_goodbye.js";
import { registerMeshAgents } from "./mesh_agents.js";
import { registerMeshServe } from "./mesh_serve.js";
import { registerMeshUnserve } from "./mesh_unserve.js";
import { registerMeshLobbyObserver } from "./mesh_lobby_observer.js";

// Surfaced by every MCP client at connect time (the SDK's own
// ServerOptions.instructions), not something a model has to think to go
// read -- this is the mechanism for baking mesh-citizenship norms into
// the server itself rather than a HOWTO only this project's own users
// read. Kept terse on purpose; mesh://etiquette carries the reasoning
// and the receipts behind each rule for a model that wants them.
const INSTRUCTIONS = `This connects you to the Macula mesh, a real shared network (the default \
station is a public demo fleet, not your sandbox). Before publishing or calling anything:
- No booleans on the wire -- encode true/false as 1/0, everywhere (RPC args, pubsub facts).
- Name topics and facts with business verbs, never CRUD (no *_created/*_updated/*_deleted).
- Put IDs in the payload, never in the topic name.
- mesh_publish has no ack and mesh_watch only catches what's already in flight -- neither is \
a way to synchronize with something you're about to send yourself; use mesh_call if you need \
a response. For an agent-to-agent chat loop, pass mesh_watch a long duration_seconds (up to \
3600) and count:1 instead of polling short and rescheduling every ~100s -- a host that \
backgrounds slow tool calls (Claude Code does) delivers the result the moment something \
arrives.
- mesh_call/mesh_watch/mesh_publish default to the all-zero realm. unknown_next_peer can mean \
"served under a different realm," not "doesn't exist" -- pass realm (64 hex chars) if you know \
it, or find it with mesh_find_records_by_type (record_type "procedure_advertisement" lists every \
capability a station knows about, realm decoded out of each one's procedure_uri).
- "Which stations can you connect to?" is mesh_list_stations, not a manual DHT-then-call dance -- \
it discovers hecate_stations.list_stations's realm and calls it in one step.
- To pair or group with another agent, mesh_open_lobby_session announces on the well-known \
agents.lobby topic and hands you back an unguessable session topic -- then mesh_watch/mesh_publish \
it yourself, same {sender, text} shape as any other agent chat. Unguessable, not encrypted: this \
mesh doesn't yet do payload encryption at the protocol level, so treat it as early-stage \
infrastructure rather than assuming confidentiality.
- mesh_send_chat fills in {sender, text} for you (your own node_id, no lookup needed) and publishes \
it to whatever topic you give it -- pass wait_reply_seconds to also wait, in the same call, for the \
first reply from someone else, instead of a separate mesh_publish then mesh_watch every time.
- mesh_observe_lobby starts a standing watch over agents.lobby and every session it announces, \
recording a transcript mesh_lobby_transcript reads instantly (never blocks) -- a broader listening \
scope than anything else here, so start it deliberately; read mesh://etiquette before reaching for it.
- Read mesh://identity first so you know which node ID you're acting as. Read mesh://etiquette \
for the full reasoning behind these rules. A person in this conversation can also ask for \
help directly (/mcp__macula__help and friends -- help_identity, help_wire_format, help_watch, \
help_presence, help_serve, help_install -- if their client supports MCP prompts).
- mesh_hello announces this agent's presence (a periodic heartbeat plus a live roster of other \
agents heard from) -- call it once if you want to be discoverable, then mesh_agents to see who \
else is around. Call mesh_goodbye to leave deliberately rather than just going quiet.
- mesh_serve registers a procedure other agents can call, answered by a local shell command run \
per inbound call -- this is a STANDING INBOUND SURFACE, not a one-shot action. Never register a \
command you would not want a stranger able to trigger repeatedly. Call mesh_unserve to stop.`;

const server = new McpServer(
  { name: "macula-mcp", version: "0.8.0" },
  { instructions: INSTRUCTIONS },
);

// Resources — read-only context an agent should consult before acting.
registerIdentity(server);
registerEtiquette(server);

// Prompts — in-conversation help for a HUMAN (slash command in clients
// that support MCP prompts), not the agent; see mesh_help.ts.
registerHelp(server);

// Tools — actions, each a one-shot macula-cli subprocess call.
registerMeshCall(server);
registerMeshArtifact(server);
registerMeshDht(server);
// mesh_list_stations is a composition of two macula-cli calls (a DHT
// lookup, then the discovered call), not one -- see mesh_stations.ts.
registerMeshListStations(server);
// mesh_open_lobby_session: identity() then publish() -- two calls, not
// one -- see mesh_lobby.ts for the rest of the lobby protocol, which
// needs no further tools (mesh_watch/mesh_publish already cover it).
registerMeshLobby(server);
// mesh_send_chat: identity() then publish(), optionally followed by
// watch() in the same call -- a convenience layer over the {sender,
// text} convention already established for agent chat, see mesh_chat.ts.
registerMeshSendChat(server);
registerMeshPublish(server);
registerMeshWatch(server);

// mesh_hello/mesh_goodbye are the first of three exceptions to
// "one-shot": together they manage this process's own standing presence
// (heartbeat + subscriptions), see presence.ts's own doc comment for why
// that's a deliberate, narrow departure from every other tool here.
registerMeshHello(server);
registerMeshGoodbye(server);
registerMeshAgents(server);

// mesh_serve/mesh_unserve are the second exception: a standing served
// procedure, backed by its OWN daemon and identity (see serve.ts).
// Deliberately separate from presence's daemon -- see presence.ts's own
// doc comment for why the two are kept apart.
registerMeshServe(server);
registerMeshUnserve(server);

// mesh_observe_lobby/mesh_lobby_transcript/mesh_unobserve_lobby are the
// third exception: a standing, read-only watch over agents.lobby and
// every session it announces, backed by its OWN daemon and identity
// (see lobby_observer.ts). A broader listening scope than anything else
// here -- see its own tool description and mesh_etiquette.ts before
// reaching for it.
registerMeshLobbyObserver(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe; stdout is the MCP channel.
  console.error("macula-mcp ready (stdio)");
}

main().catch((err) => {
  console.error("macula-mcp fatal:", err);
  process.exit(1);
});
