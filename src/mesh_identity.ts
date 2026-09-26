// Resource: who am I on the mesh.
//
// An agent SHOULD read this before it acts. This server has ONE identity:
// an ML-DSA node key under the fleet's pq_hybrid profile (mesh_config.ts's
// nodeKeyPath), used for every link, call, publication and served
// procedure. Its node_id is what providers see as the caller, what
// subscribers see as the publisher, and this agent's citizen_did in
// mcl-citizens.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { nodeKeyPath } from "./mesh_config.js";
import { KEY_PROFILE, selfNodeId } from "./macula_ts_client.js";
import * as citizenship from "./citizenship.js";
import * as realm from "./realm.js";
import * as ringService from "./ring_service.js";

export function registerIdentity(server: McpServer): void {
  server.resource(
    "mesh-identity",
    "mesh://identity",
    {
      description:
        "This macula-mcp server's one identity: its node_id, key file and crypto profile. The node_id is what " +
        "providers see as the caller and subscribers as the publisher, and this agent's citizen_did in " +
        "mcl-citizens; citizenship says whether it is registered there right now (presence registers and renews " +
        "it). realm says whether a person's account vouches for it. ring says whether this agent can be rung.",
      mimeType: "application/json",
    },
    async (uri) => {
      const nodeId = await selfNodeId();
      const shaped = {
        node_id: nodeId,
        key_path: nodeKeyPath(),
        profile: KEY_PROFILE,
        citizen_did: nodeId,
        citizenship: citizenship.status(),
        // mesh://identity is not the channel for a pending join's bearer
        // link; mesh_join_realm is (see realm.ts's status()).
        realm: realm.status(nodeId, { redactPending: true }),
        ring: ringService.status(),
      };
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(shaped, null, 2) }] };
    },
  );
}
