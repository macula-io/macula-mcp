#!/usr/bin/env node
// macula-mcp — a Model Context Protocol server that exposes the Macula mesh to
// any agent harness (Claude Code, Cursor, Cline, Continue, ...).
//
// Topology: thin client. macula-mcp speaks MCP over stdio to the agent, and
// HTTP-over-Unix-socket to the local hecate-daemon. The daemon — already a
// mesh client, already the realm-accountable leaf — does the QUIC/DHT/RPC.
// macula-mcp owns no mesh logic and no identity logic. Same discipline as
// macula-io/git-remote-mesh.
//
//   agent harness  ──MCP/stdio──▶  macula-mcp  ──HTTP/UDS──▶  hecate-daemon  ──QUIC──▶  mesh

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerIdentity } from "./mesh_identity.js";
import { registerActivity } from "./mesh_activity.js";
import { registerMeshCall } from "./mesh_call.js";
import { registerMeshArtifact } from "./mesh_artifact.js";
import { registerMeshPublish } from "./mesh_publish.js";
import { registerMeshSubscribe } from "./mesh_subscribe.js";
import { registerMeshUnsubscribe } from "./mesh_unsubscribe.js";
import { registerMeshSubscriptions } from "./mesh_subscriptions.js";
import { registerMeshInbox } from "./mesh_inbox.js";

const server = new McpServer({
  name: "macula-mcp",
  version: "0.2.0",
});

// Resources — read-only context an agent should consult before acting.
registerIdentity(server);
registerActivity(server);
registerMeshInbox(server); // also registers the mesh_inbox tool below

// Tools — actions, each producing an accountable event in the daemon's store.
registerMeshCall(server);
registerMeshArtifact(server);
registerMeshPublish(server);
registerMeshSubscribe(server);
registerMeshUnsubscribe(server);
registerMeshSubscriptions(server);

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
