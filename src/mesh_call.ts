// Tool: mesh_call — invoke a procedure advertised on the mesh (REQUESTER).
//
// The agent's hands. A provider advertises a procedure; the agent calls it
// over the mesh instead of a local sandbox or a US SaaS runner. The call
// goes by direct dial on the shared pool (macula_ts_client.ts): the
// provider's signed advertisement from the DHT, trusted only when the
// realm's key authorizes it, then the station it serves from. The call is
// signed with this server's identity, which is what the provider sees as
// the caller -- a capability that acts "as the caller" (mcl-mail's
// mailbox, mcl-citizens' registration, mcl-graph's provenance) needs
// nothing more in the args.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MeshError, splitRealmPrefix } from "./mesh_config.js";
import { call } from "./macula_ts_client.js";
import { describeMeshError, errorContent, jsonContent } from "./reply.js";
import { ensurePresence } from "./presence.js";
import { assertNoLikelySecret } from "./secret_scan.js";
import { toolDescription } from "./tool_description.js";

const DESCRIPTION_FULL =
  "Invoke a procedure advertised on the mesh (build, test, search, deploy on commons hardware). " +
  "The call reaches a provider directly: its signed advertisement is found in the DHT and trusted " +
  "only when the realm's key authorizes it. The provider sees this agent's identity as the caller. " +
  "Returns the provider's result plus duration_ms. Defaults to the io.macula realm. " +
  "Bytes: send a byte string in args as {\"$bytes\": \"<standard base64>\"}, e.g. " +
  "{\"channel_id\": {\"$bytes\": \"AQID\"}}; a plain string is always text. Bytes in the result " +
  "appear as {\"$bytes\": \"<base64>\"}; pass them back in the same form.";

/** MACULA_MCP_TERSE_TOOLS=1 variant -- see tool_description.ts. */
const DESCRIPTION_TERSE = `Invoke a procedure advertised on the mesh, by direct dial to a trusted provider. Returns the provider's result. Realm defaults to io.macula. Bytes appear as {"$bytes": "<base64>"}; send and pass them back in the same form.`;

/**
 * A UCAN attaches to a call only once macula-go signs post-quantum UCANs
 * (macula-io/macula-go#2); until then a configured token would be silently
 * dropped, so the call is refused by name instead.
 */
export function refuseUcan(): void {
  if (process.env.MACULA_MCP_UCAN) {
    throw new MeshError(
      "MACULA_MCP_UCAN is set, but a UCAN cannot be attached on macula 12 yet: post-quantum UCANs are " +
        "macula-io/macula-go#2. Unset it to call ungated procedures.",
    );
  }
}

export function registerMeshCall(server: McpServer): void {
  server.tool(
    "mesh_call",
    toolDescription(DESCRIPTION_FULL, DESCRIPTION_TERSE),
    {
      procedure: z
        .string()
        .describe(
          "Procedure name as advertised, e.g. mcl-rag/search_chunks_semantic, with the realm in `realm`. " +
            "The realm-prefixed form a DHT listing prints (`<64 hex>/<procedure>`) is accepted too and " +
            "split into procedure + realm for you.",
        ),
      args: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Structured arguments for the procedure (plain JSON; this server encodes the wire). Bytes as {\"$bytes\": \"<base64>\"}."),
      timeout_ms: z.number().int().positive().optional().describe("How long to wait for the result, in milliseconds (5000 by default)."),
      realm: z
        .string()
        .length(64)
        .regex(/^[0-9a-fA-F]+$/, "must be hex")
        .optional()
        .describe(
          "32-byte realm id as hex (64 chars). Omit for io.macula. A provider is only trusted in a realm " +
            "whose key this server holds (io.macula always; others through MACULA_MESH_REALMS), so " +
            "\"no trusted provider\" can mean the wrong realm, not a missing service -- find a procedure's " +
            "realm with mesh_find_records_by_type (record_type \"procedure_advertisement\").",
        ),
    },
    async ({ procedure: rawProcedure, args, timeout_ms, realm: rawRealm }) => {
      ensurePresence(server);
      try {
        refuseUcan();
        assertNoLikelySecret(args, "args");
        const { procedure, realm } = splitRealmPrefix(rawProcedure, rawRealm);
        const res = await call({ procedure, callArgs: args, timeoutMs: timeout_ms, realm, bytes: "tagged" });
        return jsonContent({ result: res.payload, duration_ms: res.duration_ms });
      } catch (e) {
        return errorContent(describeMeshError("mesh_call failed", e));
      }
    },
  );
}
