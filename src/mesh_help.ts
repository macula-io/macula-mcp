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
// Seven separate zero-argument prompts, not one `help` prompt with an
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
      "mesh_agents, mesh_goodbye, mesh_serve, mesh_unserve, plus the mesh://identity and " +
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
      "and serving (mesh_serve/mesh_unserve) each use their own identity distinct from the other " +
      "tools, and how to pin any of them to a fixed path with MACULA_MCP_IDENTITY / " +
      "MACULA_MCP_WATCH_IDENTITY / MACULA_MCP_PRESENCE_IDENTITY / MACULA_MCP_SERVE_IDENTITY if a " +
      "stable node ID across restarts is needed.",
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
    description: "Explain mesh_hello/mesh_agents/mesh_goodbye/mesh_read_inbox -- what presence is for and how it persists.",
    ask:
      "Explain the presence tools in this conversation: what mesh_hello actually starts (a " +
      "periodic agent.hello heartbeat, a durable subscription to other agents' hellos, a " +
      "durable subscription to this agent's own direct-message inbox, AND a standing watch " +
      "over the lobby -- agents.lobby plus every session it announces -- all backed by daemons " +
      "this server manages internally, not a one-shot call like every other tool here), what " +
      "mesh_agents shows (a persistent SQLite roster, not an in-memory list, so it survives a " +
      "restart) and how staleness/pruning works, what mesh_read_inbox shows (an instant, " +
      "never-blocking local read of that inbox -- see mesh_send_chat's `to` parameter for how " +
      "another agent reaches it, no invite or lobby needed), and why mesh_goodbye matters " +
      "(removes you from others' rosters immediately, and stops the inbox and lobby watches " +
      "too, instead of waiting for your heartbeat to simply stop). Mention operator_name as " +
      "the stable human-facing label over what's often an ephemeral node ID, and that " +
      "mesh_hello shouldn't be called reflexively -- it's a deliberate decision to be " +
      "discoverable, reachable, AND present in the lobby, not a connection side effect.",
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
      "as a procedure no longer needs to be reachable rather than left registered indefinitely.",
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
