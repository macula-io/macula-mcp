// Tool: mesh_send_chat — the convenience layer over the {sender, text}
// chat convention already documented on mesh_watch/mesh_etiquette, so an
// operator (or the agent acting for them) doesn't have to hand-craft it
// every time.
//
// NOT a fourth exception to one-shot subprocess: this is a composition of
// two ordinary calls (identity, then publish -- plus an optional watch),
// same shape as mesh_list_stations and mesh_open_lobby_session. It exists
// for two concrete, repeatedly-hit pieces of ceremony:
//
//   1. Every chat fact needs `sender` set to this process's OWN node ID.
//      Today that means a separate identity() lookup (or reading
//      mesh://identity) before every single mesh_publish call -- easy to
//      forget, and easy to get wrong by pasting the wrong node ID. This
//      tool fills it in itself, the same way mesh_open_lobby_session
//      fills in `from` for a lobby invite.
//   2. A turn-based chat loop (send, then wait for the other side) is
//      currently two separate tool calls the calling agent has to
//      remember to chain, including filtering out its own just-published
//      fact if the topic echoes it back. `wait_reply_seconds` folds that
//      into one call: publish, then watch the SAME topic immediately
//      afterward (no MCP round trip in between, unlike two separate tool
//      calls) for the first fact from a DIFFERENT sender.
//
// Still exactly mesh_publish/mesh_watch under the hood, with none of
// their honest limits removed: no ack on the send, and the reply wait is
// still "catches what's already in flight" -- it does not, and cannot,
// guarantee delivery of a reply sent in the narrow window before the
// watch actually starts. It only closes the specific gap that WAS fully
// addressable: the gap between two separate tool calls (each a fresh MCP
// round trip) becomes the gap between two calls in the same subprocess
// orchestration, typically milliseconds. If you need a guaranteed
// request/response, that's mesh_call, not this.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultStation, identity, publish, watch, type WatchEvent } from "./macula_cli.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";

const MAX_WAIT_SECONDS = 3600;

export interface ChatReply {
  sender?: string;
  text?: string;
  raw?: unknown;
  publisher: string;
  received_at: string;
}

/** Exported standalone so the {sender, text} parsing can be unit-tested without spawning a subprocess. */
export function asChatReply(evt: WatchEvent): ChatReply {
  const p = evt.payload as Record<string, unknown> | undefined;
  const sender = p && typeof p.sender === "string" ? p.sender : undefined;
  const text = p && typeof p.text === "string" ? p.text : undefined;
  return {
    sender,
    text,
    raw: sender === undefined && text === undefined ? evt.payload : undefined,
    publisher: evt.publisher,
    received_at: evt.received_at,
  };
}

/**
 * Publishes {sender: <own node_id>, text} to `topic`. If `waitReplySeconds`
 * is set, immediately watches the same topic for up to that long for the
 * first fact from a sender OTHER than this one, looping past any self-echo
 * of the just-sent message on the remaining time budget.
 */
export async function sendChat(args: {
  host?: string;
  topic: string;
  text: string;
  waitReplySeconds?: number;
  realm?: string;
}) {
  const { node_id } = await identity();
  const res = await publish({
    host: args.host,
    topic: args.topic,
    fact: { sender: node_id, text: args.text },
    realm: args.realm,
  });

  const sent = { topic: args.topic, seq: res.seq, sender: node_id };
  if (!args.waitReplySeconds) {
    return { sent, reply: null, timed_out: undefined };
  }

  const deadline = Date.now() + args.waitReplySeconds * 1000;
  for (;;) {
    const remaining = Math.round((deadline - Date.now()) / 1000);
    if (remaining < 1) break;
    const events = await watch({ host: args.host, topic: args.topic, durationSeconds: remaining, count: 1, realm: args.realm });
    if (events.length === 0) break; // duration elapsed with nothing arriving
    const reply = asChatReply(events[0]);
    if (reply.sender === node_id) continue; // our own just-published fact echoed back -- keep waiting
    return { sent, reply, timed_out: false };
  }
  return { sent, reply: null, timed_out: true };
}

export function registerMeshSendChat(server: McpServer): void {
  server.tool(
    "mesh_send_chat",
    "Send a chat message to another agent without hand-crafting the fact yourself: publishes " +
      '{sender: <your node_id>, text} to `topic` (your node_id filled in automatically, same ' +
      "identity mesh_publish/mesh_call use). Pass a well-known topic (e.g. agents.chat_message_sent) " +
      "or a session_topic from mesh_open_lobby_session -- this tool doesn't pick one for you, since " +
      "that's context you already have. Pass wait_reply_seconds to also wait, in this same call, for " +
      "the first reply from a DIFFERENT sender (skipping your own message if the topic echoes it " +
      "back) -- folds the usual publish-then-watch chat step into one call instead of two, and starts " +
      "watching immediately after the publish resolves rather than after a second, separate tool call " +
      "round-trips through the client, closing most of the race mesh_watch has against a fresh " +
      "publish. Still no delivery guarantee (PUBLISH has no ack, and a reply sent in the narrow gap " +
      "before watching starts can still be missed) -- use mesh_call instead if you need one. Omit " +
      `wait_reply_seconds to just send and return immediately, like mesh_publish. Defaults to ${defaultStation()} if host isn't given.`,
    {
      topic: z.string().describe("Topic to send on (e.g. 'agents.chat_message_sent', or a lobby session_topic)."),
      text: z.string().describe("The message text."),
      wait_reply_seconds: z
        .number()
        .positive()
        .max(MAX_WAIT_SECONDS)
        .optional()
        .describe(`Also wait up to this long (max ${MAX_WAIT_SECONDS}) for the first reply from another sender, in this same call.`),
      host: z
        .string()
        .optional()
        .describe(`Station to connect through, "host[:port]". Defaults to ${defaultStation()}.`),
      realm: z
        .string()
        .length(64)
        .regex(/^[0-9a-fA-F]+$/, "must be hex")
        .optional()
        .describe(
          "32-byte realm as hex (64 chars) the topic is scoped to. Omit for the default all-zero realm. " +
            "See mesh_call's realm description for the full rationale.",
        ),
    },
    async ({ topic, text, wait_reply_seconds, host, realm }) => {
      try {
        const result = await sendChat({ host, topic, text, waitReplySeconds: wait_reply_seconds, realm });
        return jsonContent(result);
      } catch (e) {
        return errorContent(describeCliError("mesh_send_chat failed", e));
      }
    },
  );
}
