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
import { call, defaultStation } from "./macula_cli.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";

export function registerMeshCall(server: McpServer): void {
  server.tool(
    "mesh_call",
    "Invoke a procedure advertised on the mesh (build, test, search, deploy on commons hardware). " +
      "Macula RPC is procedure-addressed: the target station routes to a peer that advertises it. " +
      `Returns the peer's result plus duration_ms. Defaults to ${defaultStation()} if host isn't given.`,
    {
      procedure: z.string().describe("Procedure URI, e.g. mri:proc:realm:build."),
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
    },
    async ({ procedure, args, timeout_ms, host }) => {
      try {
        const res = await call({ host, procedure, callArgs: args, timeoutMs: timeout_ms });
        return jsonContent({ result: res.payload, responded_by: res.responded_by, duration_ms: res.duration_ms });
      } catch (e) {
        return errorContent(describeCliError("mesh_call failed", e));
      }
    },
  );
}
