// Tool: mesh_agents — a paged list of agents seen via agent.hello.
//
// Reads purely from the local roster (roster.ts) built by presence.ts's
// subscription -- no mesh round-trip, so this only ever reflects
// whoever has said hello (and this process has been running long
// enough to hear it) via mesh_hello, not "every agent on the mesh"
// universally.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { identity } from "./macula_cli.js";
import { errorContent, jsonContent } from "./reply.js";
import { listAgents, pruneStale } from "./roster.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
/** Drop agents not heard from in this long -- generous relative to the default 60s heartbeat. */
const STALE_AFTER_SECONDS = 15 * 60;

export function registerMeshAgents(server: McpServer): void {
  server.tool(
    "mesh_agents",
    "List agents seen on the mesh via their agent.hello heartbeats (started with mesh_hello). " +
      "Reads a local cache, not a live mesh query -- only reflects agents heard from while this " +
      "process has been running. Sorted most-recently-seen first.",
    {
      page: z.number().int().positive().default(1).describe("1-based page number."),
      page_size: z.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    },
    async ({ page, page_size }) => {
      try {
        pruneStale(STALE_AFTER_SECONDS);
        const { node_id: selfNodeId } = await identity();
        const { total, agents } = listAgents(page, page_size);
        return jsonContent({
          total,
          page,
          page_size,
          agents: agents.map((a) => ({
            node_id: a.node_id,
            operator_name: a.operator_name ?? undefined,
            message: a.message ?? undefined,
            model: a.model ?? undefined,
            connected_via: a.connected_via ?? undefined,
            first_seen: a.first_seen_at,
            last_seen: a.last_seen_at,
            seconds_since_seen: Math.round((Date.now() - Date.parse(a.last_seen_at)) / 1000),
            is_self: a.node_id === selfNodeId,
          })),
        });
      } catch (e) {
        return errorContent(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
