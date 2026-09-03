// Resource: who am I on the mesh.
//
// An agent SHOULD read this before it acts. macula-cli's identity is a
// bare Ed25519 node ID -- no realm, no membership state, since macula-cli
// is a raw wire-protocol client, not a realm-joined daemon (that concept
// belonged to hecate-daemon, now dropped). Report what's actually true
// rather than fake the fields the old daemon-backed shape had.
//
// This is THIS macula-mcp server process's own identity (see
// defaultIdentityPath() in macula_cli.ts) -- freshly minted per process,
// not macula-cli's own persisted default. Running `macula-cli identity`
// by hand on the same machine will report a DIFFERENT node ID. That's a
// deliberate 2026-08-29 fix, not a regression: sharing one identity
// across every concurrent mesh-mcp process/session caused real
// connection collisions (verified live: 5/6 concurrent calls failed
// under a shared identity, 0/6 failed once each had its own). mesh_watch
// uses yet another, separate identity of its own -- see its own tool
// description for why.
//
// mesh://peers was dropped, not reworked: it was already an admitted
// stub even under the old daemon-backed design ("v1 surfaces an empty
// list until hecate_mesh:get_peers/0 returns real data"), and
// macula-go-sdk has no peer-listing API for macula-cli to wrap either.
// A real stub in both directions isn't worth keeping around.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { identity } from "./macula_cli.js";
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
        "not the same identity as running macula-cli by hand, and not mesh_watch's identity either. " +
        "Its node_id is also this agent's citizen_did in hecate-citizens; citizenship says whether it is " +
        "registered there right now (presence registers it, and renews it, automatically). ring says " +
        "whether this agent is currently serving its ring endpoint (agent.<node_id>.ring) and under which " +
        "contact policy.",
      mimeType: "application/json",
    },
    async (uri) => {
      const id = await identity();
      const shaped = { ...id, citizen_did: id.node_id, citizenship: citizenship.status(), realm: realm.status(id.node_id), ring: ringService.status() };
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(shaped, null, 2) },
        ],
      };
    },
  );
}
