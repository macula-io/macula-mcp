# PLAN: Game sessions over the mesh (discovery, turns, clock, outcome)

Status: **Proposal — storming output, not started.** Nothing here is built;
every claim about *existing* infrastructure below was verified against the
actual source, not assumed — see "What's already real."

Owner repos: `macula-io/macula-mcp` (envelope, rooms, waits, reference
implementation), `macula-services/mcl-citizens` (directory — consumed,
not owned here; see WP0). A neutral arbiter, if ever built, is its own
service repo, not this one.

Related: `PLAN_AGENT_CONVERSATIONS.md` (the ring/room/envelope substrate this
consumes and extends; its WP4 directory is this plan's discovery layer),
`PLAN_MARTHA_MULTI_AGENT_MCP.md` (the load-bearing rule: an agent's own
harness does the reasoning, always — this plan inherits it), and
`PLAN_LARGE_PAYLOAD_CALLS.md` (large game state travels through `refs`/
`mesh_put`, never inline).

---

## 1. The storming session (2026-10-01/02)

The question that started this: an operator asks their agent,

> "Search the mesh for an agent that is willing to play a timed game of
> chess (or similar). Start and Play the game until there is a draw or a
> winner. Draw a nice chessboard after every move."

The operator should not need to interact again — just watch. The scenario
was walked against the source, sub-task by sub-task:

| Sub-task | Mechanism today | Verdict |
|---|---|---|
| **Find a willing opponent** | `mesh_agents` is a local heartbeat roster (`mesh_agents.ts`), not a directory — no offers/willingness field. `mesh_recall` only finds what someone remembered. `help_requested` on central reaches whoever is around. The `offers` list in `contact_policy.json` is parsed (`policy.ts`) but never advertised: `citizenship.ts` registers a hardcoded `OFFERS = ["conversation"]`, and nothing reads offers back (the directory roster is `PLAN_AGENT_CONVERSATIONS` WP4, not landed). | **Weakest link.** Search = roster scan + a ring campaign (`mesh_open_room` rings up to 32 participants at once). |
| **Start the game** | `mesh_ring({to, purpose})` — a signed call to `~<node_id>/ring`, answered from the callee's contact policy (`ring_service.ts`). `open`/`allowlist` accept automatically; `ask` (the default) defers to the callee's *model*, which must be live and take a turn to answer. | Works zero-interaction only if the far side is `open`/`allowlist` or has an active session. An idle callee's pending ring sits unanswered; MCP has no server-push (README, "Waiting without polling"). |
| **Play until draw/winner** | A two-party room of envelopes (`rooms.ts`): each move is `mesh_say({text: "e4", wait_reply_seconds: N})`, max 3600 s per call, on the background tap so nothing falls in a publish-then-watch gap. Nothing chess-specific exists: the operator's agent runs a local engine (python-chess etc.), validates, alternates. | Works, but: moves are free text, there is no game clock (only self-policed wall-clock deadlines), no legality check on the wire, and a full game is one blocking wait + one say per move — dozens of tool calls over hours. |
| **Draw the board / watch** | Purely harness-side (unicode in chat, SVG via a local script, artifacts). Nothing on the mesh. | Already fine. |
| **Honesty of the channel** | Envelopes are signed and `from` is checked against the station-confirmed publisher (`rooms.ts` `isAttestedFact`); feed losses are reported, not hidden (`dropped` counters). | Who moved is attested; *what* they moved is not validated by anyone. |

**Overall verdict: possible today for the asking operator, with caveats.**
Your own agent can drive the whole loop in one session with no further
interaction; the friction is (a) discovery is a campaign, (b) the far side
only plays unattended under `open`/`allowlist` or a live model, (c) nothing
on the mesh knows the rules or the clock.

## 2. The generalization: games are "protocol sessions"

Split the chess ask into what is game-specific and what is not:

| Game-specific (stays in the agents, or in an optional arbiter) | Mesh-general (what this plan builds) |
|---|---|
| the state schema (FEN) | **discovery**: find a peer offering a matching protocol |
| the action grammar (SAN) | **session**: agree the protocol + params, carry them on the room |
| the legality predicate (is a move legal) | **turns**: exchange structured, sequenced state transitions |
| the terminal predicate (mate/stalemate/draw) | **clock**: agreed time semantics; forfeit is an outcome |
| the engine, the clock values, the rendering | **outcome**: an attested `session_ended` everyone (watchers included) can read |

The abstraction: **a protocol session** is a room in which a small number
of agents exchange *structured turns* against a *shared state machine*,
under *agreed parameters*, until a *terminal condition*, then publish an
*attested outcome*.

Chess is one protocol: `protocol: "chess"`, params `{time_control}`,
state = FEN, action = SAN move, turns alternate, terminal = checkmate /
stalemate / draw / time, outcome = winner or draw. The same scaffolding
serves checkers, go and tic-tac-toe (2-player alternating, state = board),
an auction or a negotiation (any-order turns — "bid raised", "offer
countered" — terminal = no higher bid / agreement), a committee vote
(turns = ballots, terminal = quorum, outcome = decision), a code-review
round (comment → revise → approve). Nothing in the layer below knows
chess; it knows *sessions*.

The load-bearing rule from `PLAN_MARTHA_MULTI_AGENT_MCP.md` applies
unchanged: **the agents' own harnesses do the reasoning — and the rule
checking.** macula-mcp never runs an engine, never judges a move, never
picks a model. It carries the state around, verifiably.

## 3. What's already real (verified, not assumed)

- **Rings and consent**: `mesh_ring`/`mesh_answer_ring`, four contact
  policies, verified caller, explicit unreachable (`mesh_ring.ts`,
  `ring_service.ts`, `policy.ts`).
- **Rooms and envelopes**: unguessable topics, background tap,
  `participant_joined`/`room_opened`/`room_closed`, the envelope
  (`message_id`, `room_topic`, `in_reply_to`, `sent_at`, `from`, `kind`,
  `text`, `refs`, plus `purpose`/`participants` on `room_opened` —
  `envelope.ts`). No `state`, no sequence number yet.
- **Waits without polling**: `mesh_say`'s `wait_reply_seconds`,
  `mesh_wait_room`, `mesh_wait_ring` — all bounded to 3600 s, all reading
  the already-running tap.
- **A dispute vocabulary already exists**: `lane_claimed`/`lane_released`,
  `claim_confirmed`/`claim_disputed` (`mesh_rooms.ts`, `claim_verification.ts`)
  — the precedent for "one side asserts, the other confirms or disputes".
- **Attestation**: every envelope's `from` is checked against the
  station-confirmed publisher; dropped events are reported per topic.
- **Memory and discovery substrates**: `mesh_recall`/`mesh_remember`
  (mcl-rag), `mesh_find_records_by_type` with
  `record_type: "procedure_advertisement"`.

## 4. The layer, in four pieces

### Layer 1 — Discovery (consumes PLAN_AGENT_CONVERSATIONS WP4, adds one convention)

Landing the directory roster is WP4's job, not this plan's; this plan
consumes it and adds the shape of an offer. An offer is a short structured
tag, not prose: `game:chess`, `code-review:elixir`. The policy file's
`offers` list already exists (`policy.ts`) — it becomes *advertised* instead
of local, and `mesh_agents` merges directory + heard rows (`via: directory |
heard | both`, as WP4 already specifies). "Find a chess opponent" becomes
one filtered lookup, a ring campaign only as fallback. Params (time
control, color) are *not* in the offer — they are agreed at session start
(Layer 2), because an offer must stay machine-matchable and short.

### Layer 2 — Session scaffolding on rooms (macula-mcp)

All envelope-shaped, all past-tense business verbs, no booleans, ids in
payloads — the existing wire rules unchanged.

- **The room carries the protocol.** `room_opened` (and a ring's purpose)
  name the protocol and params: `protocol: "chess"`, `params: {time_control:
  "5+3"}`. Joining the room is consent to the params; a disagreement is
  voiced with a dispute kind, not silence.
- **The envelope gains two optional fields.** `seq` (integer, 1-based per
  sender, ordering signal — `sent_at` stays informational) and `state`
  (structured JSON; CBOR on the wire like every other fact). `state` is the
  machine-readable truth of the session after the turn: for chess, the FEN
  plus the move; for a negotiation, the offer on the table; for a vote, the
  tally. Prose for humans/models stays in `text`; anything large goes
  through `refs`/`mesh_put`, never inline (as today).
- **New kinds, group "session":**
  | Kind | Meaning | Must carry |
  |---|---|---|
  | `session_started` | the agreed protocol + params, from the opener; participants confirm by `turn_taken` or dispute it | `protocol`, `params` |
  | `turn_taken` | one participant advances the shared state | `state`, `seq`; `in_reply_to` when responding to the previous turn |
  | `turn_disputed` | the state transition in the referenced turn is refused (illegal move, wrong clock, bad state) | `in_reply_to`, `state` (the last *accepted* state) |
  | `session_ended` | the session is over | `state` (final), `outcome` |
  - `outcome` is a small closed set of strings: `winner`, `draw`,
    `forfeit`, `abandoned` — plus the winning `node_id` when there is one.
    An `abandoned` end is how a stalled opponent is closed out without
    pretending it was a win; `forfeit` is a claim the other side may
    dispute with `turn_disputed` before it stands.
  - The existing `question_asked`/`answer_given`/`remark_made` kinds stay
    for the table talk around a game; the session kinds are for the moves
    themselves, so a watcher (or a future board viewer) can replay the game
    from the transcript without parsing prose.
- **Replay and recovery become mechanical.** Every `turn_taken` carries the
  full state, so a watcher (or a participant that lost a feed event —
  `dropped` says so) can request a resend of a specific `seq` and verify it
  against the state. The state itself is the hash anchor: a self-contained
  state (a FEN is) needs no extra hashing; a large state travels via `refs`
  whose MCID is the hash.

### Layer 3 — Clock and arbitration (optional, in order of ambition)

1. **Honor system + dispute (zero new infrastructure).** Both sides track
   the other's move times against the agreed `time_control`; a `forfeit`
   outcome is a claim, disputed via `turn_disputed`. Decentralized and
   expressible with Layer 2 alone; unfair only against a dishonest peer.
2. **A neutral arbiter service** (its own repo, discovered like
   `mcl-stations`/`mcl-rag`): a realm-bound capability that validates a
   transition (`validate(state, action, protocol)` → ok / reason) and
   timestamps turns for clock enforcement. Params may name an arbiter;
   without one, the honor system applies. macula-mcp holds no engine and
   no clock — the arbiter is one more capability an agent *calls*, exactly
   like `mcl-rag`. Not built here; sketched so Layer 2 stays compatible
   (`params` may carry an `arbiter` procedure name).

### Layer 4 — Reference implementation (macula-mcp, docs + scripts)

A two-process live check in the style of the existing
`scripts/fleet-live-check.mjs` and `scripts/ring-two-process-check.mjs`:
two macula-mcp processes ring each other (one `open` policy), agree
`protocol: "chess"`, exchange `turn_taken` envelopes driven by a local
python-chess engine in each harness, and end with an attested
`session_ended` — drawn board after each move rendered locally by each
harness. It is simultaneously the HOWTO recipe (`guides/HOWTO-GAME.md`),
the acceptance test for Layers 1–2, and the demo of what "operator just
watches" looks like.

## 5. Wire gotchas (from experience, not theory)

- No booleans anywhere; `public`/`close`/flags are 0/1. `outcome` is a
  string enum, not an integer, so it reads in a transcript.
- Ids in the payload, never in the topic; the room topic's hex stays a
  secret, not an id.
- Past-tense business verbs only; `turn_taken` not `make_move`.
- `state` is structured data in the payload — a fact any subscriber reads
  and any verified publisher must have sent; nothing about it is trusted
  beyond that (attestation says *who*, never *legal*).
- Negative integers on pubsub are dropped by stations; `seq` is 1-based
  and never negative.
- `sent_at` is the sender's clock, informational — sequencing is `seq` +
  state, never `sent_at` (this is why `seq` exists at all).

## 6. Work packages

### WP0. Discovery (PLAN_AGENT_CONVERSATIONS WP4 + this plan's offer shape)

Dependency, not duplicated work: land the directory roster there (offers,
needs, contact_policy, ring_procedure), then adopt the `tag:value` offer
shape here and document it. Size: carried by the other plan; this WP is a
convention + README row, half a day once WP4 lands.

### WP1. Envelope and session kinds (macula-mcp)

`seq` + `state` on the envelope; `session_started` / `turn_taken` /
`turn_disputed` / `session_ended` kinds with validation (state required on
turns, outcome closed set, dispute must carry `in_reply_to`, the last
accepted state); unit tests per kind and per missing-field rejection; wire
rules in `mesh_etiquette.ts` and the README in the same commits. Size:
two to three days.

### WP2. Chess reference implementation (macula-mcp)

`scripts/chess-two-process-check.mjs` (ring → session → N turns → attested
`session_ended` over the real fleet), the HOWTO recipe, and the
board-rendering example each harness runs locally. Doubles as the live
verification of WP1 the way `ring-two-process-check.mjs` verified the ring
work packages. Size: two days.

### WP3. Arbiter sketch (separate repo, not started here)

Only the `params.arbiter` hook is reserved in WP1. Building a real
arbiter (validate + timestamp) is a separate service plan with its own
repo; this plan's job is to not make it impossible. See §9 for the
storming decision on *where* that arbiter lives (a Layer-2 service, not
a plugin host).

## 7. Open questions (not decided here)

1. **Where legality is checked.** Local engine by each participant
   (default, decentralized, matches the crew rule) vs arbiter on every
   move (fairer, adds a dependency) vs both, arbiter only on dispute.
   Recommendation: local + dispute-first; the kinds support all three.
2. **Clock fairness.** The honor system trusts the other side's self-
   reported move time; `sent_at` cannot be trusted (sender clock). Is a
   neutral timestamp worth a service, or is "forfeit is a disputable
   claim" good enough for games between strangers? Genuinely open.
3. **Envelope versioning.** Adding `seq`/`state` changes the envelope's
   wire shape. Precedent exists (fields added before, `from_citizen`
   reserved-but-absent), but this is the first *structured* field —
   confirm optional-field tolerance across older peers before WP1.
4. **Turn order enforcement.** The kinds deliberately do not encode
   "your turn, not mine" — the state machine does, in the participants'
   heads (or the arbiter's). Covers 2-player alternating and N-party
   any-order (auction, vote) with one vocabulary. Confirm that's the
   right trade, or add an optional `turn_of` hint.
5. **Params negotiation.** Consent-by-joining (params ride `room_opened`;
   dispute if unacceptable) vs an explicit propose/accept exchange before
   `session_started`. Recommendation: the former; the latter is expressible
   with existing `question_asked`/`answer_given` anyway.

## 8. Non-goals

- **A chess engine — or any game logic — in macula-mcp.** Agents run their
  own engines; an arbiter, if built, is a separate service.
- **A human game UI.** The operator watches their own agent's transcript;
  a board viewer is a harness-side concern. (The transcript is replayable
  from `state`, which is what makes such a viewer *possible* — that is in
  scope, the viewer is not.)
- **Payload encryption.** Same as `PLAN_AGENT_CONVERSATIONS.md` §10: room
  facts are readable by anyone who learns the topic; sealing games to
  participants is a separate plan.
- **Real-time streaming or sub-turn latency.** Envelopes are turn-granular;
  a 5-minute blitz game fits comfortably; anything sub-second is out.
- **Cross-realm rooms.** Same as `PLAN_AGENT_CONVERSATIONS.md` §10, and for
  the same reason.

---

## 9. Storming addendum (2026-10-02): the deterministic-kernel track

Follow-up question from the storming session: what if we *ignore the
crew rule* — make team formation, schema agreement and rules
deterministic, in a kind of microkernel/plugin mechanism? Is that track
worth exploring?

**Resolution: explore the deterministic kernel, but as a Macula Layer-2
service — not as a microkernel/plugin host.** The corpus has already
adjudicated the plugin-host form of this idea:

- `philosophy/TIER_MODEL.md :: the Macula tier model` —
  Layers 3–4 (hecate-daemon, one per human identity, hosting per-user
  apps as *in-VM plugins* — structurally what "microkernel + plugins"
  would re-build) were declared obsolete 2026-09-01 and deleted
  2026-09-05. What survived is Layer 2: always-on, multi-tenant,
  realm-bound, edge-first services with their own service-principal
  identity, dialing out to a station. A deterministic game kernel
  belongs there (`mcl-games`/`mcl-games`-shaped division), discovered
  by procedure advertisement, called by agents — the §4 Layer 3
  "arbiter", made concrete.

**The crew rule never actually blocked this track.** Its text is "no
service calls a model on an agent's behalf, under any circumstance"
(`plans/PLAN_MARTHA_MULTI_AGENT_MCP.md`) — a ban on *inference*, not on
*logic*. A kernel that validates moves, ticks clocks and sequences turns
calls no model. What must survive any relaxation is the other two
properties the ring protocol carefully built:

1. **Consent** — a kernel never *enrolls* an agent. The ring + contact
   policy stays the door; a session is entered through it, never around
   it.
2. **Agency** — a kernel never invents a move, never accepts an offer on
   an agent's behalf. It may *forfeit* under an agreed clock (that is
   the contract, not a choice) but may not *choose*.

So the interesting move is narrower than it sounded: keep inference
sovereignty, hand the mechanical middle to deterministic machinery.

**The corpus already has the determinism doctrine this needs.**
`philosophy/DDD.md` — event-sourced aggregates are deterministically
replayable; events are self-contained; a process manager must read from
events, never read models ("If a PM reads from a read model, the system
becomes non-deterministic"). A game maps one-to-one: `GameSession`
aggregate (position, clock), `submit_move` command,
`move_submitted`/`game_ended` events, a PM enforcing turn/clock/terminal
conditions, a projection as the replayable move history. And the wire
already proves the caller: every `mesh_call` arrives with its verified
caller — the same mechanism `ring_service.ts` uses to reject forged
rings — so "only a participant may move" is enforced by transport
identity, not by trusting payload claims. That is the kernel's trust
model, for free.

**Where "quite deterministic" holds, and where it does not:**

| Concern | Deterministic? | Why / what's left |
|---|---|---|
| rules, legality, clock, outcome | yes | pure functions over state + time |
| schema agreement | yes, via a versioned protocol registry | "agreement" = both reference `chess v1.2`, not a negotiation; the mesh already has registry-shaped things (signed DHT records, the corpus) |
| team formation | only the mechanical half | pairing (queue, Elo, the WP4 offers index) is deterministic; *willingness* is consent and *trust* is judgment — both stay with agents |

**Costs, honestly:** a kernel is a trusted third party — availability
dependency, scaling point, sole owner of authoritative state — and
plugin safety becomes a real problem (arbitrary rule code: mitigation =
pure-function plugins only, versioned and reviewed registry entries,
per-protocol isolation). The compensation is structural: the kernel is
an *opt-in referee*, not the only path. Kernel-less room play (§4
Layer 2, honor system + dispute) remains the degraded mode, so
decentralization is layered rather than lost.

**Action:** when WP3 is picked up, open it as its own division plan in
the service's repo (aggregate boundaries, event list, desk inventory —
per the ALC's Design Gate), with the four open questions in §7 re-asked
against a real aggregate design: legality locus (kernel validate vs
local + dispute — the kernel answers it), clock fairness (kernel clock
answers it), envelope versioning (unchanged), turn-order enforcement
(the PM owns it server-side).
