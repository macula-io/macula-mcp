// Tool: mesh_serve — advertise a procedure other mesh agents can call,
// answered by a local shell command run once per inbound call.
//
// The biggest exposure this server offers: every other tool is a
// one-shot action THIS process's own caller initiated. Registering a
// procedure here creates a standing inbound trigger any mesh caller can
// invoke, repeatedly, for as long as it stays registered -- see
// mesh://etiquette for the full framing. The command's stdin is the
// caller's own JSON payload (never shell-interpolated into the command
// string itself, so a malicious caller's payload can't inject shell
// syntax); its stdout becomes the reply. A non-zero exit, a timeout, or
// invalid JSON on stdout all become a normal error reply to that
// caller (serve.ts's runExec, scoped per registration on the same
// Session) rather than affecting any OTHER procedure this same call has
// registered.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultStation } from "./mesh_config.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";
import * as serveModule from "./serve.js";

/** Never let a misconfigured caller leave a hung command running indefinitely. */
const DEFAULT_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 60;

export function registerMeshServe(server: McpServer): void {
  server.tool(
    "mesh_serve",
    "Advertise a procedure on the mesh, answered by a local shell command run once per inbound call " +
      "(its stdin is the caller's JSON payload, its stdout is the reply). Starts this process's own " +
      "serve-daemon on first use. THIS IS A STANDING INBOUND SURFACE, not a one-shot action: once " +
      "registered, any mesh caller can trigger the command repeatedly until mesh_unserve is called or " +
      "this process exits. Never register a command you would not want a stranger able to run " +
      "repeatedly on this machine. Pair with mesh_unserve to stop serving deliberately.",
    {
      procedure: z.string().min(1).describe("The procedure name to advertise, e.g. \"my_agent.summarize\"."),
      exec: z
        .string()
        .min(1)
        .describe(
          "Shell command to run once per inbound call. Receives the call's JSON payload on stdin; " +
            "its entire stdout is parsed as the JSON reply (empty stdout replies null).",
        ),
      exec_timeout_seconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`How long one invocation may run before it's killed (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}).`),
      host: z
        .string()
        .optional()
        .describe(`Station to connect through, "host[:port]". Defaults to ${defaultStation()}.`),
    },
    async ({ procedure, exec, exec_timeout_seconds, host }) => {
      try {
        const execTimeoutSeconds = Math.min(MAX_TIMEOUT_SECONDS, exec_timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS);
        const result = await serveModule.serve({ procedure, exec, execTimeoutSeconds, host });
        return jsonContent(result);
      } catch (e) {
        return errorContent(describeCliError("mesh_serve failed", e));
      }
    },
  );
}
