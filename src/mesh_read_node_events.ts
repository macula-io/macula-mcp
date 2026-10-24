// Tool: mesh_read_node_events -- this node's own event log, read with a
// cursor (macula-mcp#42).
//
// The log is appended by whoever owns the thing that happened: ring_dossier.ts
// writes ring_received and ring_answered in the same transaction as the ring
// row it changes, realm.ts writes join_confirmed when a membership is
// established. Nothing here derives an entry from a snapshot -- that is the
// whole point, since a client comparing two mesh_read_inbox reads could not
// tell "already seen" from "changed while I was away" (#57's four rounds).
//
// The cursor is the caller's: after_seq from the last read's next_after_seq.
// The server never substitutes "now" for a cursor nobody passed, so an entry
// cannot be skipped between a read and the next one.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { selfNodeId } from "./connect_to_mesh.js";
import { NODE_EVENT, readNodeEvents, type NodeEvent } from "./node_events.js";
import { errorContent, jsonContent } from "./reply.js";
import * as presence from "./be_present/presence.js";
import { answerLabel } from "./ring_agents/rings.js";
import { machineDb } from "./machine_transcript.js";
import { petname } from "./petname.js";
import { toolDescription } from "./tool_description.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** One entry as a reader gets it: the seq it was read at, and only the fields its kind has something to say about. */
function eventView(e: NodeEvent) {
  const common = { seq: e.seq, kind: e.kind, at: e.at };
  if (e.kind === NODE_EVENT.joinConfirmed) return { ...common, realm: e.realm, org_identity: e.org_identity, tier: e.tier };
  return {
    ...common,
    ring_id: e.ring_id,
    direction: e.direction,
    peer: e.peer,
    peer_petname: e.peer === null ? null : petname(e.peer),
    ...(e.purpose !== null ? { purpose: e.purpose } : {}),
    room_topic: e.room_topic,
    ...(e.answer !== null ? { answer: e.answer, answer_label: answerLabel(e.answer) } : {}),
    ...(e.reason !== null ? { reason: e.reason } : {}),
  };
}

const DESCRIPTION_FULL =
  "Read this node's own event log: what happened to this agent, in order, each entry carrying a monotonic " +
  "seq. Three kinds. ring_received: someone rang you (a ring the operator's policy settled on the spot " +
  "carries its answer here too). ring_answered: an answer was recorded -- direction 'in' when you gave it, " +
  "'out' when the peer answered a ring you placed; a deferred ring gives 3 first and then 1 or 2, and an " +
  "answer never moves backwards. join_confirmed: a realm membership was established (mesh_join_realm, the " +
  "silent device join, or the CLI joining from another process). Pass the previous read's next_after_seq as " +
  "after_seq to see each entry exactly once, oldest first; omit it for the newest `limit` entries, " +
  "oldest-first within that window. Instant local read: never blocks, never touches the mesh.";

/** MACULA_MCP_TERSE_TOOLS=1 variant -- see tool_description.ts. Keeps the three kinds, what direction means, and the cursor rule. */
const DESCRIPTION_TERSE =
  "Read this node's event log in order: ring_received, ring_answered (direction in = you answered, out = " +
  "the peer did; a deferred ring gives 3 then 1 or 2), join_confirmed. Pass next_after_seq back as " +
  "after_seq to see each entry once. Instant local read.";

export function registerMeshReadNodeEvents(server: McpServer): void {
  server.registerTool(
    "mesh_read_node_events",
    {
      description: toolDescription(DESCRIPTION_FULL, DESCRIPTION_TERSE),
      inputSchema: {
        after_seq: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Only entries after this seq, oldest first: pass the previous read's next_after_seq to see each entry exactly once."),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_LIMIT)
          .default(DEFAULT_LIMIT)
          .describe(`At most this many entries (default ${DEFAULT_LIMIT}); with after_seq, the first N after it.`),
      },
    },
    async ({ after_seq, limit }) => {
      presence.ensurePresence(server);
      try {
        const me = presence.currentNodeId() ?? (await selfNodeId());
        const read = readNodeEvents(machineDb(), { self: me, afterSeq: after_seq, limit });
        return jsonContent({ events: read.events.map(eventView), next_after_seq: read.next_after_seq, returned: read.events.length });
      } catch (e) {
        return errorContent(`mesh_read_node_events: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
