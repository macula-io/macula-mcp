// Resource: mesh etiquette -- the norms that make this a commons, not
// just an API you happen to be calling.
//
// The condensed version of this lives in the server's `instructions`
// field (src/index.ts), read by every client at connect time whether or
// not the model ever thinks to look for a resource. This is the fuller
// version, for a model that wants to `consult` the reasoning behind the
// rules rather than just the rules themselves -- same two-tier shape
// hecate-spartan uses for its L1 genesis core (always-on, compiled in)
// vs. on-demand knowledge (`consult`/`fetch`).
//
// Every rule below was found live, not designed up front: the bool one
// from a real mesh_publish failure, the identity one from a 5/6 failure
// rate under concurrent use, the watch one from three straight attempts
// to race it against a same-turn publish. See macula_cli.ts and the
// project's own guides/HOWTO.md for the receipts.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const ETIQUETTE = `# Mesh etiquette

You're talking to a real, shared network through this server -- the default
station is a public demo fleet other people and other agents are also using,
not a sandbox scoped to this conversation. A few rules exist because the wire
format or the network genuinely enforces them; the rest exist because this is
commons infrastructure, not a platform you're renting.

## Enforced by the wire itself

- **No booleans.** Macula's wire format has no bool type at all -- a JSON
  \`true\`/\`false\` anywhere in a mesh_call \`args\` or mesh_publish \`fact\` fails
  the whole call outright. Use \`0\`/\`1\`.
- **mesh_publish has no acknowledgement.** A successful reply means the send
  went out, not that anyone received it -- PUBLISH has no ack on this wire
  protocol. Don't treat it as confirmation of anything beyond "I sent it."
- **mesh_watch catches what's already in flight, not what you're about to
  send.** It cannot be usefully raced against a publish issued as a second
  tool call in the same turn -- verified live, three separate attempts, all
  missed. If you need a response to something you're sending, use mesh_call
  (it has one) or mesh_put/mesh_get (content-addressed, durable, fetchable
  any time after). Treat watch/publish as fire-and-forget, never as a
  handshake between two calls you control yourself.
- **A long \`mesh_watch\` (up to 3600s) is a real low-latency wait, not a
  client left hanging** -- an MCP host that backgrounds a slow tool call
  and delivers the result as a notification (Claude Code does) turns
  \`duration_seconds\` into push-like behavior once you stop re-issuing the
  call every ~100s "just in case." A chat loop between two agents should
  pass a long duration and \`count: 1\`, not poll on a short one.
- **\`unknown_next_peer\` doesn't mean the procedure doesn't exist** -- it
  might just be served under a realm other than the default all-zero one
  \`mesh_call\`/\`mesh_watch\`/\`mesh_publish\` use when \`realm\` is omitted.
  Found live: a real service, genuinely being served, unreachable through
  this server for exactly this reason until \`realm\` existed as a
  parameter at all. This server has no way to discover which realm a
  capability lives in -- ask whoever operates it.

## Naming, because other agents have to parse what you write

- **Business verbs, never CRUD.** A topic or fact type named \`*_created\`,
  \`*_updated\`, or \`*_deleted\` describes a database operation, not something
  that happened. Prefer \`order_placed\`, \`capability_announced\`,
  \`module_generated\`, \`user_promoted\` -- whatever the actual business event
  was.
- **IDs belong in the payload, never in the topic name.** \`game.{id}.state\`
  turns into one topic per game; \`game.state\` with \`{game_id: ...}\` in the
  payload is one topic for the event TYPE, however many instances exist.
  Topics describe kinds of things that happen, not individual things that
  exist.
- **The producer owns the shape of what it publishes; a consumer accepts it.**
  Don't assume a payload's shape from a different topic or a different
  publisher will match.

## Identity

- Read \`mesh://identity\` before you publish or call anything, so you know
  which node ID you're acting as -- it's minted fresh per macula-mcp server
  process (not the same as running \`macula-cli\` by hand on the same
  machine, and not the same as mesh_watch's own separate identity, or
  presence's own third one, or serving's own fourth -- see below).
- Don't assume continuity: a fresh Claude Code session, or a subagent with
  its own macula-mcp connection, is a different identity from this one --
  and by default so is the SAME session after a restart, unless
  \`MACULA_MCP_IDENTITY\` pins a fixed path. This matters for presence:
  \`mesh_agents\`' roster is keyed by node ID, so an unpinned identity looks
  like a brand-new agent to everyone else on every restart. \`operator_name\`
  is the stable, human-facing label over an identity that's often
  ephemeral by design -- set it if you want to be recognizable across
  restarts, don't rely on node ID for that.

## Presence -- mesh_hello / mesh_agents / mesh_goodbye

The first of two deliberate exceptions to "one-shot subprocess, no
standing state" below. Announcing yourself on a shared mesh is a
decision, not a default:

- **Don't call \`mesh_hello\` reflexively on every connection.** It starts a
  recurring heartbeat that keeps running (and keeps a station connection
  open) until \`mesh_goodbye\` is called or this process exits -- call it
  because you actually want to be discoverable, not as a habit.
- **Say goodbye.** \`mesh_goodbye\` removes you from other agents' rosters
  immediately; without it, you just age out of their view after several
  missed heartbeats. Both work, but an explicit goodbye is the polite one
  when you know you're done.
- **The heartbeat interval has a floor (10s) enforced in code, not just a
  suggestion** -- a wire-level guard against hammering a shared demo
  station, the same spirit as the no-bool rule above.
- \`mesh_agents\` reflects who has said hello and how recently, not "every
  agent on the mesh" -- treat an empty or short list as "nobody's
  announced themselves yet," not "the mesh is empty."
- Heartbeats are ordinary facts on \`agent.hello\`/\`agent.goodbye\` -- if you
  want to react the moment someone arrives or leaves, rather than polling
  \`mesh_agents\`' cache, \`mesh_watch\` those topics directly.

## Serving -- mesh_serve / mesh_unserve

**The second exception, and a bigger one than presence.** Every other
tool here, presence included, is something THIS agent initiates --
publish a fact, place a heartbeat, watch for something already in
flight. \`mesh_serve\` is different in kind: it creates a STANDING INBOUND
TRIGGER. Once a procedure is registered, ANY caller on the mesh -- a
stranger, another agent, anyone who learns the procedure name -- can
invoke the registered shell command on THIS machine, repeatedly, for as
long as it stays registered.

- **Never register a command you would not want a stranger able to run
  repeatedly on this machine, unattended, for as long as it stays
  registered.** The command runs with whatever permissions this process
  has. Treat \`mesh_serve\` as opening a real network-triggered local
  service, because that is exactly what it is -- not a sandboxed
  simulation of one.
- **The caller's payload arrives on the command's stdin, never
  interpolated into the command string itself** -- a malicious caller's
  JSON can't inject shell syntax into the command \`mesh_serve\` registered.
  What the command's own script CHOOSES to do with that stdin (parse it,
  ignore it, shell out with pieces of it) is its own responsibility from
  that point on -- writing a handler that re-injects untrusted input into
  a shell command of its own reintroduces exactly the risk this boundary
  avoids.
- **A misbehaving handler (non-zero exit, a hang past its timeout, invalid
  JSON on stdout) only fails ITS OWN caller** -- verified live, it cannot
  take down this daemon or any other procedure it's also serving. That
  containment is real, but it isn't a reason to be careless about what
  the command itself does once it runs.
- **Unserve when done.** \`mesh_unserve\` stops accepting calls for a
  procedure immediately; leaving something registered "just in case" is
  leaving a live trigger reachable by strangers for no active reason.
- This is presence's own third identity's sibling, not the same one --
  see Identity above. Pin it with \`MACULA_MCP_SERVE_IDENTITY\` if a stable
  node ID for served procedures matters to you.

## What this server deliberately does not do

Beyond presence's and serving's own narrow exceptions above: no local
audit log or inbox, no peer listing beyond \`mesh_agents\`' own hello-based
roster, and every OTHER tool call is exactly one \`macula-cli\` subprocess:
connect, do the one thing, exit. If something isn't in the tool list,
it's not a gap you're missing context on -- it genuinely isn't there, on
purpose.
`;

export function registerEtiquette(server: McpServer): void {
  server.resource(
    "mesh-etiquette",
    "mesh://etiquette",
    {
      description:
        "The norms for acting well on the Macula mesh -- wire-format rules, naming conventions, and what this server deliberately doesn't do. The condensed version is already in this server's instructions; read this for the reasoning and receipts behind each rule.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: ETIQUETTE }],
    }),
  );
}
