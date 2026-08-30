// Tool: mesh_hello — announce this agent's presence on the mesh.
//
// Deliberately explicit rather than automatic on every macula-mcp
// startup: broadcasting onto a real shared mesh (the default station
// is macula.io's public demo fleet, not a sandbox) should be something
// an agent decides to do, not a side effect of merely connecting.
//
// First call: prints a welcome banner, publishes one agent.hello
// immediately, and starts a periodic heartbeat (see presence.ts) that
// keeps republishing it -- plus a durable subscription to everyone
// else's agent.hello/agent.goodbye, feeding mesh_agents' roster. A
// later call while already active just updates operator_name/message
// for future heartbeats, without restarting anything.

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultStation } from "./macula_cli.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";
import * as presence from "./presence.js";

const DEFAULT_BANNER = `
   __  __  _____   ___  _   _  _      _
  |  \\/  ||_   _| / __|| | | || |    /_\\
  | |\\/| |  | |  | (__ | |_| || |__ / _ \\
  |_|  |_|  |_|   \\___| \\___/ |____/_/ \\_\\
  macula mesh -- an agent just said hello
`;

function banner(): string {
  const path = process.env.MACULA_MCP_BANNER_FILE;
  if (!path) return DEFAULT_BANNER;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return DEFAULT_BANNER; // a missing/unreadable custom banner falls back quietly, same spirit as identity's load-or-generate
  }
}

export function registerMeshHello(server: McpServer): void {
  server.tool(
    "mesh_hello",
    "Announce this agent's presence on the mesh: prints a welcome banner and starts a periodic " +
      "agent.hello heartbeat (default every 60s) plus a durable subscription to other agents' " +
      "hellos, feeding mesh_agents' roster. Calling this again while already active just updates " +
      "operator_name/message for future heartbeats. Pair with mesh_goodbye to leave deliberately.",
    {
      operator_name: z.string().optional().describe("Customizable human-readable name for whoever's behind this agent."),
      message: z.string().optional().describe("A short greeting or status, sent with every heartbeat."),
      interval_seconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Heartbeat interval in seconds (default 60, minimum 10)."),
      host: z
        .string()
        .optional()
        .describe(`Station to connect through, "host[:port]". Defaults to ${defaultStation()}.`),
    },
    async ({ operator_name, message, interval_seconds, host }) => {
      try {
        const result = await presence.start({
          host,
          // Explicit args win; MACULA_MCP_OPERATOR_NAME/HELLO_MESSAGE are
          // an operator's standing default so an agent doesn't have to
          // type them on every call, same spirit as MACULA_MCP_IDENTITY
          // pinning a default elsewhere in this server.
          operatorName: operator_name ?? process.env.MACULA_MCP_OPERATOR_NAME,
          message: message ?? process.env.MACULA_MCP_HELLO_MESSAGE,
          intervalSeconds: interval_seconds,
        });
        return jsonContent({ banner: banner(), ...result });
      } catch (e) {
        return errorContent(describeCliError("mesh_hello failed", e));
      }
    },
  );
}
