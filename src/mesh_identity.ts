// Resource: who am I on the mesh.
//
// An agent SHOULD read this before it acts. macula-cli's identity is a
// bare Ed25519 node ID -- no realm, no membership state, since macula-cli
// is a raw wire-protocol client, not a realm-joined daemon (that concept
// belonged to hecate-daemon, now dropped). Report what's actually true
// rather than fake the fields the old daemon-backed shape had.
//
// mesh://peers was dropped, not reworked: it was already an admitted
// stub even under the old daemon-backed design ("v1 surfaces an empty
// list until hecate_mesh:get_peers/0 returns real data"), and
// macula-go-sdk has no peer-listing API for macula-cli to wrap either.
// A real stub in both directions isn't worth keeping around.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { identity } from "./macula_cli.js";

export function registerIdentity(server: McpServer): void {
  server.resource(
    "mesh-identity",
    "mesh://identity",
    {
      description: "This node's Ed25519 identity (node ID), minted and persisted locally by macula-cli.",
      mimeType: "application/json",
    },
    async (uri) => {
      const id = await identity();
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(id, null, 2) },
        ],
      };
    },
  );
}
