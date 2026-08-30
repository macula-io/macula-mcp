// Tool: mesh_watch — bounded, synchronous replacement for the old
// mesh_subscribe / mesh_unsubscribe / mesh_subscriptions / mesh_inbox
// quartet.
//
// Those four tools leaned entirely on hecate-daemon's own event-sourced
// state: a standing subscription that outlived any one HTTP call, and a
// ReckonDB-backed inbox an agent could poll later. macula-cli has no
// daemon and no storage -- nothing persists between invocations -- so
// there is no honest way to preserve "register once, poll the inbox
// later" without macula-mcp itself becoming a stateful daemon (a real
// design fork, deliberately not taken here; see macula-io/macula-cli's
// own project memory for the tradeoff that was weighed).
//
// mesh_watch is the shape that IS honest for a one-shot subprocess: the
// tool call blocks for up to duration_seconds and returns whatever
// arrived. An agent that wants "keep listening" calls it again.
//
// The 120s->3600s raise below (2026-08-30) isn't a reversal of the
// no-standing-state design above -- it's still one subprocess, one
// connect, one exit. What changed is who's expected to hold a call open
// that long: an MCP host that backgrounds a slow tool call and delivers
// its result as a notification (Claude Code does; verified live) turns
// a long duration_seconds into a real low-latency push, not a client
// stuck blocking. Found the hard way: an agent-to-agent chat loop
// re-issuing mesh_watch every ~100s to stay under the old cap spent most
// of its wall-clock time on reconnect/reschedule overhead, not on
// waiting for the next fact. 3600s (not unbounded, unlike macula-cli's
// own `-duration 0`) keeps one call from parking a station connection
// open indefinitely on a shared demo fleet.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultStation, watch } from "./macula_cli.js";
import { HELLO_TOPIC, GOODBYE_TOPIC } from "./presence.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";

const MAX_DURATION_SECONDS = 3600;

export function registerMeshWatch(server: McpServer): void {
  server.tool(
    "mesh_watch",
    "Watch a mesh topic for inbound facts for up to duration_seconds, then return whatever " +
      "arrived. This call BLOCKS for the full duration (or until count events arrive, " +
      "whichever is first) -- there is no standing/background subscription to poll later; " +
      `call this again to keep watching. Defaults to ${defaultStation()} if host isn't given. ` +
      `Presence heartbeats are ordinary facts on "${HELLO_TOPIC}"/"${GOODBYE_TOPIC}" -- watch ` +
      "those directly to react to an arrival/departure yourself instead of polling mesh_agents.",
    {
      topic: z.string().describe("Topic name (e.g. 'chat.demo')."),
      duration_seconds: z
        .number()
        .positive()
        .max(MAX_DURATION_SECONDS)
        .default(10)
        .describe(`How long to watch, in seconds (max ${MAX_DURATION_SECONDS}).`),
      count: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Stop early once this many events have arrived."),
      host: z
        .string()
        .optional()
        .describe(`Station to connect through, "host[:port]". Defaults to ${defaultStation()}.`),
    },
    async ({ topic, duration_seconds, count, host }) => {
      try {
        const events = await watch({ host, topic, durationSeconds: duration_seconds, count });
        return jsonContent({ topic, event_count: events.length, events });
      } catch (e) {
        return errorContent(describeCliError("mesh_watch failed", e));
      }
    },
  );
}
