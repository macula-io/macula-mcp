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
  machine, and not the same as mesh_watch's own separate identity).
- Don't assume continuity: a fresh Claude Code session, or a subagent with
  its own macula-mcp connection, is a different identity from this one.

## What this server deliberately does not do

No standing subscriptions, no local audit log or inbox, no peer listing, no
persistent state of its own beyond two throwaway identity files that die with
the process. Every tool call is exactly one \`macula-cli\` subprocess: connect,
do the one thing, exit. If something isn't in the tool list, it's not a gap
you're missing context on -- it genuinely isn't there, on purpose.
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
