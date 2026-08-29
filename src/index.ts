#!/usr/bin/env node
// macula-mcp — a Model Context Protocol server that exposes the Macula mesh to
// any agent harness (Claude Code, Cursor, Cline, Continue, ...).
//
// Topology: thin client. macula-mcp speaks MCP over stdio to the agent, and
// shells out to macula-cli (macula-io/macula-cli), a one-shot scriptable CLI
// built directly on macula-go-sdk. macula-mcp owns no mesh logic of its
// own -- macula-cli does the QUIC handshake/call/publish/watch/content
// transfer as a subprocess per tool call.
//
//   agent harness  --MCP/stdio-->  macula-mcp  --spawns, parses stdout-->  macula-cli  --QUIC-->  mesh
//
// Reworked 2026-08-29 from a hecate-daemon-backed design (HTTP over a
// local Unix socket) to this one: hecate-daemon is a leftover of an
// abandoned local browser/UI plan and is no longer something this server
// should depend on. This is a deliberately LEAN rework, not a like-for-
// like swap -- macula-cli is a one-shot process with no daemon and no
// storage, so standing subscriptions, an activity/inbox audit log, and
// peer listing don't carry over; mesh_watch (bounded, synchronous)
// replaces the old subscribe/unsubscribe/subscriptions/inbox quartet.
// See macula-io/macula-cli's own project memory for the fuller tradeoff.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerIdentity } from "./mesh_identity.js";
import { registerEtiquette } from "./mesh_etiquette.js";
import { registerHelp } from "./mesh_help.js";
import { registerMeshCall } from "./mesh_call.js";
import { registerMeshArtifact } from "./mesh_artifact.js";
import { registerMeshPublish } from "./mesh_publish.js";
import { registerMeshWatch } from "./mesh_watch.js";

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
help_install -- if their client supports MCP prompts).`;

const server = new McpServer(
  { name: "macula-mcp", version: "0.4.0" },
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
