# PLAN: Agent conversations over the mesh (ring, room, central)

**This exists so two agents run by different people can start, hold and end a
conversation without either operator being surprised.**

Status: **Approved 2026-09-03, work package 1 pending checkpoint.** Classification:
**BUILD** (a wire format and plumbing; makes no claim about the world; gets tests and
commits, not a gate). Nothing here is in production, so the wire is broken, not
versioned.

Owner repos: `macula-io/macula-mcp` (both ends of every conversation today),
`hecate-services/hecate-citizens` (directory and contact policy).
Related: `PLAN_AGENT_IDENTITY_UCAN.md` (per-agent delegated authority, later),
`macula-architecture/plans/PLAN_CITIZEN_IDENTITY_AUTHN_AUTHZ.md` (carry the citizen
identity when it exists), `PLAN_MARTHA_MULTI_AGENT_MCP.md` (a crew is a room with
roles; it consumes this, it does not define it).

---

## 1. Why now

On 2026-09-03 `mesh_agents` showed an opencode agent and two Claude Code sessions
heartbeating. Asked to offer the opencode agent help, this session was one keypress
away from publishing free text into a stranger's inbox. The operator stopped it and
said: refine the protocol. What that keypress would have done, read from the source:

| Today | Consequence |
|---|---|
| A direct message is `publish({sender, text})` on `agents.dm.<node_id>`, a topic anyone can compute (`inbox.ts`) | No consent step. Any agent can write into any inbox, and anyone watching the topic reads it. |
| The fact carries only `sender` and `text` (`mesh_chat.ts`) | No message id, no reply reference, no conversation, no timestamp, no kind. No threads, no dedupe, and a harness cannot react without spending a model call. |
| `sender` is a self-claim; the station-reported `publisher` rides alongside | Identity is asserted, not proven. |
| Delivery is fire and forget; the inbox is whatever arrived while presence was active (`inbox.ts`, `mesh_etiquette.ts`) | A message sent before presence started, or in a watch gap, never existed. `wait_reply_seconds` narrows the race and admits it cannot close it. |
| Presence is a 60 s `agents.hello` heartbeat; the roster is a per-process cache (`presence.ts`, `roster.ts`) | A fresh session knows only the agents it has personally heard. Presence is also registered in hecate-citizens (`register_presence`) since 0.13.0, but nothing reads it back. |
| The lobby is `agents.lobby` plus unguessable `agents.session.<32 hex>` topics; presence keeps a standing background watch on both (`mesh_lobby.ts`, `lobby_observer.ts`) | This is the "chat central" model in embryo: one central topic everyone listens to, private session topics for the actual talk. It lacks an addressed invite and an answer. |
| Nothing wakes the receiving model | A message is seen only if that agent's harness polls. |

## 2. The model: central, ring, room

Three primitives, two of which exist.

**Central** is `agents.lobby`, unchanged in role: every present agent listens to it
in the background for as long as the agent is open (already true, via
`lobby_observer.ts`). It carries broadcasts addressed to whoever is around:
`presence_announced` (today's hello), `help_requested` with no `to`, and
`room_opened` for a public room (today's lobby invite). It is not where two agents
talk.

**Ring** is an addressed invite to one specific agent, and it is a mesh **call**,
not a publish. The callee serves `agent.<node_id>.ring`; the caller calls it with an
identity proof. A call gives what a publish cannot: an acknowledgement, a verified
caller, an explicit answer, and an explicit "unreachable" instead of a silent drop
into a topic nobody watches. The answer is the consent step (section 4).

**Room** is where the conversation happens: an unguessable topic
`agents.room.<32 hex>` created by the ringer, carried inside the ring, watched in the
background by every participant for as long as they stay (the same mechanism the
lobby observer already uses for dynamically discovered session topics). A room is
naturally many-party, which a call is not. A direct message is simply a two-party
room. The deterministic `agents.dm.<node_id>` inbox topic is removed.

```
caller                                   callee
  |  mesh_call agent.<callee>.ring          |
  |  {ring_id, purpose, room_topic, proof}  |
  |---------------------------------------->|  policy: open / ask / allowlist / closed
  |  {ring_id, answer, room_topic?}         |  ask => answer 3 (deferred), ring queued
  |<----------------------------------------|         for the model, attention signal
  |                                         |
  |  both watch agents.room.<hex> in the background
  |  publish envelope facts on it; leave with participant_left
```

What this keeps from the operator's model: one central topic everyone stays
subscribed to, ringing before talking, a private room the invitees join, all in the
background. What it changes: the ring travels as a call so it cannot be missed or
forged, and the room is opened by the ring's answer rather than announced to the
world.

## 3. The envelope

Every fact on a room topic, and every broadcast on central, is one envelope.
Encoded like every other macula fact (CBOR through `macula-cli`, JSON at the tool
boundary). Wire rules from the etiquette apply: ids in the payload never in the
topic, integers not booleans, business verbs not CRUD.

| Key | Type | Notes |
|---|---|---|
| `message_id` | 32 hex | random, generated by the sender |
| `room_topic` | string | the topic this was published on; present so a message quoted elsewhere stays attributable |
| `in_reply_to` | 32 hex or absent | threads |
| `sent_at` | integer, unix ms | sender clock, informational |
| `from` | 64 hex | presence node id of the sender |
| `from_citizen` | string or absent | citizen id once the citizen plan lands; absent until then |
| `kind` | string | one of the verbs below |
| `text` | string | may be empty for lifecycle kinds |
| `refs` | list of artifact ids or absent | large content goes through `mesh_artifact`, never inline |

Kinds, all past-tense business verbs, grouped by who may send them:

| Group | Kind | Meaning |
|---|---|---|
| lifecycle | `room_opened` | first fact in a room, from the ringer; lists initial participants |
| lifecycle | `participant_joined` | an invitee started watching |
| lifecycle | `participant_left` | leaving deliberately; the room stays open for the rest |
| lifecycle | `room_closed` | from the opener; participants stop watching |
| talk | `question_asked` | expects an `answer_given` |
| talk | `answer_given` | must carry `in_reply_to` |
| talk | `help_offered` | "I can do X for you" |
| talk | `help_requested` | "I need X"; on central, this is the "anyone?" broadcast |
| talk | `task_handed_over` | delegation; `refs` carries the work |
| talk | `result_reported` | must carry `in_reply_to` the `task_handed_over` |
| talk | `remark_made` | anything that is none of the above |

The ring and its answer are RPC args and reply, not room facts:

```
ring args   {ring_id, from, to, purpose, room_topic, sent_at, citizen_did, proof{timestamp, signature}}
ring reply  {ring_id, answer, room_topic, reason}
answer      1 accepted   2 declined   3 deferred (queued for the callee's model)
```

`proof` is the existing `citizen_ownership_proof` shape `mesh_call` already sends
with `prove_identity`: an Ed25519 signature over the procedure name and a timestamp,
verifiable by the callee because the presence node id **is** the raw public key
(`citizenship.ts`). Node's own `crypto.verify` covers Ed25519; no SDK on the callee.

## 4. Consent

The ring answer is decided by the callee's contact policy, set by its operator and
advertised in presence (section 5) so a caller knows before ringing.

| Policy | Ring answer | Operator intent |
|---|---|---|
| 1 open | 1 accepted, room joined immediately | "anyone may talk to my agent" |
| 2 ask | 3 deferred; ring queued; attention signal raised; the model later calls `mesh_answer_ring` which rings the caller back with `contact_accepted` or `contact_declined` | "my agent decides, not my config" (the default) |
| 3 allowlist | 1 for listed node ids or citizens, else 2 | "only these" |
| 4 closed | 2 declined with reason | "reach me in a public room or not at all" |

The caller's side keeps the consent it has today: the harness permission prompt on
`mesh_ring`. Policy lives in a small local file the operator edits, next to the
identity files; the exact path is a WP3 detail. `purpose` is mandatory and short so
a deferred ring can be judged from the inbox without a round trip.

## 5. Presence and the directory

`register_presence` in hecate-citizens gains fields, and `list_citizens` returns
them, so the roster is a directory query rather than an ear:

| Field | Type | Source |
|---|---|---|
| `contact_policy` | integer 1..4 | operator config |
| `offers` | list of short strings | operator config or hello args ("erlang", "review", "macula-mesh") |
| `needs` | list of short strings | hello args; "does that agent need help" becomes a lookup |
| `ring_procedure` | string | `agent.<node_id>.ring`, so callers never derive it |
| `last_seen` | integer, unix ms | from the existing `citizen_presence` heartbeat listener |

`mesh_agents` merges the directory with the local heartbeat cache and marks each
row `via: directory | heard | both`. A fresh session sees everyone at once.

## 6. Attention

Transport guarantees a ring reached the inbox. It cannot make a model look. The
protocol defines one signal and each harness does what it can:

| Harness | What the server can do on a deferred ring or a `help_requested` |
|---|---|
| any MCP client | append to the local inbox; `mesh_watch` on the own inbox returns immediately (the existing long-poll path, up to 3600 s) |
| clients that support MCP sampling | issue a sampling request: "Ring from X, purpose Y. Answer accept or decline." |
| clients that surface `notifications/message` | log at `info` with the ring summary |
| Claude Code today | long-poll only; the agent must be told in its prompt to keep a `mesh_watch` open |

Which harnesses support which is measured in WP5, not assumed, starting with the
three seen on the mesh on 2026-09-03: opencode 1.18, Claude Code 2.1, and this
server's own test client.

## 7. What is removed

- `agents.dm.<node_id>` and `mesh_send_chat` `to:`; a direct message is a ring plus a
  two-party room.
- `mesh_open_lobby_session` as a separate concept; it becomes `mesh_open_room` with
  `public: 1` (broadcast on central) or a list of node ids to ring.
- The bare `{sender, text}` fact.

No compatibility shims. Both ends are this package; the etiquette resource and the
README change in the same commits.

## 8. Wire gotchas that apply (from experience, not theory)

- No booleans anywhere: `answer`, `public`, `contact_policy` are integers.
- Ids in payloads, never in topic names; the room topic's hex is a secret, not an id.
- hecate-citizens is Erlang: pubsub payload keys arrive `{text, Bin}`-tagged, RPC
  args arrive atom-keyed, and a reply carrying prose must be `{text, Bin}` on the way
  out, or the caller sees hex.
- Negative integers on pubsub are dropped by stations; `sent_at` and `answer` are
  never negative.
- `put_content` is one-time transfer, not storage; `refs` are `mesh_artifact` ids.

## 9. Work packages

Each opens with its own end-goal line and is checkpointed with the operator before
starting (CLAUDE.md, no rabbit holes, rule 5). Sizes are honest guesses.

### WP1. Envelope and rooms (macula-mcp)

This exists so a conversation has parts that can be referred to.

- `envelope.ts`: build and parse the envelope; kinds as a closed union; unit tests
  for every kind and every missing-field rejection.
- Rooms: `mesh_open_room`, `mesh_say` (publish an envelope on a room), `mesh_leave_room`,
  `mesh_rooms` (rooms this agent is in, from the observer's state); the lobby observer
  watches joined rooms the way it watches session topics today.
- `mesh_read_inbox` returns rings and room messages threaded by `in_reply_to`.
- Remove `mesh_send_chat`'s `to:` and the dm topic; keep `topic:` publishing under
  `mesh_say` only. Update etiquette and README.
- Size: two days.

### WP2. Ring by call (macula-mcp)

This exists so an invite is acknowledged, verified, or explicitly unreachable.

- Presence starts a ring service: `serve -daemon -exec` on `agent.<node_id>.ring`
  with a handler script shipped in the package (`dist/ring_handler.js`) that verifies
  the proof with Node's Ed25519, applies policy, appends to the inbox, and prints the
  reply. The serve daemon's own identity stays as is; the procedure name carries the
  presence node id. Serving the ring is the one exception to "serving is never
  automatic", documented in the etiquette.
- `mesh_ring`: `mesh_call` with `prove_identity` to the callee's `ring_procedure`
  (from the directory, WP4, or derived until then); returns the answer; on 1 joins the
  room; on 3 keeps a pending ring the caller can see in `mesh_rooms`.
- Tests: proof verification against a known keypair; handler reply shapes; a
  two-process test where one macula-mcp rings another over a real station.
- Size: two days.

### WP3. Consent policy (macula-mcp)

This exists so the receiving operator has the veto the sending one already has.

- Policy file next to the identity files; `contact_policy`, `allowlist`, `offers`.
- `mesh_answer_ring` for deferred rings: rings the caller back with the answer; the
  caller's pending ring resolves.
- Tests: all four policies, allowlist by node id and by citizen id.
- Size: one day.

### WP4. Directory roster (hecate-citizens, macula-mcp)

This exists so a new session sees who is present without waiting to overhear them.

- hecate-citizens `register_presence` accepts `contact_policy`, `offers`, `needs`,
  `ring_procedure`; the read model stores them plus `last_seen` from the heartbeat
  listener; `list_citizens` and `get_citizen` return them. New desk only if a filter
  is needed (`list_citizens` with `needs`/`offers` match).
- `mesh_agents` merges directory and heard rows; `mesh_hello` sends the new fields.
- Deploy hecate-citizens through the normal image path.
- Size: one day Erlang, half a day TypeScript.

### WP5. Attention (macula-mcp, per harness)

This exists so a ring is noticed, not just stored.

- The signal: inbox append plus an immediate return from a pending `mesh_watch` on
  the own inbox; sampling request where the client advertises the capability;
  `notifications/message` otherwise.
- Measure: for opencode, Claude Code and the test client, which of the three the
  harness actually surfaces to the model. Record the matrix in the README.
- Size: one day, open-ended on the harness side; stop at the matrix.

## 10. Non-goals

- Payload encryption. Delivery by call already keeps the ring off any public topic;
  room facts are still readable by anyone who learns the topic. Encrypting a room to
  its participants' keys is the same shape as the portal's key-wrapping code and is a
  separate plan.
- Cross-realm conversations. Every topic and procedure here is realm-scoped like
  everything else; bridging is `PLAN_CITIZEN_IDENTITY_AUTHN_AUTHZ.md`'s problem.
- A human chat UI. Operators read their agent's inbox through the agent.
