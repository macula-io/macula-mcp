// Tool: mesh_wait_ring -- block for the next incoming ring, without
// polling mesh_read_inbox.
//
// The same shape as mesh_wait_room.ts, and reuses the identical
// mechanism: ring_service.ts's handleRing() already calls rings.ts's
// recordRing() on every real inbound ring -- open/closed/allowlist
// policies record theirs already answered, "ask" records a still-pending
// one -- the moment ring serving is active (presence.start(), the moment
// any mesh tool call happens), independent of whether anything is
// waiting on it. That existing write is this tool's whole "background
// tap"; rings.ts's own waitRing() just polls the local rings table for
// the next row past a cursor, the same shape rooms.ts's waitForReply/
// waitRoom already use for room facts (see that module's own doc for
// why: cheap local reads, no mesh round trip per poll).
//
// What this does NOT change, same as mesh_wait_room.ts: MCP is
// request/response, and this call still occupies this agent's own turn
// for up to wait_seconds -- there is no channel for macula-mcp to push a
// fresh turn into an idle client on its own initiative. See
// mesh_etiquette.ts's own "Conversations" section for the genuinely
// non-blocking alternative (a harness-scheduled check-in) for when an
// agent would rather free its turn than hold it open.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultIdentityPath } from "./mesh_config.js";
import { tsIdentity } from "./macula_ts_client.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";
import { ensurePresence } from "./presence.js";
import * as presence from "./presence.js";
import * as ringService from "./ring_service.js";
import { waitRing } from "./rings.js";
import { petname } from "./petname.js";

const MAX_WAIT_SECONDS = 3600;

export function registerMeshWaitRing(server: McpServer): void {
  server.tool(
    "mesh_wait_ring",
    "Block for up to wait_seconds (max 3600) for the next incoming ring -- the passive counterpart to " +
      "polling mesh_read_inbox for a new one under rings.pending. Covers every incoming ring, not only " +
      "ones still awaiting your own answer: open/closed/allowlist policies resolve theirs immediately, " +
      "'ask' leaves one pending for mesh_answer_ring -- this call returns the instant any of them is " +
      "recorded, so check the returned ring's own answer field. Reads the same background recording " +
      "ring serving already does on every real inbound ring (active from presence.start() onward, " +
      "independent of this call), so there is nothing new to start watching. An MCP host that backgrounds " +
      "a slow tool call and delivers the result as a notification (Claude Code does) turns this into real " +
      "low-latency push, not a client stuck blocking. Still occupies this agent's own turn for the " +
      "duration -- there is no way for this server to hand a fresh turn to an idle client on its own; if " +
      "you would rather free this turn entirely and check back later, use your own harness's scheduler " +
      "(see mesh://etiquette) instead of a manual sleep and re-calling this or mesh_read_inbox. Never " +
      "call this in a sleep-then-check loop -- one call with the full wait_seconds you actually want does " +
      "the same waiting server-side, for free.",
    {
      wait_seconds: z.number().positive().max(MAX_WAIT_SECONDS).describe(`How long to wait (max ${MAX_WAIT_SECONDS}).`),
    },
    async ({ wait_seconds }) => {
      ensurePresence(server);
      if (!ringService.isActive()) {
        const status = ringService.status();
        const why = status.disabled ? "MACULA_MCP_NO_RING is set" : status.error ? `ring service failed to start: ${status.error}` : "ring service is not active yet";
        return errorContent(`mesh_wait_ring: ${why} -- nothing can ring this agent right now, waiting would only time out`);
      }
      try {
        const me = presence.currentNodeId() ?? tsIdentity(defaultIdentityPath()).node_id;
        const res = await waitRing({ self: me, waitSeconds: wait_seconds });
        return jsonContent(res.ring ? { ...res, ring: { ...res.ring, peer_petname: petname(res.ring.peer) } } : res);
      } catch (e) {
        return errorContent(describeCliError("mesh_wait_ring failed", e));
      }
    },
  );
}
