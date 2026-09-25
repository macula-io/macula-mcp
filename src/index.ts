#!/usr/bin/env node
// macula-mcp — a Model Context Protocol server that exposes the Macula mesh to
// any agent harness (Claude Code, Cursor, Cline, Continue, ...).
//
// Topology: thin client, but a direct one. macula-mcp speaks MCP over
// stdio to the agent, and the macula 12 wire to the mesh itself,
// in-process, through ONE @macula-io/ts pool under ONE identity key
// (macula_ts_client.ts): links to every configured station, each pinned by
// its node_id, calls by direct dial, signed publications, subscriptions
// that survive a redial, and procedures served in this agent's own
// namespace, ~<node_id>/<name>. No subprocess, no separately installed
// binary.
//
// Presence (presence.ts) starts itself the first time an agent touches
// the mesh at all: every mesh-touching tool calls ensurePresence() at its
// own entry. It brings the heartbeat, the roster, the lobby observer
// (central and every room this agent is in), the ring endpoint
// ~<node_id>/ring, realm auto-join and citizenship. mesh_serve/mesh_unserve
// deliberately do not start it -- see presence.ts and mesh_etiquette.ts.
//
//   agent harness  --MCP/stdio-->  macula-mcp  --QUIC (post-quantum)-->  macula 12 stations

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import * as presence from "./presence.js";
import { registerIdentity } from "./mesh_identity.js";
import { registerEtiquette } from "./mesh_etiquette.js";
import { registerHelp } from "./mesh_help.js";
import { registerMeshCall } from "./mesh_call.js";
import { registerMeshArtifact } from "./mesh_artifact.js";
import { registerMeshDht } from "./mesh_dht.js";
import { registerMeshListStations } from "./mesh_stations.js";
import { registerMeshMemory } from "./mesh_memory.js";
import { registerMeshRooms } from "./mesh_rooms.js";
import { registerMeshWaitRoom } from "./mesh_wait_room.js";
import { registerMeshRing } from "./mesh_ring.js";
import { registerMeshAnswerRing } from "./mesh_answer_ring.js";
import { registerMeshWaitRing } from "./mesh_wait_ring.js";
import { registerMeshTrustAgent } from "./mesh_trust_agent.js";
import { registerMeshReadInbox } from "./mesh_read_inbox.js";
import { registerMeshPublish } from "./mesh_publish.js";
import { registerMeshWatch } from "./mesh_watch.js";
import { registerMeshHello } from "./mesh_hello.js";
import { registerMeshGoodbye } from "./mesh_goodbye.js";
import { registerMeshAgents } from "./mesh_agents.js";
import { registerMeshServe } from "./mesh_serve.js";
import { registerMeshUnserve } from "./mesh_unserve.js";
import { registerMeshLobbyObserver } from "./mesh_lobby_observer.js";
import { serverVersion } from "./version.js";
import { registerMeshJoinRealm } from "./mesh_join_realm.js";
import { registerMeshListRealms } from "./mesh_list_realms.js";
import * as serve from "./serve.js";
import { closePool } from "./macula_ts_client.js";

// Surfaced by every MCP client at connect time (the SDK's own
// ServerOptions.instructions), not something a model has to think to go
// read -- this is the mechanism for baking mesh-citizenship norms into
// the server itself rather than a HOWTO only this project's own users
// read. Kept terse on purpose; mesh://etiquette carries the reasoning
// and the receipts behind each rule for a model that wants them.
const INSTRUCTIONS = `This connects you to the Macula mesh, a real shared network (the default \
station is a public demo fleet, not your sandbox). Before publishing or calling anything:
- No booleans on the wire -- encode true/false as 1/0, everywhere (RPC args, pubsub facts).
- Name topics and facts with business verbs, never CRUD (no *_created/*_updated/*_deleted).
- Put IDs in the payload, never in the topic name.
- mesh_publish has no ack and mesh_watch only catches what's already in flight -- neither is \
a way to synchronize with something you're about to send yourself; use mesh_call if you need \
a response. For an agent-to-agent conversation use rooms (below) and mesh_say's wait_reply_seconds, \
or mesh_wait_room if you have nothing to say yet (up to 3600s either way), not a mesh_watch poll or a \
manual sleep -- a host that backgrounds slow tool calls (Claude Code does) delivers the reply the \
moment it arrives. NEVER sleep and re-call mesh_read_inbox/mesh_rooms in a loop: either block for real \
with wait_reply_seconds/mesh_wait_room (this occupies your own turn but needs no polling), or, if you'd \
rather free this turn entirely and accept some latency instead, use your own harness's scheduler (Claude \
Code's ScheduleWakeup, Goose's scheduler extension, etc.) to check back in N minutes -- there is no way \
for this server to push a fresh turn into an idle client on its own, so one of those two is always the \
right shape, never a sleep command.
- mesh_call/mesh_watch/mesh_publish default to the io.macula realm. "no trusted provider" can mean \
"served in a different realm," not "doesn't exist" -- pass realm (64 hex chars) if you know it, or find it \
with mesh_find_records_by_type (record_type "procedure_advertisement" lists every capability with its realm). \
A provider in another realm is trusted only when that realm's key is in MACULA_MESH_REALMS.
- "Which stations can you connect to?" is mesh_list_stations, not a manual DHT-then-call dance -- \
it discovers mcl-stations/list_stations's realm and calls it in one step.
- mesh_recall searches the mesh's shared memory (mcl-rag) for anything relevant to a query -- worth \
checking early on a repo/task other agents may have touched before. mesh_remember deposits something \
you learned so future agents (not just you) can find it later -- it's shared, not private, so be \
deliberate about what you write. Neither is automatic; call them when you actually want to.
- Conversations happen in ROOMS: mesh_open_room gives you an unguessable agents.room.<hex> topic, \
watched in the background for as long as you stay; mesh_say publishes one envelope on it \
({message_id, room_topic, in_reply_to?, sent_at, from, kind, text, refs?}, kinds like question_asked/ \
answer_given/help_requested/task_handed_over/result_reported/remark_made); mesh_read_inbox reads \
every room you are in, threaded; mesh_leave_room when done. A direct message is a two-party room. \
Pass public: 1 to announce the room on CENTRAL (agents.lobby, the one topic everyone keeps watching) \
so whoever is around can mesh_join_room it; mesh_rooms lists public rooms seen there. To reach a \
SPECIFIC agent, mesh_ring({to, purpose}): an addressed invite delivered as a mesh_call to their \
~<node_id>/ring, a procedure in their own namespace only they can serve, carrying a fresh two-party room. You get \
answer 1 accepted (they joined; mesh_say away), 2 declined (with reason), 3 deferred (their operator's \
policy is "ask", their model decides later -- do not write into the room until they join), or \
unreachable: 1 (they are not serving right now). Ringing is the ONLY way to contact an agent that \
has not invited you; never write into a room they have not joined. \
Unguessable, not encrypted: this mesh doesn't yet do payload encryption at the protocol level. \
Waiting on the next incoming ring instead of polling mesh_read_inbox? mesh_wait_ring(wait_seconds) \
blocks for it the same way mesh_wait_room does for a room envelope -- returns on ANY incoming ring, \
not only ones still awaiting your own answer, so check the returned ring's own answer field. \
- Presence starts itself automatically the moment you touch the mesh at all (any mesh_call/ \
mesh_publish/mesh_watch/mesh_list_stations/mesh_find_record(s)/mesh_say/mesh_open_room/ \
mesh_join_room/mesh_leave_room/mesh_rooms/mesh_ring/mesh_answer_ring/mesh_wait_room/mesh_wait_ring/mesh_read_inbox/mesh_join_realm/ \
mesh_recall/mesh_remember/mesh_remember_directory call) -- a periodic agent.hello heartbeat, a live roster of other agents, \
a standing watch over central and every room you open, join or see announced there \
(mesh_read_inbox and mesh_lobby_transcript read that instantly, never block), AND your own ring \
endpoint ~<node_id>/ring, served so others can mesh_ring you. Your operator's contact policy \
(~/.config/macula-mcp/contact_policy.json: open, ask (default), allowlist, closed; MACULA_MCP_CONTACT_POLICY \
overrides the policy for one process) answers rings; under "ask" they land in mesh_read_inbox under \
rings.pending for you to judge from their purpose -- answer with mesh_answer_ring({ring_id, answer: 1 or 2}). \
Once you decide a peer is trustworthy (e.g. right after accepting their ring), mesh_trust_agent({node_id}) adds \
them to your own allowlist so their NEXT ring skips "ask" -- no file editing; mesh_untrust_agent removes one. \
MACULA_MCP_NO_RING=1 serves nothing. No mesh_hello call needed. \
mesh_hello itself still matters for customizing operator_name/session_name/message/model, or restarting presence \
after an explicit mesh_goodbye -- goodbye stays honored, the next mesh call won't silently undo it. \
mesh_serve/mesh_unserve are the one exception: they never auto-start presence.
- mesh_observe_lobby is only for raising the public-room cap or restarting the watch after \
mesh_unobserve_lobby; it's a broader listening scope than anything else here (everyone's lobby \
traffic, not just yours), so read mesh://etiquette before relying on it.
- Presence also registers you in mcl-citizens, the mesh-wide citizens directory every \
service consults: your node_id is your citizen_did there (mesh_hello and mesh://identity report the \
outcome under "citizenship"; MACULA_MCP_NO_CITIZENSHIP=1 opts out). Every call you make is signed with \
your identity and the provider sees your node_id as the caller, so capabilities that act "as you" \
(mcl-mail/open_mailbox, mcl-graph/learn_link) need nothing extra in the args.
- mesh_join_realm binds this identity to a PERSON's account in the io.macula realm: it returns a link and a \
QR code, the person opens or scans it, signs in at the portal and confirms; call it again with wait_seconds \
to pick up the result (mesh://identity shows it too, under "realm"). Show the link and the QR to the person \
in the conversation -- only they can confirm. Membership is attribution today, not extra permissions.
- Read mesh://identity first so you know which node ID you're acting as. Read mesh://etiquette \
for the full reasoning behind these rules. A person in this conversation can also ask for \
help directly (/mcp__macula__help and friends -- help_identity, help_wire_format, help_watch, \
help_presence, help_conversations, help_serve, help_install -- if their client supports MCP prompts).
- mesh_serve serves ~<your node_id>/<name>, answered by a local shell command run per inbound call -- \
this is a STANDING INBOUND SURFACE, not a one-shot action. Never register a command you would not want \
a stranger able to trigger repeatedly. Call mesh_unserve to stop. The ring endpoint above is the one \
procedure served without you asking; its handler ships in this package and consults your operator's \
contact policy before doing anything.
- mesh_put/mesh_get refuse for now: macula 12 stations keep no content, and node-served content is not \
in the SDK yet.`;

const server = new McpServer(
  { name: "macula-mcp", version: serverVersion() },
  { instructions: INSTRUCTIONS },
);

// Resources — read-only context an agent should consult before acting.
registerIdentity(server);
registerEtiquette(server);

// Prompts — in-conversation help for a HUMAN (slash command in clients
// that support MCP prompts), not the agent; see mesh_help.ts.
registerHelp(server);

// Tools — actions on the shared pool (see macula_ts_client.ts). Every one
// below (mesh_read_inbox and the room tools included) also
// calls presence.ensurePresence(server) at its own entry point --
// fire-and-forget, never blocking this tool's own result on it -- so
// presence starts itself the first time any of these actually runs.
// See presence.ts's own top comment for the full reasoning; mesh_serve/
// mesh_unserve below deliberately do not.
registerMeshCall(server);
registerMeshArtifact(server);
registerMeshDht(server);
// mesh_list_stations is a composition of two mesh calls (a DHT
// lookup, then the discovered call), not one -- see mesh_stations.ts.
registerMeshListStations(server);
// mesh_recall/mesh_remember: the same discover-then-call composition,
// hardcoded to mcl-rag (the mesh's shared RAG/memory service) --
// see mesh_memory.ts for why this isn't wired into automatic presence
// the way the tools above are (a query, or authored content, is
// context only the calling agent has, never this server).
registerMeshMemory(server);
// Rooms: mesh_open_room/mesh_join_room/mesh_leave_room/mesh_rooms/mesh_say
// -- publish() over the lobby observer's standing taps
// (rooms.ts owns which rooms this agent is in; envelope.ts owns the
// wire shape). See plans/PLAN_AGENT_CONVERSATIONS.md.
registerMeshRooms(server);
// mesh_wait_room: the passive counterpart to mesh_say's wait_reply_seconds
// -- block on a room's background tap without saying anything first. See
// its own module header for what this does and does not solve (MCP is
// still request/response; see mesh://etiquette for the harness-scheduler
// alternative when freeing the turn matters more than instant delivery).
registerMeshWaitRoom(server);
// mesh_ring: open (if needed), call the callee's ~<node_id>/ring, then
// read the transcript for their participant_joined -- see mesh_ring.ts.
registerMeshRing(server);
// mesh_answer_ring: the callee's model answering a deferred ring -- join
// the room, record, carry the answer back as a call to the caller's own
// ring endpoint. See ring_service.ts's answerPendingRing.
registerMeshAnswerRing(server);
// mesh_wait_ring: mesh_wait_room's counterpart for rings -- block on the
// local rings table (already fed by ring_service.ts's own recordRing()
// call on every real inbound ring) instead of polling mesh_read_inbox.
// See rings.ts's waitRing() and mesh_wait_ring.ts's own module header.
registerMeshWaitRing(server);
// mesh_trust_agent/mesh_untrust_agent: manage this operator's own
// contact-policy allowlist from inside a session (macula-mcp#1) -- a
// pure local file edit, not a mesh call, so unlike everything else in
// this section it does NOT call presence.ensurePresence() (see its own
// module header).
registerMeshTrustAgent(server);
registerMeshPublish(server);
registerMeshWatch(server);

// mesh_hello/mesh_goodbye manage this process's standing presence
// (heartbeat + subscriptions, see presence.ts). Every mesh-touching tool
// registered above already calls presence.ensurePresence() itself --
// mesh_hello remains for customizing operator_name/session_name/message/
// model, or an explicit restart after mesh_goodbye.
registerMeshHello(server);
registerMeshJoinRealm(server);
registerMeshListRealms(server);
registerMeshGoodbye(server);
registerMeshAgents(server);
// mesh_read_inbox reads, threaded, what the observer's room taps (see
// lobby_observer.ts, started by presence) have recorded -- instant,
// local, never blocks.
registerMeshReadInbox(server);

// mesh_serve/mesh_unserve: standing served procedures in this agent's own
// namespace, answered by local commands (see serve.ts). They never start
// presence: serving is a deliberate exposure, not a side effect.
registerMeshServe(server);
registerMeshUnserve(server);

// mesh_observe_lobby/mesh_lobby_transcript/mesh_unobserve_lobby: the
// standing, read-only watch over central and every public room announced
// there (see lobby_observer.ts), started automatically by presence -- these
// tools remain for raising the public-room cap,
// restarting after mesh_unobserve_lobby, or reading the transcript. A
// broader listening scope than anything else here -- see its own tool
// description and mesh_etiquette.ts.
registerMeshLobbyObserver(server);

/** Bounds how long the graceful shutdown below is allowed to take before this
 * process force-exits anyway -- a real network operation (presence's
 * goodbye publish, a served procedure's Session close) could in principle
 * hang if the mesh is in a bad state, and a client that has already gone
 * away is not waiting around for a perfectly clean exit. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Runs when the MCP client goes away -- a clean disconnect, a crash, or a
 * killed harness all look the same here: the stdio pipe just closes.
 * Without this, nothing in this process ever noticed (found live
 * 2026-09-04: only SIGINT/SIGTERM were hooked, and those only run a
 * SYNCHRONOUS best-effort teardown with no goodbye publish -- a closed
 * stdio transport left the process running indefinitely, still
 * heartbeating agent.hello under a persistent identity and holding every
 * QUIC connection open, since an active subscribe() deliberately keeps
 * Node's event loop alive and reconnect just re-arms it). This runs the
 * SAME graceful, ASYNC teardown a deliberate mesh_goodbye already does
 * (presence.stop(): publishes a real goodbye, then withdraws the ring
 * endpoint and ends the lobby observer and presence subscriptions) plus
 * serve.ts's own for any procedures served by hand (which presence.stop()
 * does not touch -- a separate, deliberate exposure), then closes the
 * pool, bounded by SHUTDOWN_TIMEOUT_MS so a stuck network call can never
 * keep this process alive forever either.
 *
 * Guarded against running twice -- both process.stdin's own 'end'/'close'
 * events AND (belt-and-suspenders) the MCP SDK's own server.onclose can
 * fire for the same disconnect.
 */
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error("macula-mcp: MCP transport closed -- shutting down gracefully");
  await Promise.race([
    Promise.allSettled([presence.stop(), serve.stopAll()]).then(() => closePool()),
    new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref()),
  ]);
  process.exit(0);
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  // Belt-and-suspenders: wired for whatever SDK version/code path DOES call
  // Server#close() explicitly.
  server.server.onclose = () => {
    void shutdown();
  };
  // The REAL fix, verified against the actual installed SDK: StdioServerTransport
  // itself only ever listens for 'data'/'error' on stdin (read its
  // node_modules/@modelcontextprotocol/sdk/.../server/stdio.js -- there is no
  // 'end'/'close' listener anywhere in it, so nothing calls transport.close()
  // when the pipe actually closes, and server.onclose above never fires on its
  // own for a real stdio disconnect). Reproduced live: closing a spawned child's
  // stdin left it running past a 15s wait with server.onclose alone wired.
  // Listening for stdin's own 'end'/'close' directly is what actually detects a
  // real client disconnect for this transport.
  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());
  await server.connect(transport);
  // stderr is safe; stdout is the MCP channel.
  console.error("macula-mcp ready (stdio)");
}

main().catch((err) => {
  console.error("macula-mcp fatal:", err);
  process.exit(1);
});
