// Resource: who am I on the mesh.
//
// An agent SHOULD read this before it acts. Every Macula leaf chains to an
// accountable realm + foundation — the agent needs to know which authority
// its actions carry (memory: feedback_no_anonymity_only_sovereignty).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { daemon } from "./daemon.js";

export function registerIdentity(server: McpServer): void {
  server.resource(
    "mesh-identity",
    "mesh://identity",
    {
      description:
        "This node's mesh identity: node id, MRI, realm membership state, and mesh connection state.",
      mimeType: "application/json",
    },
    async (uri) => {
      const id = await daemon.identity();
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(id, null, 2) },
        ],
      };
    },
  );

  server.resource(
    "mesh-peers",
    "mesh://peers",
    {
      description: "Reachable mesh peers and the daemon's own status. " +
        "v1 surfaces an empty list until hecate_mesh:get_peers/0 returns real data.",
      mimeType: "application/json",
    },
    async (uri) => {
      const reply = await daemon.peers();
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(reply, null, 2) },
        ],
      };
    },
  );
}
