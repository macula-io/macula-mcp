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
import { registerMeshCall } from "./mesh_call.js";
import { registerMeshArtifact } from "./mesh_artifact.js";
import { registerMeshPublish } from "./mesh_publish.js";
import { registerMeshWatch } from "./mesh_watch.js";

const server = new McpServer({
  name: "macula-mcp",
  version: "0.3.0",
});

// Resources — read-only context an agent should consult before acting.
registerIdentity(server);

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
