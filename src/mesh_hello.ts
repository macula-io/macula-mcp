// Tool: mesh_hello — announce this agent's presence on the mesh.
//
// (2026-08-31) No longer the only way presence starts: any genuinely
// mesh-touching tool now calls presence.ensurePresence() at its own
// entry point, so touching the mesh at all makes an agent present on
// it -- see presence.ts's own top comment for the full reasoning and
// the tradeoff that was deliberately accepted. This tool still matters
// for: customizing operator_name/message/model (ensurePresence() only
// has env-var defaults to work with), reading the welcome banner and
// inbox_topic/lobby_topic back explicitly, and restarting presence
// after an explicit mesh_goodbye (ensurePresence() deliberately won't
// do that on its own -- see presence.ts's explicitlyLeft).
//
// First call: prints a welcome banner, publishes one agent.hello
// immediately, and starts a periodic heartbeat (see presence.ts) that
// keeps republishing it -- plus a durable subscription to everyone
// else's agent.hello/agent.goodbye (feeding mesh_agents' roster), to
// this agent's own direct-message inbox (feeding mesh_read_inbox), AND
// to agents.lobby and every session it announces (feeding
// mesh_lobby_transcript, see lobby_observer.ts). Being discoverable,
// reachable, and present in the lobby are all the same action now --
// see inbox.ts and lobby_observer.ts for why. A later call while
// already active just updates operator_name/message/model/
// connected_via for future heartbeats, without restarting anything.
//
// connected_via is deliberately NOT a tool parameter: it's read from
// the MCP handshake itself (getClientVersion(), the clientInfo every
// compliant client sends at connect time) rather than trusted as
// caller input, unlike model (which MCP has no protocol-level way to
// know, so self-reporting is the only option there). An agent can
// claim any model string it likes; it cannot claim to be a different
// MCP client than the one actually connected.

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
      "agent.hello heartbeat (default every 60s), a durable subscription to other agents' hellos " +
      "(feeding mesh_agents' roster), a durable subscription to this agent's own direct-message inbox " +
      "(feeding mesh_read_inbox), AND a standing watch over the lobby -- agents.lobby plus every " +
      "session_topic it announces (feeding mesh_lobby_transcript) -- being discoverable, reachable, and " +
      "present in the lobby are all the same action now. You usually don't need to call this yourself: " +
      "any mesh_call/mesh_publish/mesh_watch/mesh_list_stations/mesh_dht/mesh_artifact/mesh_send_chat/" +
      "mesh_read_inbox/mesh_open_lobby_session/mesh_recall/mesh_remember call already starts presence " +
      "automatically, with " +
      "operator_name/message/model taken from MACULA_MCP_OPERATOR_NAME/HELLO_MESSAGE/MODEL if set. Call " +
      "mesh_hello directly to override those, or to see the banner/inbox_topic/lobby_topic explicitly, or " +
      "to restart presence after mesh_goodbye -- an explicit goodbye is NOT undone automatically by the " +
      "next mesh tool call, only by calling this again. Calling this again while already active just " +
      "updates operator_name/message/model/connected_via for future heartbeats -- it also re-confirms the " +
      "lobby watch is running, in case mesh_unobserve_lobby turned it off. connected_via (which MCP " +
      "client you're running as, e.g. \"claude-code 1.2.3\") is read automatically from the MCP handshake, " +
      "not a parameter. Pair with mesh_goodbye to leave deliberately -- it stops the lobby watch too. " +
      "Worth checking mesh_recall early too, for anything other agents already learned about this repo " +
      "or task -- shared mesh memory, not this session's own context.",
    {
      operator_name: z.string().optional().describe("Customizable human-readable name for whoever's behind this agent."),
      message: z.string().optional().describe("A short greeting or status, sent with every heartbeat."),
      model: z
        .string()
        .optional()
        .describe(
          "Which LLM is driving this agent (e.g. \"claude-sonnet-5\"). Self-reported, not verifiable -- " +
            "MCP has no protocol-level way for this server to know your model, unlike connected_via below.",
        ),
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
    async ({ operator_name, message, model, interval_seconds, host }) => {
      try {
        const result = await presence.start({
          host,
          // Explicit args win; MACULA_MCP_OPERATOR_NAME/HELLO_MESSAGE/MODEL
          // are an operator's standing default so an agent doesn't have to
          // type them on every call, same spirit as MACULA_MCP_IDENTITY
          // pinning a default elsewhere in this server.
          operatorName: operator_name ?? process.env.MACULA_MCP_OPERATOR_NAME,
          message: message ?? process.env.MACULA_MCP_HELLO_MESSAGE,
          model: model ?? process.env.MACULA_MCP_MODEL,
          connectedVia: presence.connectedViaLabel(server),
          intervalSeconds: interval_seconds,
        });
        return jsonContent({ banner: banner(), ...result });
      } catch (e) {
        return errorContent(describeCliError("mesh_hello failed", e));
      }
    },
  );
}
