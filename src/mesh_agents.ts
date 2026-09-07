// Tool: mesh_agents — a paged list of agents seen via agent.hello.
//
// Reads purely from the local roster (roster.ts) built by presence.ts's
// subscription -- no mesh round-trip, so this only ever reflects
// whoever has said hello (and this process has been running long
// enough to hear it) via mesh_hello, not "every agent on the mesh"
// universally.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorContent, jsonContent } from "./reply.js";
import * as presence from "./presence.js";
import { listAgents, pruneStale } from "./roster.js";
import { petname } from "./petname.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
/** Drop agents not heard from in this long -- generous relative to the default 60s heartbeat. */
const STALE_AFTER_SECONDS = 15 * 60;
/**
 * (macula-io/macula-mcp#3) Below STALE_AFTER_SECONDS, every entry used to
 * look identical -- a peer silent for 500s (8+ missed 60s heartbeats,
 * almost certainly gone: crashed, partitioned, or exited without
 * mesh_goodbye) read exactly like one seen 5s ago, forcing every caller to
 * redo this math itself against a heartbeat interval it usually doesn't
 * even have. 3 missed beats is the threshold: tolerates one dropped
 * heartbeat from ordinary network jitter without flagging it, while still
 * catching a dead agent well before the 15-minute hard prune.
 */
const STALE_AFTER_MISSED_BEATS = 3;

export function registerMeshAgents(server: McpServer): void {
  server.tool(
    "mesh_agents",
    "List agents seen on the mesh via their agent.hello heartbeats (started with mesh_hello). " +
      "Reads a persistent local SQLite roster, not a live mesh query -- it survives a restart of this " +
      "process, but only reflects agents this identity has ever heard a hello from (entries unseen for " +
      "15 minutes are pruned). Sorted most-recently-seen first. `stale: true` flags an entry that has " +
      `missed roughly ${STALE_AFTER_MISSED_BEATS}+ of its own reported heartbeats -- probably gone, ` +
      "well before the 15-minute hard prune.",
    {
      page: z.number().int().positive().default(1).describe("1-based page number."),
      page_size: z.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    },
    async ({ page, page_size }) => {
      try {
        pruneStale(STALE_AFTER_SECONDS);
        // The node_id THIS process's own agent.hello beats actually carry
        // (presence.ts's state.nodeId) -- not a fresh identity() call.
        // identity() resolves the separate "default" identity (used by
        // mesh_call/mesh_put/mesh_get/mesh_publish) via a path that's
        // minted fresh per process and cached only for that process's
        // lifetime, so a second, independent identity() call here could
        // never reliably match what presence actually published, even
        // within the same session -- self-detection was silently wrong
        // as a result (verified live 2026-09-02: the roster's own
        // self-entry, confirmed via mesh_hello's node_id, came back
        // is_self:false). No presence yet -- correctly nobody is "self".
        const selfNodeId = presence.currentNodeId();
        const { total, agents } = listAgents(page, page_size);
        return jsonContent({
          total,
          page,
          page_size,
          agents: agents.map((a) => {
            const secondsSinceSeen = Math.round((Date.now() - Date.parse(a.last_seen_at)) / 1000);
            // null/unparseable interval_seconds means either a pre-#3 peer
            // (never sent one) or a fresh entry this process hasn't stored
            // it for yet -- fall back to the shared default rather than
            // treating "unknown" as "definitely stale" or "never stale".
            const intervalSeconds = a.interval_seconds !== null && Number.isFinite(Number(a.interval_seconds)) ? Number(a.interval_seconds) : presence.DEFAULT_INTERVAL_SECONDS;
            return {
              node_id: a.node_id,
              petname: petname(a.node_id),
              operator_name: a.operator_name ?? undefined,
              message: a.message ?? undefined,
              model: a.model ?? undefined,
              connected_via: a.connected_via ?? undefined,
              first_seen: a.first_seen_at,
              last_seen: a.last_seen_at,
              seconds_since_seen: secondsSinceSeen,
              stale: secondsSinceSeen > STALE_AFTER_MISSED_BEATS * intervalSeconds,
              is_self: a.node_id === selfNodeId,
            };
          }),
        });
      } catch (e) {
        return errorContent(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
