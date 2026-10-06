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
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { MeshError, splitRealmPrefix } from "./mesh_config.js";
import { callWithReport, type Seal } from "./macula_ts_client.js";
import { describeMeshError, errorContent, jsonContent } from "./reply.js";
import { ensurePresence } from "./presence.js";
import { assertNoLikelySecret } from "./secret_scan.js";
import { toolDescription } from "./tool_description.js";

const DESCRIPTION_FULL =
  "Invoke a procedure advertised on the mesh (build, test, search, deploy on commons hardware). " +
  "The call reaches a provider directly: its signed advertisement is found in the DHT and trusted " +
  "only when the realm's key authorizes it. The provider sees this agent's identity as the caller. " +
  "Returns the provider's result plus duration_ms, and seal: whether this exchange went sealed " +
  "(sealed 1: sealed to the provider's advertised key, seal_key_id names it; sealed 0: in the clear), " +
  "the provider it was addressed to, and means, which says it in words. Defaults to the io.macula realm. " +
  "Bytes: send a byte string in args as {\"$bytes\": \"<standard base64>\"}, e.g. " +
  "{\"channel_id\": {\"$bytes\": \"AQID\"}}; a plain string is always text. Bytes in the result " +
  "appear as {\"$bytes\": \"<base64>\"}; pass them back in the same form. " +
  "prove_ownership: 1 attaches an ownership proof (asserted_by) signed by this agent's key, valid only " +
  "for these args, this procedure and realm, once; what a provider does with one is its own policy " +
  "(mcl-graph's learn_link credits a valid one's identity, ignores an invalid one and refuses a " +
  "repeated one). args must not carry \"caller\". " +
  "The call is sealed to the provider's advertised KEM key whenever its advertisement names one " +
  "(confidential \"preferred\", the default); confidential \"required\" never calls a provider that names " +
  "none and fails with code=confidentiality and its reason instead. code=sealed_refused from the provider " +
  "means it could not open the sealed call even after one reseal to the key it named. " +
  "ucan: 1 presents this server's UCAN (the file MACULA_MCP_UCAN names) to a gated procedure; a gated " +
  "provider that refuses it, or a call made without one, fails with code=unauthorized.";

/** MACULA_MCP_TERSE_TOOLS=1 variant -- see tool_description.ts. */
const DESCRIPTION_TERSE = `Invoke a procedure advertised on the mesh, by direct dial to a trusted provider. Returns the provider's result. Realm defaults to io.macula. Bytes appear as {"$bytes": "<base64>"}; send and pass them back in the same form. prove_ownership: 1 signs args with an ownership proof, for a provider that reads one. Sealed to a provider that names a KEM key; confidential "required" refuses one that names none. The result's seal says whether this call went sealed (1) or in the clear (0), and means spells it out. ucan: 1 presents this server's UCAN (MACULA_MCP_UCAN) to a gated procedure.`;

/**
 * The UCAN this server presents when a call asks for it: the file
 * MACULA_MCP_UCAN names holds the token on its first line and its chain's
 * parents (proofs) on the lines after, one token each. Read at each call, so a
 * renewed token is picked up without a restart. A call that asks for a UCAN
 * when none is configured is refused by name, never sent without one.
 */
export async function presentedUcan(): Promise<{ ucan: string; proofs: string[] }> {
  const path = process.env.MACULA_MCP_UCAN;
  if (!path) {
    throw new MeshError("ucan: 1 asks for a UCAN, but MACULA_MCP_UCAN is not set: point it at a file holding the token.");
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    throw new MeshError(`MACULA_MCP_UCAN names ${path}, which cannot be read: ${(e as Error).message}`);
  }
  const [ucan, ...proofs] = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  if (ucan === undefined) throw new MeshError(`MACULA_MCP_UCAN names ${path}, which holds no token.`);
  return { ucan, proofs };
}

/** The seal report with what it says, in words an agent cannot mistake: sealed
 * 0 is never a success signal. It states that sealing ran on this exchange,
 * nothing more (macula's DESIGN_E2E_SEAL_REPORT). */
export function withMeaning(seal: Seal): Seal & { means: string } {
  return {
    ...seal,
    means: seal.sealed === 1
      ? "This request was sealed to the provider's advertised key (seal_key_id) and its answer opened under " +
        "that key. That is all it says: nothing about what the provider does with the payload."
      : "This request was NOT sealed: it and its answer went in the clear, because the provider names no KEM " +
        "key. Stations on the path could read them. Pass confidential \"required\" to refuse such a call instead.",
  };
}

export function registerMeshCall(server: McpServer): void {
  server.registerTool(
    "mesh_call",
    {
      description: toolDescription(DESCRIPTION_FULL, DESCRIPTION_TERSE),
      inputSchema: {
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
        prove_ownership: z
          .union([z.literal(0), z.literal(1)])
          .optional()
          .describe(
            "1 attaches an ownership proof v2 (mcl-om#7) to args, under asserted_by: this agent's key vouches " +
              "for every field, for this procedure in this realm, once, and the proof verifies for nothing else. " +
              "What a provider does with a proof that does not verify is its own policy. A provider's handler " +
              "runs at most once per call, so the proof is never replayed by the transport. 0 or omitted: none. " +
              "args must not carry \"caller\".",
          ),
        confidential: z
          .enum(["preferred", "required"])
          .optional()
          .describe(
            "\"preferred\" (default): sealed to the provider's advertised KEM key when its advertisement names one, " +
              "in the clear when it names none. \"required\": never called in the clear; a provider that names no key " +
              "fails with code=confidentiality (reason=no_kem_key). A sealed call never falls back to the clear. " +
              "The result's seal reports whether it went sealed either way; \"required\" is how you refuse a clear " +
              "call before it is sent.",
          ),
        ucan: z
          .union([z.literal(0), z.literal(1)])
          .optional()
          .describe(
            "1 presents this server's UCAN to a gated procedure: the token in the file MACULA_MCP_UCAN names " +
              "(first line), with its chain's parents (the lines after). A gated provider checks it before its " +
              "handler runs and refuses with code=unauthorized. 0 or omitted: no token is sent, so a gated " +
              "procedure refuses the call. Fails by name when asked for and none is configured.",
          ),
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
    },
    async ({ procedure: rawProcedure, args, timeout_ms, realm: rawRealm, prove_ownership, confidential, ucan }) => {
      ensurePresence(server);
      try {
        assertNoLikelySecret(args, "args");
        const { procedure, realm } = splitRealmPrefix(rawProcedure, rawRealm);
        const presented = ucan === 1 ? await presentedUcan() : {};
        const res = await callWithReport({ procedure, callArgs: args, timeoutMs: timeout_ms, realm, bytes: "tagged",
          proveOwnership: prove_ownership === 1, confidential, ...presented });
        return jsonContent({ result: res.payload, duration_ms: res.duration_ms, seal: withMeaning(res.seal) });
      } catch (e) {
        return errorContent(describeMeshError("mesh_call failed", e));
      }
    },
  );
}
