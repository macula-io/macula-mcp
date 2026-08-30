#!/usr/bin/env node
// macula-mcp — a Model Context Protocol server that exposes the Macula mesh to
// any agent harness (Claude Code, Cursor, Cline, Continue, ...).
//
// Topology: thin client. macula-mcp speaks MCP over stdio to the agent, and
// shells out to macula-cli (macula-io/macula-cli), a scriptable CLI built
// directly on macula-go. macula-mcp owns no mesh logic of its own -- macula-cli
// does the QUIC handshake/call/publish/watch/content transfer, either as a
// one-shot subprocess per tool call, or (mesh_hello/mesh_goodbye/mesh_agents
// only, via presence.ts) as one long-lived `macula-cli daemon` this server
// manages internally for as long as it runs.
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
// later (2026-08-30) -- presence.ts is this server narrowly taking that
// fork back up, scoped to exactly one use (agent-presence heartbeat +
// roster), not a wholesale return to the old design.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerIdentity } from "./mesh_identity.js";
import { registerEtiquette } from "./mesh_etiquette.js";
import { registerHelp } from "./mesh_help.js";
import { registerMeshCall } from "./mesh_call.js";
import { registerMeshArtifact } from "./mesh_artifact.js";
import { registerMeshPublish } from "./mesh_publish.js";
import { registerMeshWatch } from "./mesh_watch.js";
import { registerMeshHello } from "./mesh_hello.js";
import { registerMeshGoodbye } from "./mesh_goodbye.js";
import { registerMeshAgents } from "./mesh_agents.js";

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
a response.
- Read mesh://identity first so you know which node ID you're acting as. Read mesh://etiquette \
for the full reasoning behind these rules. A person in this conversation can also ask for \
help directly (/mcp__macula__help and friends -- help_identity, help_wire_format, help_watch, \
help_install -- if their client supports MCP prompts).
- mesh_hello announces this agent's presence (a periodic heartbeat plus a live roster of other \
agents heard from) -- call it once if you want to be discoverable, then mesh_agents to see who \
else is around. Call mesh_goodbye to leave deliberately rather than just going quiet.`;

const server = new McpServer(
  { name: "macula-mcp", version: "0.5.0" },
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
registerMeshPublish(server);
registerMeshWatch(server);

// mesh_hello/mesh_goodbye are the one exception to "one-shot": together
// they manage this process's own standing presence (heartbeat +
// subscriptions), see presence.ts's own doc comment for why that's a
// deliberate, narrow departure from every other tool here.
registerMeshHello(server);
registerMeshGoodbye(server);
registerMeshAgents(server);

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
