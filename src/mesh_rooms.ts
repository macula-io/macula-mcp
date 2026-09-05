// Tools: mesh_open_room / mesh_join_room / mesh_leave_room / mesh_rooms /
// mesh_say -- rooms, central and their bookkeeping. Reaching a SPECIFIC
// agent is mesh_ring.ts (mesh_ring), an addressed invite delivered as a
// mesh_call with an identity proof, answered by the callee's contact
// policy (see policy.ts). A room can still be announced publicly on
// central (public: 1) or its topic passed along out of band, for
// whoever shows up rather than one named agent.
//
// Every one of these is a composition of ordinary calls (identity, then
// publish) plus rooms.ts's own bookkeeping over lobby_observer.ts's
// standing taps -- not a new exception to one-shot subprocess. The
// envelope on the wire is envelope.ts's, validated before anything is
// published, so a malformed message fails HERE, not on a reader.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultStation } from "./mesh_config.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";
import { ensurePresence } from "./presence.js";
import * as presence from "./presence.js";
import * as rooms from "./rooms.js";
import { CENTRAL_TOPIC, KINDS, TALK_KINDS } from "./envelope.js";
import { ANSWER, MAX_PURPOSE_CHARS, listRings } from "./rings.js";
import { placeRing, DEFAULT_WAIT_JOIN_SECONDS, MAX_WAIT_JOIN_SECONDS, type PlaceRingResult } from "./mesh_ring.js";
import { assertNoLikelySecret } from "./secret_scan.js";
import { petname } from "./petname.js";

const MAX_WAIT_SECONDS = 3600;
const DEFAULT_INVITE_PURPOSE = "Join this room";

type InviteOutcome = PlaceRingResult | { to: string; room_topic: string; failed: 1; reason: string };

/**
 * Rings every participant with the room already open, ONE AT A TIME --
 * mesh_ring's own placeRing, reused as-is (proof, policy, the
 * accepted/declined/deferred/unreachable answer, the join wait), not
 * reimplemented. NOT Promise.allSettled/parallel: @macula-io/ts's own
 * Session serializes every call onto one shared control stream
 * (session.js's #enqueue -- "only one is ever in flight at a time",
 * added after concurrent calls corrupted the stream) and, when `host`
 * is set (or the plain leg falls through to a direct-dial retry),
 * callThenDirect opens a FRESH Session per call under this agent's own
 * SAME identity -- two or more of those at once make the station kick
 * the older one, a live-documented "perpetual ping-pong" (pool.js).
 * Concurrent placeRing calls also each sign their own proof (a fixed
 * timestamp) BEFORE queueing, so a participant queued behind others
 * could have its already-stale-by-then proof rejected as stale_proof --
 * a real, non-hypothetical failure this composition must not produce.
 * Sequential means latency is additive, not shared -- see the tool
 * description below, which says exactly that rather than the false
 * "runs in parallel" claim an earlier version of this code made.
 */
async function inviteParticipants(args: {
  roomTopic: string;
  purpose?: string;
  participants: string[];
  host?: string;
  waitJoinSeconds: number;
}): Promise<InviteOutcome[]> {
  const purpose = args.purpose && args.purpose.trim().length > 0 ? args.purpose : DEFAULT_INVITE_PURPOSE;
  // Case-insensitively deduped: a repeated node id would otherwise ring
  // the same agent twice in one call, the second one landing inside
  // ring_service.ts's own RING_RATE_LIMIT_MS and coming back a spurious
  // "declined: rate limited" for an agent that never actually declined.
  const seen = new Set<string>();
  const deduped = args.participants.filter((to) => {
    const key = to.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const outcomes: InviteOutcome[] = [];
  for (const to of deduped) {
    try {
      outcomes.push(await placeRing({ to, purpose, room_topic: args.roomTopic, waitJoinSeconds: args.waitJoinSeconds, host: args.host }));
    } catch (e) {
      // Should not normally happen once the room is open and `to` is
      // never the opener, but a network exception is always possible;
      // one participant's ring throwing must not cost every OTHER
      // participant their result.
      outcomes.push({ to, room_topic: args.roomTopic, failed: 1, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return outcomes;
}

/** The room's own next_step, given how the invites actually landed -- replaces the old "tell them the topic yourself" text now that they're actually rung. */
function summarizeInvites(invited: InviteOutcome[], announcedOnCentral: 0 | 1): string {
  if (invited.length === 0) {
    return announcedOnCentral === 1
      ? "Anyone watching central can now mesh_join_room this topic. mesh_say on it to talk; mesh_read_inbox to read."
      : "No participants given -- nobody was told about this room. Pass participants next time to have them rung automatically, or share room_topic out of band.";
  }
  const joined = invited.filter((r) => "answer" in r && r.answer === ANSWER.accepted && r.joined === 1).length;
  const acceptedPending = invited.filter((r) => "answer" in r && r.answer === ANSWER.accepted && r.joined !== 1).length;
  const deferred = invited.filter((r) => "answer" in r && r.answer === ANSWER.deferred).length;
  const declined = invited.filter((r) => "answer" in r && r.answer === ANSWER.declined).length;
  const unreachable = invited.filter((r) => ("unreachable" in r && r.unreachable === 1) || "failed" in r).length;
  const parts: string[] = [];
  if (joined > 0) parts.push(`${joined} joined`);
  if (acceptedPending > 0) parts.push(`${acceptedPending} accepted (not yet seen joining -- mesh_read_inbox will show it)`);
  if (deferred > 0) parts.push(`${deferred} deferred (their model will decide; mesh_rooms shows them as awaiting)`);
  if (declined > 0) parts.push(`${declined} declined`);
  if (unreachable > 0) parts.push(`${unreachable} unreachable (ring again once mesh_agents shows them present)`);
  const central = announcedOnCentral === 1 ? " Anyone watching central can also mesh_join_room this topic." : "";
  return `Invited ${invited.length}: ${parts.join(", ")}. mesh_say on the room to talk; mesh_read_inbox to read.${central}`;
}

export interface OpenRoomAndInviteArgs {
  host?: string;
  purpose?: string;
  public?: 0 | 1;
  participants?: string[];
  waitJoinSeconds?: number;
}

export interface OpenRoomAndInviteResult extends rooms.OpenRoomResult {
  invited: InviteOutcome[];
  next_step: string;
}

/**
 * mesh_open_room's real logic, separated from its MCP wiring the same
 * way mesh_ring.ts separates placeRing from registerMeshRing -- so the
 * two-process live check (scripts/ring-two-process-check.mjs) can call
 * the exact code path the tool runs, not a hand-reassembled copy of it.
 */
export async function openRoomAndInvite(args: OpenRoomAndInviteArgs): Promise<OpenRoomAndInviteResult> {
  if (args.purpose !== undefined) assertNoLikelySecret(args.purpose, "purpose");
  const res = await rooms.openRoom({ host: args.host, purpose: args.purpose, public: args.public, participants: args.participants });
  const toRing = (args.participants ?? []).filter((id) => id.toLowerCase() !== res.opened.from.toLowerCase());
  const invited = await inviteParticipants({
    roomTopic: res.room_topic,
    purpose: args.purpose,
    participants: toRing,
    host: args.host,
    waitJoinSeconds: args.waitJoinSeconds ?? DEFAULT_WAIT_JOIN_SECONDS,
  });
  return { ...res, invited, next_step: summarizeInvites(invited, res.announced_on_central) };
}

const nodeIdSchema = z.string().length(64).regex(/^[0-9a-fA-F]+$/, "must be hex");
const messageIdSchema = z.string().length(32).regex(/^[0-9a-f]+$/, "must be lowercase hex");
const zeroOne = z.number().int().min(0).max(1);
const hostSchema = z
  .string()
  .optional()
  .describe(`Station to connect through, "host[:port]". Defaults to ${defaultStation()}.`);

function failed(prefix: string, e: unknown) {
  if (e instanceof rooms.RoomError) return errorContent(`${prefix}: ${e.message}`);
  return errorContent(describeCliError(prefix, e));
}

export function registerMeshRooms(server: McpServer): void {
  server.tool(
    "mesh_open_room",
    "Open a room: generates an unguessable room topic (agents.room.<32 hex>), starts watching it in the " +
      "background for as long as you stay, and publishes the room_opened envelope on it. Pass public: 1 to " +
      "also announce that envelope on central (agents.lobby) so whoever is around can mesh_join_room it. " +
      "Pass participants (node ids from mesh_agents) to actually notify them: each one is rung the same way " +
      "mesh_ring would (an addressed, proven call carrying this room's topic), so you get back who joined, " +
      "who deferred to their own model, who declined, and who was unreachable -- not just a recorded " +
      "intent. This still succeeds with whichever participants were reachable; an unreachable or declining " +
      "participant does not fail the room. Rings go out ONE AT A TIME, not in parallel (the underlying " +
      "session serializes calls; concurrent ones risk a stale or colliding proof), so wall-clock time DOES " +
      "grow with team size -- each unreachable participant alone can cost up to ~40s, and a slow-to-accept " +
      "one up to ~30s more. Expect a multi-participant call to take a while; it is not instant. A direct " +
      "message is a two-party room (one participant). Unguessable, not encrypted: anyone who learns the " +
      "topic reads it.",
    {
      purpose: z.string().max(MAX_PURPOSE_CHARS).optional().describe("Why this room exists, one line. Shown on central when public, and sent to each participant as the ring's purpose."),
      public: zeroOne.optional().describe("1 to announce the room on central for anyone to join; 0 (default) to keep the topic to whoever you tell."),
      participants: z.array(nodeIdSchema).max(32).optional().describe("Node ids (from mesh_agents) to actually ring and invite into this room, besides yourself. Rung one at a time, not in parallel."),
      wait_join_seconds: z
        .number()
        .min(0)
        .max(MAX_WAIT_JOIN_SECONDS)
        .optional()
        .describe(`Per accepting participant, how long to wait for their participant_joined before reporting them not-yet-joined (default ${DEFAULT_WAIT_JOIN_SECONDS}, 0 to not wait). Adds to each participant's own turn, one at a time -- not shared across them.`),
      host: hostSchema,
    },
    async ({ purpose, public: isPublic, participants, wait_join_seconds, host }) => {
      ensurePresence(server);
      try {
        const result = await openRoomAndInvite({ host, purpose, public: isPublic === 1 ? 1 : 0, participants, waitJoinSeconds: wait_join_seconds });
        return jsonContent({ ...result, invited: result.invited.map((r) => ({ ...r, to_petname: petname(r.to) })) });
      } catch (e) {
        return failed("mesh_open_room failed", e);
      }
    },
  );

  server.tool(
    "mesh_join_room",
    "Join a room whose topic you learned from central (mesh_rooms lists public ones) or out of band: starts " +
      "watching it in the background and publishes participant_joined on it. Idempotent. mesh_say on it to " +
      "talk; mesh_read_inbox to read what arrives; mesh_leave_room when done.",
    {
      room_topic: z.string().describe("The agents.room.<32 hex> topic."),
      host: hostSchema,
    },
    async ({ room_topic, host }) => {
      ensurePresence(server);
      try {
        return jsonContent(await rooms.joinRoom({ host, room_topic }));
      } catch (e) {
        return failed("mesh_join_room failed", e);
      }
    },
  );

  server.tool(
    "mesh_leave_room",
    "Leave a room: publishes participant_left (or room_closed with close: 1, which only means something " +
      "from the agent that opened it -- nothing enforces it) and stops watching the topic. The transcript " +
      "of what you saw there stays readable through mesh_lobby_transcript.",
    {
      room_topic: z.string().describe("A room you are in (see mesh_rooms)."),
      close: zeroOne.optional().describe("1 to publish room_closed instead of participant_left."),
      host: hostSchema,
    },
    async ({ room_topic, close, host }) => {
      ensurePresence(server);
      try {
        return jsonContent(await rooms.leaveRoom({ host, room_topic, close: close === 1 ? 1 : 0 }));
      } catch (e) {
        return failed("mesh_leave_room failed", e);
      }
    },
  );

  server.tool(
    "mesh_rooms",
    "Rooms this agent is in (opened or joined this session, still being watched), with the participants " +
      "seen so far and how many facts arrived, plus public rooms announced on central that you have not " +
      "joined, plus rings you sent that are still awaiting the callee's model. Instant, a local read, never blocks.",
    {},
    async () => {
      try {
        const me = presence.currentNodeId();
        const awaiting = me
          ? listRings({ self: me, direction: "out", answer: ANSWER.deferred, limit: 50 }).map((r) => ({
              ring_id: r.ring_id,
              to: r.peer,
              to_petname: petname(r.peer),
              purpose: r.purpose,
              room_topic: r.room_topic,
              rang_at: r.recorded_at,
            }))
          : [];
        const { joined, seen_on_central } = rooms.listRooms();
        return jsonContent({
          joined: joined.map((r) => ({
            ...r,
            opened_by_petname: petname(r.opened_by),
            participants_seen_petnames: r.participants_seen.map(petname),
          })),
          seen_on_central: seen_on_central.map((r) => ({
            ...r,
            opened_by_petname: petname(r.opened_by),
            ...(r.participants !== undefined ? { participants_petnames: r.participants.map(petname) } : {}),
          })),
          rings_awaiting_answer: awaiting,
        });
      } catch (e) {
        return errorContent(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    "mesh_say",
    "Say something in a room, or broadcast on central: publishes one conversation envelope " +
      "({message_id, room_topic, in_reply_to?, sent_at, from, kind, text, refs?}) with your node id, a fresh " +
      "message_id and the clock filled in. kind defaults to remark_made; question_asked expects an " +
      "answer_given, task_handed_over expects a result_reported, lane_claimed expects a lane_released " +
      "once you're done or dropping it (so others can see a lane is still open: scan for a lane_claimed " +
      "with no matching lane_released reply), and every one of those replies MUST carry in_reply_to. " +
      "lane_claimed itself does not require in_reply_to -- a self-initiated claim on work nobody handed " +
      "you is legitimate too. claim_confirmed/claim_disputed weigh in on a specific result_reported (also " +
      "in_reply_to required) -- see claim_verification.ts's own doc for the derived status this produces " +
      "and its honest limits (it can only verify evidence-backed claims, and currently caps out at a weak " +
      "'corroborated' signal, never a strong 'verified' one, pending a realm-membership-tier distinction " +
      "that doesn't exist on the wire yet). On a room you are not in yet, joins it first. On central (" +
      CENTRAL_TOPIC +
      ") use it for help_requested/help_offered broadcasts to whoever is around, not for conversation. " +
      "Pass wait_reply_seconds to also wait, in this same call, for the first envelope from another sender " +
      "on that topic: the background watch on the room was already running before your message went out, so " +
      "unlike a publish-then-watch pair there is no gap for a fast reply to fall into. Still no ack on the " +
      "send itself (PUBLISH has none); a ring is what gives you one.",
    {
      room_topic: z.string().describe(`A room you opened or joined, or "${CENTRAL_TOPIC}" for a broadcast.`),
      text: z.string().describe("The message."),
      kind: z.enum(KINDS).optional().describe(`One of ${TALK_KINDS.join(", ")} (default remark_made). Lifecycle kinds are published by the room tools, not here.`),
      in_reply_to: messageIdSchema.optional().describe("message_id this replies to. Required for answer_given, result_reported, lane_released, claim_confirmed, and claim_disputed."),
      refs: z.array(z.string().min(1)).max(16).optional().describe("mesh_put artifact ids for anything large. Never paste large content into text."),
      wait_reply_seconds: z
        .number()
        .positive()
        .max(MAX_WAIT_SECONDS)
        .optional()
        .describe(`Also wait up to this long (max ${MAX_WAIT_SECONDS}) for the first envelope from another sender on this topic.`),
      host: hostSchema,
    },
    async ({ room_topic, text, kind, in_reply_to, refs, wait_reply_seconds, host }) => {
      ensurePresence(server);
      if (kind !== undefined && !(TALK_KINDS as readonly string[]).includes(kind)) {
        return errorContent(`mesh_say: ${kind} is a lifecycle kind, published by mesh_open_room/mesh_join_room/mesh_leave_room, not by mesh_say.`);
      }
      try {
        // refs too, not just text: it's caller-supplied free strings
        // (z.string().min(1)), not actually validated as MCID hex despite
        // its own documented shape -- found by adversarial review to be an
        // unscanned path on an otherwise-wired tool.
        assertNoLikelySecret({ text, refs }, "text/refs");
        const res = await rooms.say({ host, room_topic, kind, text, in_reply_to, refs, waitReplySeconds: wait_reply_seconds });
        return jsonContent(res);
      } catch (e) {
        return failed("mesh_say failed", e);
      }
    },
  );
}
