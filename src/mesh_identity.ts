// Resource: who am I on the mesh.
//
// An agent SHOULD read this before it acts. This identity is a bare
// Ed25519 node ID -- no realm, no membership state, since this server is
// a raw wire-protocol client, not a realm-joined daemon (that concept
// belonged to hecate-daemon, now dropped). Report what's actually true
// rather than fake the fields the old daemon-backed shape had.
//
// This is THIS macula-mcp server process's own identity (see
// defaultIdentityPath() in mesh_config.ts) -- freshly minted per
// process, one of several separate per-concern identities this server
// holds (mesh_watch, presence, serving and observing each use their
// own -- see mesh_config.ts's own doc comment for why). Sharing one
// identity across every concurrent mesh-mcp process/session used to
// cause real connection collisions (verified live: 5/6 concurrent calls
// failed under a shared identity, 0/6 failed once each had its own),
// which is what the per-concern split (2026-08-29) fixed.
//
// mesh://peers was dropped, not reworked: it was already an admitted
// stub even under the old daemon-backed design ("v1 surfaces an empty
// list until hecate_mesh:get_peers/0 returns real data"), and
// @macula-io/ts has no peer-listing API to expose either. A real stub in
// both directions isn't worth keeping around.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defaultIdentityPath } from "./mesh_config.js";
import { tsIdentity } from "./macula_ts_client.js";
import * as citizenship from "./citizenship.js";
import * as realm from "./realm.js";
import * as ringService from "./ring_service.js";

export function registerIdentity(server: McpServer): void {
  server.resource(
    "mesh-identity",
    "mesh://identity",
    {
      description:
        "This macula-mcp server process's own Ed25519 identity (node ID), persisted per session -- " +
        "not mesh_watch's identity, presence's, or serving's own separate ones. " +
        "Its node_id is also this agent's citizen_did in hecate-citizens; citizenship says whether it is " +
        "registered there right now (presence registers it, and renews it, automatically). ring says " +
        "whether this agent is currently serving its ring endpoint (agent.<node_id>.ring) and under which " +
        "contact policy.",
      mimeType: "application/json",
    },
    async (uri) => {
      const id = tsIdentity(defaultIdentityPath());
      const shaped = { ...id, citizen_did: id.node_id, citizenship: citizenship.status(), realm: realm.status(id.node_id), ring: ringService.status() };
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(shaped, null, 2) },
        ],
      };
    },
  );
}
