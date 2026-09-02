// Tool: mesh_call — invoke a procedure advertised on the mesh (REQUESTER).
//
// The agent's hands. A peer advertises a procedure; the agent calls it
// over the mesh instead of a local sandbox or a US SaaS runner.
// macula-cli does the actual macula:call over QUIC as a one-shot
// subprocess (connect, call, exit) and returns the RESULT payload or a
// BOLT#4-vocabulary error.
//
// Unlike the old daemon-backed version, this needs a target station:
// macula-cli isn't already connected to one the way a standing daemon
// was. `host` defaults to MACULA_MESH_STATION (or macula-cli's own
// well-known demo station) so most callers never need to think about it.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { call, defaultStation, identitySign, splitRealmPrefix } from "./macula_cli.js";
import { withIdentityProof } from "./citizenship.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";
import { ensurePresence } from "./presence.js";

export function registerMeshCall(server: McpServer): void {
  server.tool(
    "mesh_call",
    "Invoke a procedure advertised on the mesh (build, test, search, deploy on commons hardware). " +
      "Macula RPC is procedure-addressed: the target station routes to a peer that advertises it. " +
      `Returns the peer's result plus duration_ms. Defaults to ${defaultStation()} if host isn't given.`,
    {
      procedure: z
        .string()
        .describe(
          "Procedure name as advertised, e.g. hecate-rag.search_chunks_semantic, with the realm in `realm`. " +
            "The realm-prefixed form a DHT procedure_advertisement prints (`<64 hex>/<procedure>`) is " +
            "accepted too and split into procedure + realm for you.",
        ),
      args: z
        .record(z.unknown())
        .optional()
        .describe("Structured arguments for the procedure (plain JSON; macula-cli encodes the wire)."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Deadline in milliseconds for the connect + call."),
      host: z
        .string()
        .optional()
        .describe(`Station to connect through, "host[:port]". Defaults to ${defaultStation()}.`),
      realm: z
        .string()
        .length(64)
        .regex(/^[0-9a-fA-F]+$/, "must be hex")
        .optional()
        .describe(
          "32-byte realm as hex (64 chars), the wire-level tag a procedure is scoped to -- distinct from " +
            "the realm word inside an MRI string. Omit for the default all-zero realm (protocol-internal, " +
            "most demo-fleet capabilities). A capability served under its own realm is unreachable without " +
            "the right one here -- unknown_next_peer with the default realm doesn't necessarily mean the " +
            "procedure doesn't exist.",
        ),
      direct: z
        .boolean()
        .optional()
        .describe(
          "Resolve the procedure's DHT direct-dial advertisement and call its serving station directly, " +
            "in one hop, instead of routing through <host>'s own advertise-gossip routes. host is then used " +
            "only to query the DHT, not to carry the call. Ordinary (non-direct) calls depend on inter-" +
            "station gossip having already propagated a route from host to the actual server -- on a large " +
            "or recently-changed mesh that isn't always true yet, and the call can fail (often as " +
            "temporary_relay_failure) even though the target is live and reachable. direct-dial sidesteps " +
            "that gap, at the cost of failing outright if the provider only advertised the plain way " +
            "(\"procedure has no direct-dial advertisement\"). Prefer this whenever a plain call fails " +
            "against a target you otherwise know is up.",
        ),
      prove_identity: z
        .boolean()
        .optional()
        .describe(
          "Sign a {citizen_did, timestamp, procedure} ownership proof with this server's own identity and " +
            "merge citizen_did + proof into args, for capabilities gated by an ownership proof " +
            "(hecate_mail.open_mailbox, hecate_graph.learn_link, hecate_citizens.register_presence). The proof " +
            "is bound to this procedure and to this identity, so it overrides any citizen_did/proof you passed. " +
            "Presence already registers this identity in hecate-citizens; this is for calling the gated " +
            "capabilities as that citizen.",
        ),
    },
    async ({ procedure: rawProcedure, args, timeout_ms, host, realm: rawRealm, direct, prove_identity }) => {
      ensurePresence(server);
      try {
        // Split here, before signing: an ownership proof is bound to the
        // procedure name the server checks, which is the bare one.
        const { procedure, realm } = splitRealmPrefix(rawProcedure, rawRealm);
        const callArgs = prove_identity ? withIdentityProof(args, await identitySign({ procedure })) : args;
        const res = await call({ host, procedure, callArgs, timeoutMs: timeout_ms, realm, direct });
        return jsonContent({ result: res.payload, responded_by: res.responded_by, duration_ms: res.duration_ms });
      } catch (e) {
        return errorContent(describeCliError("mesh_call failed", e));
      }
    },
  );
}
