// Tool: mesh_call — invoke a procedure advertised on the mesh (REQUESTER).
//
// The agent's hands. A peer advertises a procedure ("mri:proc:realm:build",
// "...search", ...); the agent calls it over the mesh instead of a local
// sandbox or a US SaaS runner. The daemon does the `macula:call' via the
// SDK pool and returns the FEEDBACK.
//
// Args is plain JSON. The daemon converts to a CBOR term before the wire —
// we never pre-encode (memory: feedback_macula_publish_takes_terms).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daemon } from "./daemon.js";
import { errorContent, jsonContent } from "./reply.js";

export function registerMeshCall(server: McpServer): void {
  server.tool(
    "mesh_call",
    "Invoke a procedure advertised on the mesh (build, test, search, deploy on commons hardware). " +
      "Macula RPC is procedure-addressed: the pool routes to a peer that advertises it. " +
      "Returns the peer's result plus duration_ms.",
    {
      procedure: z.string().describe("Procedure URI, e.g. mri:proc:realm:build."),
      args: z
        .record(z.unknown())
        .optional()
        .describe("Structured arguments for the procedure (plain JSON; the daemon encodes the wire)."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Client-side deadline in milliseconds; daemon clamps to its own max."),
    },
    async ({ procedure, args, timeout_ms }) => {
      const res = await daemon.meshCall({ procedure, args, timeout_ms });
      return res.ok
        ? jsonContent({ result: res.result, duration_ms: res.duration_ms })
        : errorContent(res.error ?? "mesh_call failed");
    },
  );
}
