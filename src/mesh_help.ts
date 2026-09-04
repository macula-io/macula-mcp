// Prompts: mesh help -- in-conversation help for a HUMAN, not the agent.
//
// The server's `instructions` field and the mesh://etiquette resource
// (see mesh_etiquette.ts) are for the agent to consult on its own. This
// is different: an MCP prompt surfaces as a slash command in a client
// that supports the prompts primitive (e.g. /mcp__macula__help in Claude
// Code), so a person mid-conversation can ask for a tailored explanation
// without leaving the chat or reading GitHub docs. It doesn't duplicate
// the etiquette resource's content -- it asks the model to EXPLAIN using
// what it already has loaded (tool descriptions, instructions,
// mesh://etiquette), tailored to whichever topic was picked.
//
// Eight separate zero-argument prompts, not one `help` prompt with an
// optional `topic` argument -- found live: @modelcontextprotocol/sdk
// 1.30.0 (the latest at the time) throws "Invalid arguments ... Required"
// on getPrompt when a prompt's args are ALL optional and the caller
// omits the `arguments` field entirely, because it parses
// `request.params.arguments` (undefined in that case) straight through
// zod's object schema instead of defaulting to {}. That's exactly how a
// client invokes a bare slash command with no argument typed -- the
// single most common case -- so a one-prompt-with-optional-arg design
// would fail on its own primary use case. A prompt with NO argsSchema at
// all skips that parse path entirely (verified in the SDK source:
// `if (prompt.argsSchema) { ...parse... } else { cb(extra) }`), so
// separate zero-arg prompts sidestep the bug rather than work around it.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface HelpTopic {
  name: string;
  description: string;
  ask: string;
}

const TOPICS: HelpTopic[] = [
  {
    name: "help",
    description:
      "Quick-start help for the Macula mesh tools in this conversation -- overview, examples, gotchas.",
    ask:
      "Give me a quick, example-driven overview of the Macula mesh tools available in this " +
      "conversation: mesh_call, mesh_put, mesh_get, mesh_publish, mesh_watch, mesh_hello, " +
      "mesh_agents, mesh_goodbye, mesh_open_room, mesh_say, mesh_read_inbox, mesh_serve, mesh_unserve, plus the mesh://identity and " +
      "mesh://etiquette resources. Show one realistic example call per tool and the top 3 " +
      "gotchas to avoid -- for mesh_serve specifically, lead with the fact that it opens a real " +
      "inbound trigger any mesh caller can invoke, not a one-shot action.",
  },
  {
    name: "help_identity",
    description: "Explain how mesh identity works in this conversation (mesh_watch vs. every other tool).",
    ask:
      "Explain how identity works for the Macula mesh tools in this conversation: what " +
      "mesh://identity shows, why mesh_watch, presence (mesh_hello/mesh_agents/mesh_goodbye), " +
      "serving (mesh_serve/mesh_unserve) and observing (mesh_observe_lobby and friends) each use their " +
      "own identity distinct from the other tools, that every one of the five is now PERSISTED per " +
      "logical session (scoped by CLAUDE_CODE_SESSION_ID, else the parent pid) rather than a fresh " +
      "temp file per process, and how to pin any of them to a fixed path instead with MACULA_MCP_IDENTITY " +
      "/ MACULA_MCP_WATCH_IDENTITY / MACULA_MCP_PRESENCE_IDENTITY / MACULA_MCP_SERVE_IDENTITY / " +
      "MACULA_MCP_OBSERVE_IDENTITY if a stable node ID across sessions is needed.",
  },
  {
    name: "help_wire_format",
    description: "Explain the Macula wire-format rules (no booleans, naming conventions) with examples.",
    ask:
      "Explain the Macula wire-format rules that apply to mesh_call's args and mesh_publish's " +
      "fact: what's not representable on the wire (booleans -- show the right way to encode " +
      "true/false instead), and the naming conventions (business verbs never CRUD, entity IDs " +
      "in the payload never in the topic name). Give one valid and one invalid example payload.",
  },
  {
    name: "help_watch",
    description: "Explain what mesh_watch is actually good for and the mistake to avoid with it.",
    ask:
      "Explain how mesh_watch works, including why it can't be used to catch a mesh_publish " +
      "issued as a second call in the same turn, and what it's actually good for (catching " +
      "facts already in flight from someone else, not synchronizing with your own send).",
  },
  {
    name: "help_presence",
    description: "Explain mesh_hello/mesh_agents/mesh_goodbye/mesh_read_inbox -- what presence is for, how it persists, and why it's automatic now.",
    ask:
      "Explain the presence tools in this conversation: what presence actually starts (a " +
      "periodic agent.hello heartbeat, a durable subscription to other agents' hellos, a " +
      "standing watch over central (agents.lobby) plus every room this agent opens, joins or sees " +
      "announced there, AND the served ring endpoint agent.<node_id>.ring -- all backed by daemons " +
      "this server manages internally, not a one-shot call like every other tool here), what " +
      "mesh_agents shows (a persistent SQLite roster, not an in-memory list, so it survives a " +
      "restart) and how staleness/pruning works, what mesh_read_inbox shows (an instant, " +
      "never-blocking, threaded local read of the rooms you are in -- see help_conversations), " +
      "and why mesh_goodbye matters " +
      "(leaves your rooms, removes you from others' rosters immediately, and stops the central and room watches " +
      "too, instead of waiting for your heartbeat to simply stop). Emphasize that presence is " +
      "now AUTOMATIC (2026-08-31): any genuinely mesh-touching tool call starts it in the " +
      "background the first time it's used, with operator_name/message/model taken from env " +
      "vars if set -- mesh_hello is no longer required, it now exists for customizing those, " +
      "reading the banner/topics back explicitly, or restarting presence after an explicit " +
      "mesh_goodbye (which stays honored, not silently undone by the next mesh call). Mention " +
      "operator_name as the stable human-facing label over what's often an ephemeral node ID, " +
      "and that mesh_serve/mesh_unserve are the one deliberate exception to the automatic start.",
  },
  {
    name: "help_conversations",
    description: "Explain rooms and central -- mesh_open_room/mesh_join_room/mesh_say/mesh_read_inbox/mesh_leave_room/mesh_rooms -- and the envelope every message carries.",
    ask:
      "Explain how agents converse over the mesh in this conversation: central (agents.lobby, the one " +
      "topic every present agent keeps watching, for help_requested/help_offered broadcasts and public " +
      "room_opened announcements) versus a room (an unguessable agents.room.<32 hex> topic opened by " +
      "mesh_open_room, joined by mesh_join_room, watched in the background for as long as you stay, " +
      "left by mesh_leave_room; a direct message is just a two-party room). Show the envelope every " +
      "message carries (message_id, room_topic, in_reply_to, sent_at, from, kind, text, refs) and the " +
      "kinds (question_asked/answer_given, help_offered/help_requested, task_handed_over/result_reported, " +
      "lane_claimed/lane_released, remark_made), why answer_given, result_reported and lane_released must " +
      "carry in_reply_to (lane_released points back at the lane_claimed it closes, so a room's still-open " +
      "lanes are mechanically derivable rather than a second, driftable status field), how mesh_say's " +
      "wait_reply_seconds differs from a publish-then-watch pair (the room was already being watched " +
      "before the message went out), and rings: mesh_ring({to, purpose}) delivers an addressed invite as a " +
      "mesh_call to the callee's agent.<node_id>.ring procedure with this agent's ownership proof, carrying " +
      "a fresh two-party room; the callee's operator policy (contact_policy.json: open / ask, the " +
      "default / allowlist / closed) answers 1 accepted (they join the room before answering, so joined: 1 " +
      "means the room is two-sided), 2 declined with a reason, or 3 deferred to their model (pending in their " +
      "mesh_read_inbox until they mesh_answer_ring, which joins the room and carries the answer back to the " +
      "caller's own ring endpoint); an agent that is not serving is unreachable, not silent. Ringing is the only way " +
      "to contact an agent that has not invited you. Mention that a room topic is unguessable, not encrypted.",
  },
  {
    name: "help_serve",
    description: "Explain mesh_serve/mesh_unserve -- what serving actually exposes and the risk to weigh before using it.",
    ask:
      "Explain the serving tools in this conversation: what mesh_serve actually does (advertises a " +
      "procedure on the mesh, answered by running a local shell command once per inbound call -- " +
      "the caller's JSON payload arrives on the command's stdin, never shell-interpolated into the " +
      "command string itself, and the command's stdout becomes the reply), and why this is a " +
      "materially bigger exposure than every other tool here: it's a STANDING INBOUND TRIGGER any " +
      "mesh caller can invoke repeatedly, not a one-shot action this agent initiates. Emphasize: " +
      "never register a command you wouldn't want a stranger able to run repeatedly on this " +
      "machine, a failing/timing-out handler only fails its own caller (verified live, it can't " +
      "affect any other procedure or the daemon itself), and mesh_unserve should be called as soon " +
      "as a procedure no longer needs to be reachable rather than left registered indefinitely. Name " +
      "the one exception: presence automatically serves agent.<node_id>.ring, the ring endpoint, whose " +
      "handler ships in this package, verifies the caller's ownership proof and consults the operator's " +
      "contact policy before doing anything; MACULA_MCP_NO_RING=1 opts out of serving it at all.",
  },
  {
    name: "help_install",
    description: "Explain how to install macula-mcp, register it, and verify it's actually working.",
    ask:
      "Explain how someone installs macula-mcp, registers it with their MCP client, and " +
      "verifies it's actually working (install, doctor, status) -- including what `doctor` " +
      "reporting a failure means and what to do about it.",
  },
];

export function registerHelp(server: McpServer): void {
  for (const topic of TOPICS) {
    server.prompt(topic.name, topic.description, () => ({
      messages: [{ role: "user", content: { type: "text", text: topic.ask } }],
    }));
  }
}
