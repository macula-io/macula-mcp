// Tool: mesh_serve — serve a procedure other mesh agents can call,
// answered by a local shell command run once per inbound call.
//
// The biggest exposure this server offers: every other tool is a
// one-shot action THIS process's own caller initiated. Registering a
// procedure here creates a standing inbound trigger any mesh caller can
// invoke, repeatedly, for as long as it stays registered -- see
// mesh://etiquette for the full framing. The command's stdin is the
// caller's own JSON payload (never shell-interpolated into the command
// string itself, so a malicious caller's payload can't inject shell
// syntax); its stdout becomes the reply; the caller's verified node_id is
// in MACULA_MCP_CALLER. A non-zero exit, a timeout, or invalid JSON on
// stdout becomes an error reply to that caller (serve.ts's runExec).
//
// The procedure is served in this agent's own namespace, ~<node_id>/<name>:
// no org or realm vouches for it, only this agent can serve it, and any
// node can call it.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describeMeshError, errorContent, jsonContent } from "./reply.js";
import * as serveModule from "./serve.js";
import { toolDescription } from "./tool_description.js";

/** Never let a misconfigured caller leave a hung command running indefinitely. */
const DEFAULT_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 60;

const DESCRIPTION_FULL =
  "Serve a procedure on the mesh, answered by a local shell command run once per inbound call " +
  "(its stdin is the caller's JSON payload, its stdout is the reply, MACULA_MCP_CALLER is the caller's " +
  "verified node_id). It is served in this agent's own namespace: callers call ~<your node_id>/<name>, " +
  "which the result names. THIS IS A STANDING INBOUND SURFACE, not a one-shot action: once " +
  "registered, any mesh caller can trigger the command repeatedly until mesh_unserve is called or " +
  "this process exits. Never register a command you would not want a stranger able to run " +
  "repeatedly on this machine. Pair with mesh_unserve to stop serving deliberately. " +
  "Bytes in the caller's payload appear on stdin as {\"$bytes\": \"<base64>\"}; write bytes to stdout in the same form.";

/** MACULA_MCP_TERSE_TOOLS=1 variant -- see tool_description.ts. The standing-inbound-surface warning is the single most safety-critical caveat this whole server has -- kept in full force, not shortened away. */
const DESCRIPTION_TERSE =
  "Serve ~<your node_id>/<name>, answered by a local shell command run once per inbound call (stdin = " +
  "caller's JSON, stdout = reply). THIS IS A STANDING INBOUND SURFACE: any mesh caller can trigger it " +
  "repeatedly until mesh_unserve or process exit. Never register a command you wouldn't want a " +
  "stranger running repeatedly on this machine. Bytes appear as {\"$bytes\": \"<base64>\"} on stdin; reply with bytes in the same form.";

export function registerMeshServe(server: McpServer): void {
  server.tool(
    "mesh_serve",
    toolDescription(DESCRIPTION_FULL, DESCRIPTION_TERSE),
    {
      name: z
        .string()
        .min(1)
        .describe("The procedure's name in this agent's own namespace, one segment, e.g. \"summarize\" (served as ~<node_id>/summarize)."),
      exec: z
        .string()
        .min(1)
        .describe(
          "Shell command to run once per inbound call. Receives the call's JSON payload on stdin and the caller's " +
            "node_id in MACULA_MCP_CALLER; its entire stdout is parsed as the JSON reply (empty stdout replies null). " +
            "Bytes appear as {\"$bytes\": \"<base64>\"} both ways.",
        ),
      exec_timeout_seconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`How long one invocation may run before it's killed (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}).`),
    },
    async ({ name, exec, exec_timeout_seconds }) => {
      try {
        const execTimeoutSeconds = Math.min(MAX_TIMEOUT_SECONDS, exec_timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS);
        return jsonContent(await serveModule.serve({ name, exec, execTimeoutSeconds, bytes: "tagged" }));
      } catch (e) {
        return errorContent(describeMeshError("mesh_serve failed", e));
      }
    },
  );
}
