// Tool: mesh_answer_ring -- this agent's model answering a ring its
// operator's policy deferred ("ask", the default). The ring sits in
// mesh_read_inbox under rings.pending with the caller's purpose; this
// is the deliberate yes or no. On accept the room is joined before the
// caller is told, so their view of the room turns two-sided at the same
// moment they hear yes. See ring_service.ts's answerPendingRing.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultStation } from "./mesh_config.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";
import { ensurePresence } from "./presence.js";
import * as ringService from "./ring_service.js";
import * as rooms from "./rooms.js";
import { assertNoLikelySecret } from "./secret_scan.js";

export function registerMeshAnswerRing(server: McpServer): void {
  server.tool(
    "mesh_answer_ring",
    "Answer a ring that was deferred to you (mesh_read_inbox lists them under rings.pending, with who rang " +
      "and why). answer 1 accepts: you join the room first, then the caller is told and can mesh_say. " +
      "answer 2 declines, with an optional reason the caller sees. The answer travels back as a proven " +
      "call to the caller's own ring endpoint; if they are no longer present, caller_notified is 0 and " +
      "your answer is still recorded here. Deferring again is not an answer; leave it pending instead.",
    {
      ring_id: z.string().length(32).regex(/^[0-9a-f]+$/, "must be lowercase hex").describe("From rings.pending in mesh_read_inbox."),
      answer: z.number().int().min(1).max(2).describe("1 accept, 2 decline. No booleans on the wire."),
      reason: z.string().max(280).optional().describe("Shown to the caller. Worth giving on a decline."),
      host: z
        .string()
        .optional()
        .describe(`Station to connect through, "host[:port]". Defaults to ${defaultStation()}.`),
    },
    async ({ ring_id, answer, reason, host }) => {
      ensurePresence(server);
      try {
        if (reason !== undefined) assertNoLikelySecret(reason, "reason");
        const res = await ringService.answerPendingRing({ ring_id, answer: answer === 1 ? 1 : 2, reason, host });
        return jsonContent({
          ...res,
          next_step:
            res.answer === 1
              ? res.caller_notified === 1
                ? "You are in the room and they know. mesh_say on it; mesh_read_inbox to read."
                : "You are in the room, but they could not be told (see notify_error). If they are still tapping the room they will see your participant_joined."
              : "Declined and recorded. Nothing more to do.",
        });
      } catch (e) {
        if (e instanceof rooms.RoomError) return errorContent(`mesh_answer_ring failed: ${e.message}`);
        return errorContent(describeCliError("mesh_answer_ring failed", e));
      }
    },
  );
}
