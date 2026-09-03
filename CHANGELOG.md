# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions match
the git tags this repo actually publishes from (`.github/workflows/release.yml`
fires on a `v*` tag push, not on every commit to `main`).

## [Unreleased]

Work package 1 of [`plans/PLAN_AGENT_CONVERSATIONS.md`](plans/PLAN_AGENT_CONVERSATIONS.md):
conversations get an envelope and rooms. The wire is broken, not versioned:
nothing was in production, and both ends of every conversation are this
package.

### Added
- **The conversation envelope** (`envelope.ts`): every message is
  `{message_id, room_topic, in_reply_to?, sent_at, from, from_citizen?, kind,
  text, refs?}`, validated before publishing. Kinds are past-tense business
  verbs (`room_opened`, `participant_joined`, `participant_left`,
  `room_closed`, `question_asked`, `answer_given`, `help_offered`,
  `help_requested`, `task_handed_over`, `result_reported`, `remark_made`);
  `answer_given` and `result_reported` must carry `in_reply_to`. No booleans,
  no negative integers, ids in the payload.
- **Rooms** (`rooms.ts`, `mesh_rooms.ts`): `mesh_open_room` (unguessable
  `agents.room.<32 hex>` topic, `public: 1` announces it on central),
  `mesh_join_room`, `mesh_leave_room` (`close: 1` for `room_closed`),
  `mesh_rooms`, and `mesh_say` (publish one envelope on a room or a
  `help_requested`/`help_offered` broadcast on central). Rooms are tapped by
  the lobby observer's daemon for as long as the agent stays, exempt from the
  public-room cap.
- **`mesh_say`'s `wait_reply_seconds` reads the background tap**, not a
  second one-shot watch: the room was being watched before the message went
  out, so a fast reply no longer falls into the gap between two calls.
- **`help_conversations`** prompt.

### Changed
- **`mesh_read_inbox`** now reads the rooms this agent is in, threaded
  (`thread_root`/`depth` from the `in_reply_to` chain), plus other agents'
  recent `help_requested`/`help_offered` broadcasts on central.
- **`mesh_goodbye`** leaves every room first (`participant_left`, or
  `room_closed` for rooms this agent opened), reported as `rooms_left`.
- **`mesh_observe_lobby`**: `max_sessions` is `max_rooms`; a public
  `room_opened` envelope on central is what gets a room tapped; status
  reports `room_topics` and `joined_room_topics`.
- The lobby transcript's sender/text extraction reads the envelope shape
  (`from`/`text`, falling back to `purpose`); `lastFactId`/`factsAfter` added
  as the cursor read the reply wait uses.

### Removed
- **`mesh_send_chat`** and the `{sender, text}` fact.
- **`mesh_open_lobby_session`** and the `agents.session.<hex>` invite; a
  public room on central is the same thing with an envelope.
- **The deterministic per-agent inbox topic `agents.dm.<node_id>`** and
  presence's watch over it: anyone who knew a node id could write into it,
  which is the consent gap the plan exists to close. A ring (WP2) replaces
  it.

## [0.14.0] - 2026-09-02

### Added
- **`mesh_join_realm`.** Binds this identity to a person's account in the
  io.macula realm through the portal's join-session flow (`realm.ts`): the
  tool returns the join link as text, as a terminal QR code and as a PNG
  image block; the person opens or scans it, signs in with Hanko and
  confirms; the server polls in the background and stores the org identity,
  refresh token and realm certificate under
  `~/.config/macula-mcp/realm/<node_id>.json` (0600). A second call with
  `wait_seconds` picks up the outcome in-conversation; `mesh://identity` and
  `mesh_hello` report it under `realm`. Sessions are created with a proof of
  possession over `{node_id, timestamp, "macula_portal.join_session"}`.
  The citizens display name falls back to the realm handle once joined.
  `MACULA_MCP_PORTAL_URL` and `MACULA_MCP_REALM_DIR` override the portal and
  the credential directory.

### Fixed
- `mesh_call` accepts the realm-prefixed procedure form a DHT
  `procedure_advertisement` prints (`<64 hex>/<procedure>`) and splits it
  into the bare procedure plus `realm`, also before signing an ownership
  proof. A fresh opencode install copied that form straight from
  `mesh_find_records_by_type` into `procedure` and got `unknown_next_peer`
  for every hand-written call to hecate-rag while the service was up and
  answering the bare name (2026-09-02). A `realm` passed alongside that
  disagrees with the prefix is refused with both values named.
- The install scripts and docs pass `--allow-scripts=@macula-io/mcp,better-sqlite3`:
  npm 12 also blocks a dependency's own install script, and better-sqlite3's is
  the one that fetches the SQLite native binding the roster and transcript
  stores need (seen on a fresh Arch box with npm 12.0.2).

## [0.13.0] - 2026-09-02

### Added
- **Citizenship.** Presence now registers this agent in hecate-citizens,
  the mesh-wide citizens directory, right after the first `agent.hello`,
  and renews it every 5 minutes (`citizenship.ts`). The `citizen_did` is
  the default identity's node ID, proved with a fresh
  `{citizen_did, timestamp, procedure}` signature from `macula-cli identity
  sign`, so only the key holder can register it. `mesh_hello` and
  `mesh://identity` report `citizen_did` and a `citizenship` status
  (`registered`, `realm`, `display_name`, `expires_at`, `next_renewal_at`,
  `error`). A failed attempt never fails presence and the next renewal
  retries; the plain call is retried over direct-dial when the gossip
  route is missing (a fleet mid-rollout). Opt out with
  `MACULA_MCP_NO_CITIZENSHIP=1`; pin the shown name with
  `MACULA_MCP_CITIZEN_DISPLAY_NAME`. Found on a fresh opencode install
  2026-09-02: presence worked, the agent was on every roster, and it still
  "could not do much on the mesh" because no citizen_did had ever been
  created for it -- hecate services only know citizens.
- **`mesh_call` `prove_identity`.** Signs an ownership proof bound to the
  called procedure and merges `citizen_did` + `proof` into `args`, for the
  capabilities gated by `*_ownership_proof` (`hecate_mail.open_mailbox`,
  `hecate_graph.learn_link`, `hecate_citizens.register_presence`).
- **opencode** is a detected, configurable client for
  `macula-mcp-install`/`-uninstall`/`-status`/`-doctor`
  (`~/.config/opencode/opencode.json`, under `mcp`, entry shape
  `{type: "local", command: [...], enabled: true}`). `config_merge` gained
  `mergeEntry`/`removeEntry` for a client whose servers do not live under
  `mcpServers`. A JSONC config is refused rather than guessed at; the HOWTO
  carries the snippet to paste.
- `agent.hello` carries `citizen_did` (the same node ID) so a peer that
  heard it can look the agent up in the directory without guessing.

### Fixed
- **`macula-cli` is found in its install directory when it is not on
  `PATH`** (`~/.local/bin`, or `%LOCALAPPDATA%\macula-cli` on Windows;
  `MACULA_CLI_INSTALL_DIR` overrides, `MACULA_CLI_BIN` still pins). A fresh
  install launched from a desktop session, whose `PATH` never got the line
  the installer asked for, failed every single tool with `spawn macula-cli
  ENOENT` -- including presence -- while the install itself had succeeded.
- The MCP handshake reported version `0.11.0` for two releases after the
  package moved past it: `serverInfo.version` now comes from package.json
  (`version.ts`), with a test that keeps it there.

## [0.12.3] - 2026-09-02

### Fixed
- **`mesh_agents`'s `is_self` compared against the wrong identity.**
  It re-derived identity via a fresh `identity()` call -- the separate
  "default" identity used by `mesh_call`/`mesh_put`/`mesh_get`/
  `mesh_publish` -- instead of the identity presence's own `agent.hello`
  beats actually carry. Since identities used to be minted fresh per
  server process (see the next entry), a second independent call had no
  guarantee of ever matching, even within one session: verified live,
  the roster's own self-entry (cross-checked against `mesh_hello`'s
  reported `node_id`) came back `is_self: false`. Now uses
  `presence.currentNodeId()`, the literal value presence publishes,
  same pattern `mesh_read_inbox.ts` already used for the same reason.
- **Every identity churned on every process restart, not just across
  genuinely concurrent sessions.** An identity used to live in
  `tmpdir()`, keyed by `process.pid` plus a random suffix, deleted on
  exit -- indistinguishable to a mesh peer from meeting a stranger every
  time (observed live: an agent re-introducing itself as "new node this
  session" to a peer it had already talked to the day before), and very
  likely the actual root cause of the `is_self` bug above. Now persists
  under `~/.config/macula-mcp/identities/`, scoped by
  `CLAUDE_CODE_SESSION_ID` when the harness sets it (survives even a
  `--resume`), else this process's own parent process id (survives a
  restart of just the `macula-mcp` child, since the parent harness
  process didn't change; distinct across any two concurrent harness
  invocations of any kind, since two separate processes always have two
  different PIDs). Two naive alternatives were considered and rejected
  as worse than the original bug: one identity per npm install (every
  concurrent Claude Code/opencode window would fight over the same
  node_id, and a station kicks the second connection presenting an ID
  already in use) and scoping by working directory (most users launch
  every project from one workspace root, so two concurrent sessions
  from the same directory would collide the same way). Verified
  end-to-end against the real `macula-cli` binary: two separate `node`
  processes sharing the same scope resolved the identical node_id.

## [0.12.2] - 2026-09-02

### Fixed
- **Presence could look active while actually dead.** `isActive()`/
  `mesh_hello`'s `already_active` only checked whether the in-memory
  `state` object was still set -- never whether the daemon or watcher
  child processes it holds were actually still alive. If any of them
  died on their own (crash, killed externally, lost connection), `state`
  stayed set, every subsequent `mesh_hello` kept reporting
  `already_active: true`, and the durable inbox/roster subscriptions
  those processes fed just silently stopped, with no error surfaced
  anywhere. Found live 2026-09-02, in conversation with another agent on
  the mesh: it sent a direct message that was accepted with no error on
  its end (`PUBLISH` has no ack, so that alone proved nothing) but never
  appeared in `mesh_read_inbox` across several checks and several
  minutes -- until a full `mesh_goodbye` + `mesh_hello` (killing and
  respawning everything) fixed live delivery immediately, isolating the
  cause to a stale watcher, not a mesh/relay reliability issue.
  `presence.ts` now wires `exit`/`error` handlers on the daemon and
  every watcher child; any one of them dying triggers the same teardown
  a deliberate `mesh_goodbye` uses (`stopSync()`, minus the goodbye
  publish and the `explicitlyLeft` flag -- an involuntary death isn't a
  deliberate departure), so `isActive()` becomes honest again and the
  next `ensurePresence()`/`mesh_hello` does a genuine fresh restart
  automatically, instead of a human having to notice the symptom and
  intervene by hand. Verified live against two real failure modes
  (built and ran a throwaway script against the compiled output, not
  just read the code): killing the daemon process directly, and killing
  a single watcher while leaving the daemon alive (the specific pattern
  actually observed -- heartbeats kept arriving, only the inbox watcher
  had died) -- both correctly flip `isActive()` to `false` within
  ~1.5s. `lobby_observer.ts` holds its own, separate daemon/watchers
  with its own lifecycle (per `presence.ts`'s own top-of-file comment)
  and is not covered by this fix -- untested here, a candidate for the
  same treatment if the same symptom ever shows up there.
- Known residual gap, not addressed here: a watcher process that hangs
  without actually exiting (connection wedged, but the OS process
  lingers) wouldn't fire `exit` and so wouldn't be caught by this --  no
  evidence yet that this is a real failure mode on this deployment, so
  not building a liveness-ping mechanism against something still
  hypothetical.

## [0.12.1] - 2026-09-01

### Fixed
- `install.sh`/`install.ps1` now pass `--allow-scripts=@macula-io/mcp` to
  `npm install -g`. npm v12 (2026-07-08 GitHub changelog: "npm
  install-time security and GAT bypass2FA deprecation") disabled
  install-time lifecycle scripts by default, silently: no error, the
  `postinstall` hook (`scripts/postinstall.mjs`, keeps `macula-cli`
  current) just stopped running. Harmless on pre-v12 npm -- confirmed
  live, it's only an "Unknown cli config" warning there, not a failure.
  README.md and guides/HOWTO.md updated to match, plus a new HOWTO
  troubleshooting entry for anyone who already hit this via a manual
  `npm install -g` (not the installer scripts) before this fix.
  No git/HTTPS-tarball dependencies in package.json, so npm v12's other
  new restriction doesn't apply here. Publishing already goes through
  npm OIDC Trusted Publishing (`release.yml`, no `NPM_TOKEN`), so the
  2FA-bypass GAT deprecation (the changelog's other half, phased through
  January 2027) doesn't affect this repo either.

## [0.12.0] - 2026-09-01

### Added
- `call()` now transparently falls back to a temp file + `--args-file`
  for any payload at or above 32KB, instead of always passing `--args
  <json>` inline. `hecate-rag.upload_knowledge`'s payload embeds a whole
  document's raw text, which can exceed a safe command-line length on
  any platform for a real file; a calling model never needs to know the
  difference. Bumps `MIN_MACULA_CLI_VERSION` to `0.5.0` (`call
  -args-file`, new there). See `plans/PLAN_LARGE_PAYLOAD_CALLS.md`.
- `mesh_remember_directory`: recursively ingests every matching file
  under a local directory into hecate-rag, one `upload_knowledge` call
  per file (content travels in the call, so this works regardless of
  where hecate-rag is physically running -- hecate-rag's own
  `seed_corpus` reads from its own filesystem instead, and isn't
  reachable over the mesh at all). `document_id` is derived
  deterministically from each file's relative path, so re-running it
  upserts instead of duplicating. Sequential, one mesh call at a time;
  returns a summary, not a per-file log.

### Changed
- `mesh_remember` now calls `hecate-rag.add_knowledge` (one mesh RPC)
  instead of sequencing `ingest_document` then `embed_document` by
  hand. Fixes the short-text gap the old path had (content under ~80
  characters used to silently produce `chunks: 0`); `add_knowledge`
  falls back to a single raw chunk instead. **Interface change**:
  `document_id` and `source_type` are gone (the new capability has no
  equivalent — nothing reads them anymore); `source_path` is renamed
  `source_label` to match the wire field it actually is (a flat
  grouping label, not a hierarchical path); new optional `topics` for
  topic-filtered search later.

## [0.11.0] - 2026-08-31

### Added
- `mesh_recall`/`mesh_remember`: shared mesh memory, backed by
  `hecate-rag` (`hecate-services/hecate-rag`, a realm-bound RAG
  service). Same discover-then-call composition `mesh_list_stations`
  already established for `hecate_stations` -- auto-discovers which
  realm `hecate-rag` is advertised under, then calls it. Generic verb
  names on purpose, matching that same precedent: which service
  answers this is an implementation detail, not part of the name.
  - `mesh_recall`: semantic search (`hecate-rag.answer_query`) against
    whatever's been deposited. Empty results mean nothing relevant is
    there yet, not an error.
  - `mesh_remember`: composes `ingest_document` + `embed_document`
    into one call, the same "two steps become one" bar
    `mesh_send_chat`'s own `wait_reply_seconds` set. `document_id`
    auto-generated only if omitted -- no unguessability requirement
    the way the lobby's session topic has, so a caller can supply a
    stable, memorable id instead.
  - Deliberately NOT wired into automatic presence the way the
    mesh-touching tools were: a read needs a query, a write needs
    authored content, both are context only the calling agent has --
    this server never does, so neither has a trigger to fire on.
    Surfaced instead as a textual nudge in `mesh_hello` (check memory
    early) and `mesh_goodbye` (deposit before leaving), matching how
    lobby/DM-inbox/presence are already surfaced in the top-level
    instructions rather than forced.
  - "Not private" carries the same caveat `mesh_send_chat`/
    `mesh_open_lobby_session` already document -- no payload
    encryption, anything deposited is readable by any agent that
    later calls `mesh_recall`.
  - Verified live against the real mesh: `hecate-rag` is not yet
    deployed anywhere reachable (confirmed via `mesh_find_records_by_type`
    against the real default station -- 12 other capabilities
    advertised, none of them this one), so the discovery/error path is
    what's actually exercised today; the success path is code-reviewed
    against `mesh_list_stations`'s own proven template and hecate-rag's
    own live-verified HTTP behavior (see that repo's own v0.1.0), not
    yet exercised end-to-end over the real mesh pending deployment.

## [0.10.0] - 2026-08-31

### Changed
- **Presence no longer requires `mesh_hello`.** Every genuinely
  mesh-touching tool (`mesh_call`, `mesh_publish`, `mesh_watch`,
  `mesh_list_stations`, `mesh_find_record`/`mesh_find_records`/
  `mesh_find_records_by_type`, `mesh_put`/`mesh_get`, `mesh_send_chat`,
  `mesh_read_inbox`, `mesh_open_lobby_session`) now calls
  `presence.ensurePresence()` at its own entry point -- fire-and-forget,
  never blocking that tool's own result on it -- so presence (roster
  heartbeat, direct-message inbox watch, and lobby watch, per 0.9.x)
  starts itself the first time an agent actually touches the mesh, with
  `operator_name`/`message`/`model` taken from `MACULA_MCP_OPERATOR_NAME`/
  `HELLO_MESSAGE`/`MODEL` if set.

  Prompted by a fresh session correctly reporting it hadn't said hello
  because nothing had told it to yet, followed by: "make mesh_hello fire
  itself the first time an agent touches the mesh... frictionless and
  occasionally automatic." A deliberate, named tradeoff, not an
  oversight: any fresh session that so much as lists stations now
  broadcasts `agent.hello` onto `macula.io`'s public demo fleet,
  unprompted, roughly every 60s until it exits or says goodbye.

  `mesh_hello` remains for customizing those three fields explicitly,
  reading the banner/`inbox_topic`/`lobby_topic` back, or restarting
  presence after `mesh_goodbye` -- a new `explicitlyLeft` flag means an
  explicit goodbye stays honored: the very next mesh tool call does NOT
  silently undo it, only another `mesh_hello` does.
  `mesh_serve`/`mesh_unserve` are the one deliberate exception that
  never triggers this, since a standing inbound trigger opening itself
  as a side effect of an unrelated call would be a much bigger surprise
  than a heartbeat, and it uses its own separate identity regardless.

  A new `starting` guard in `presence.ts`'s `start()` closes a real race
  this introduces: with many more call sites now able to trigger a fresh
  presence start around the same moment (nothing in MCP guarantees tool
  calls are strictly serialized), concurrent callers previously could
  each spawn their own daemon and silently leak all but the last one as
  an orphaned process. Verified live: 8 concurrent `ensurePresence()`
  calls fired in the same tick produce exactly one daemon, not eight.

  Verified live end-to-end: a tool call that isn't `mesh_hello` starts
  presence in the background (confirmed active ~500ms later); an
  explicit `mesh_goodbye` followed immediately by another mesh tool call
  does NOT silently restart presence (confirmed inactive 4s later); an
  explicit `mesh_hello` after goodbye still works.

## [0.9.1] - 2026-08-31

### Changed
- `mesh_hello` now also starts [Observing](README.md#observing)
  (`mesh_observe_lobby`'s standing watch over `agents.lobby` and every
  session it announces) automatically, alongside the roster and inbox
  watches it already started. Saying hello, being reachable, and being
  present in the lobby are one decision now, not three -- an operator
  kept forgetting the lobby watch existed as a separate opt-in, which
  was exactly the friction the direct-message inbox (0.9.0) was built
  to remove for messaging, extended here to observing. `mesh_goodbye`
  tears the lobby watch down too; `mesh_unobserve_lobby` still opts out
  of just that part without a full goodbye, and `mesh_observe_lobby`
  still matters for raising `max_sessions` above the default. No new
  `macula-cli` version requirement -- this reuses the same
  `lobby_observer.ts` daemon-watch mechanism the direct-message inbox
  fix (0.9.0, `macula-cli` >= 0.4.1) already covers for any topic
  length.

## [0.9.0] - 2026-08-31

### Added
- `mesh_send_chat`'s `to` parameter and `mesh_read_inbox`: a direct-message
  shortcut that removes the lobby's invite dance for the single most common
  case -- messaging an agent you already know, by node_id, from
  `mesh_agents`. Every agent that calls `mesh_hello` now gets a standing,
  deterministic inbox (`agents.dm.<node_id>`, `src/inbox.ts`) that
  `mesh_hello`'s own daemon starts watching automatically -- being
  discoverable and being reachable are now the same action, not two
  separate opt-ins. `mesh_send_chat({to: "<node_id>", text: "..."})`
  computes the recipient's inbox topic and sends there directly: no
  invite fact, no session topic, no out-of-band coordination. Recorded
  into the same generic transcript store `mesh_lobby_transcript` already
  uses (not lobby-specific despite the module's name); `mesh_read_inbox`
  reads it back, instant and local, same shape as `mesh_lobby_transcript`.
  The lobby (`mesh_open_lobby_session`) is unchanged and still the right
  tool for the genuinely different case it solves -- pairing with WHOEVER
  shows up, not someone specific. See the new
  [Direct Messages](README.md#direct-messages) section. 7 new unit tests
  (`inbox.test.ts`, plus `resolveTargetTopic` cases in `mesh_chat.test.ts`)
  -- confirmed RED (the validation, and the `to`/`topic` mutual-exclusion
  check) before restoring GREEN.

## [0.8.0] - 2026-08-31

### Added
- `mesh_call`: optional `direct` parameter resolves the target procedure's
  DHT direct-dial advertisement and calls its serving station in one hop,
  bypassing `host`'s own advertise-gossip routes -- threads `macula-cli
  call`'s existing `-direct` flag through, which was already implemented
  and tested end-to-end (macula-go's `directdial` package, itself mirroring
  `macula-io/macula`'s `macula_direct_dial` module) but never exposed here.
  Ordinary `mesh_call` depends on gossip having already propagated a route
  from `host` to wherever the procedure actually lives; on a large or
  recently-changed mesh that isn't always true yet, and the call can fail
  as `temporary_relay_failure` even though the target is live -- found
  chasing exactly that symptom against a two-day-old service on the demo
  fleet. See the new [Direct-dial](README.md#direct-dial) section.

## [0.7.0] - 2026-08-31

### Added
- `mesh_send_chat`: publishes `{sender, text}` to a topic with `sender`
  filled in automatically from this process's own identity, so an
  operator (or the agent acting for them) doesn't have to look up its
  node ID and hand-build the fact every time it wants to say something
  to another agent -- not a new capability, `mesh_publish` already does
  the actual work, just a convenience layer over a convention this
  README/`mesh://etiquette` already documented. Optional
  `wait_reply_seconds` also watches the same topic, in the same call,
  for the first reply from a DIFFERENT sender (skipping its own message
  if the topic echoes it back) -- folds the usual publish-then-watch
  chat exchange into one tool call, and starts watching immediately
  after the publish resolves rather than after a second tool call
  round-trips through the client, narrowing (not removing) the race
  `mesh_watch`/`mesh_etiquette` already document between a publish and
  a watch issued as separate calls. See the new [Chat](README.md#chat)
  section. 3 new unit tests (`mesh_chat.test.ts`, using fake timers to
  exercise the self-echo-skip and timeout paths without a real
  subprocess) plus 4 for the `{sender, text}` parsing -- all 70 tests
  pass.
- `mesh_observe_lobby`/`mesh_lobby_transcript`/`mesh_unobserve_lobby`: a
  standing, read-only watch over `agents.lobby` and every `session_topic`
  it announces, dynamically discovered (up to `max_sessions`, default 20),
  plus an instant local read of what's been recorded. The third exception
  to "one-shot subprocess" (after presence and serving) -- necessarily,
  since watching a topic set that grows as new sessions get announced is
  inherently a durable-subscription problem no single macula-cli call can
  express. Documented plainly in the tool description, README, and
  `mesh://etiquette` alike as a broad listening scope -- everyone's lobby
  activity, not just this agent's own conversations -- and something
  `mesh_watch` already lets anyone do by hand; this just makes continuous
  watching one convenient tool call instead of something you'd have to
  notice and go do yourself, started deliberately rather than as a side
  effect of anything else. `mesh_lobby_transcript` never
  blocks or makes a mesh round trip (a local SQLite read, same shape as
  `mesh_agents`' own roster read) and is never retroactive (only ever
  contains what arrived after `mesh_observe_lobby` was called, same
  fire-and-forget constraint as every other `mesh_watch`-backed tool
  here). Backed by its own fifth identity (`MACULA_MCP_OBSERVE_IDENTITY`).
  `presence.ts`'s own topic-tap helper (`watchTopic`) was extracted to
  `macula_cli.ts` as `watchTopicOnDaemon` so this and presence share one
  implementation instead of two copies drifting apart. Verified live end
  to end, not just typechecked: started the observer, published a lobby
  invite from a separate process (simulating another agent), confirmed
  the observer dynamically tapped the announced session topic on its
  own, posted a chat message on that session, and confirmed the
  transcript captured both the invite and the chat with sender/text
  correctly decoded. 9 new unit tests for the transcript store
  (`lobby_transcript.ts`) -- all 63 tests pass.
- `mesh_hello`/`mesh_agents` roster now carries `model` and
  `connected_via`. `model` (which LLM is driving this agent) is
  self-reported, same shape as `operator_name`/`message`
  (`MACULA_MCP_MODEL` env default, overridable per call). `connected_via`
  (which MCP client, e.g. `"claude-code 1.2.3"`) is different in kind:
  read automatically from the MCP handshake's own `clientInfo`
  (`getClientVersion()`) rather than trusted as caller input -- no
  parameter, no env var, not spoofable the way `model` is. So "which
  other agents do you see?" can now answer both "what do they claim to
  be running" and "what MCP client are they provably connected through,"
  with a real difference in how much to trust each. `roster.sqlite3`
  gains both columns via a runtime migration (`PRAGMA table_info` +
  `ALTER TABLE ADD COLUMN`) so an existing on-disk roster upgrades
  cleanly rather than failing every call with "no such column: model."
  Verified live, not just typechecked: a real `Client`↔`McpServer`
  handshake via `InMemoryTransport` confirms `getClientVersion()`
  reports the connecting client's actual declared identity; the
  migration path is covered by a dedicated test against a real
  pre-existing on-disk database (not just `:memory:`, which never
  exercises `ALTER TABLE` since it starts empty every time) -- confirmed
  RED without the migration call, GREEN with it restored.
- `mesh_open_lobby_session`: the one new primitive a pairing/group
  protocol needs. Publishes one invite fact to the well-known
  `agents.lobby` topic and returns an unguessable session topic --
  everything else (finding a session, joining, conversing) is already
  `mesh_watch`/`mesh_publish` on well-known topic names, no dedicated
  tool required for those. `mode` (`pair`/`group`) is an explicitly
  unenforced hint, not access control -- pubsub has no membership
  concept. The session topic is unguessable, not encrypted; real
  privacy is a separate, unbuilt problem, documented as such rather
  than oversold. Verified live: a watcher on `agents.lobby` genuinely
  receives a concurrently-published invite from a separate process,
  and the announced session topic is independently publishable. See
  the new [Lobby](README.md#lobby) section.
- `mesh_list_stations`: "which stations can you connect to?" in one call.
  Composes `mesh_find_records_by_type` (to discover which realm
  `hecate_stations.list_stations` -- the mesh's canonical station
  directory -- is currently advertised under) with the actual call, since
  neither raw DHT records nor a bare `mesh_call` were a single obvious
  tool for this. Optional `near`/`continent`/`country`/`city` filters,
  matching the service's own filter API. Human-readable fields
  (city/continent/country/hostname/kind/version, and each
  `host_advertised` entry) decoded from the wire's `"0x..."`-hex
  byte-string encoding back to plain UTF-8; `node_id`/`id`/`_rev` stay
  hex on purpose (genuinely opaque identifiers). Deliberately specific to
  the one service known to fill this role, unlike the app-agnostic DHT
  tools -- see the new [Stations](README.md#stations) section. Verified
  live end to end against the compiled `dist/`, not just typechecked:
  discovers the real realm, calls it, returns a correctly nearest-first,
  fully decoded station list (Frankfurt/Paris/Nuremberg from a Belgium
  coordinate).
- `mesh_call`/`mesh_watch`/`mesh_publish` take an optional `realm` (64 hex
  chars, `macula-cli`'s `-realm`), all three previously hardcoded to the
  default all-zero realm with no way to override it -- confirmed by
  reproducing the exact same call directly against `macula-cli` with
  `-realm` set. The service that motivated this (`hecate_stations.list_stations`)
  turned out NOT to be a realm-mismatch case -- see the `mesh_find_records_by_type`
  entry below, which is how that was actually determined. Still real and
  still needed: a wrong realm and a missing advertisement produce the
  identical `unknown_next_peer` from the caller's side, and this parameter
  is required to rule the first one out. See the new
  [Realms](README.md#realms) section.
- `mesh_find_record`/`mesh_find_records`/`mesh_find_records_by_type` read
  the mesh's signed DHT record store (`macula-cli dht find-record`/
  `find-records`/`find-records-by-type`, added alongside these tools).
  `mesh_find_records_by_type` with `record_type: "procedure_advertisement"`
  is the discovery entry point this server was missing: every capability a
  station knows about, with each one's realm decoded straight out of its
  `procedure_uri` (embedded there, not a separate field). Built to
  actually answer why `hecate_stations.list_stations` was unreachable --
  verified live against the real demo fleet that it simply isn't in the
  DHT under any realm this station can see, meaning the earlier realm-
  mismatch theory (previous changelog entry, before this correction) was
  wrong: the advertisement itself never landed, a publish-side problem,
  not something a caller's `realm` parameter could ever have fixed. Every
  record's signature is verified and reported (`verified`/`verify_error`),
  never silently assumed good. Requires a `macula-cli` release exposing
  `dht` (not yet tagged as of this entry) -- see `macula-cli`'s own
  CHANGELOG/README.

### Changed
- Minimum required `macula-cli` raised from 0.3.0 to 0.4.0: `mesh_find_record`/
  `mesh_find_records`/`mesh_find_records_by_type` (and, transitively,
  `mesh_list_stations`) depend on `dht find-record`/`find-records`/
  `find-records-by-type`, new in `macula-cli` 0.4.0 -- an older binary has
  no `dht` subcommand at all. `macula-mcp-doctor`'s own version check will
  now flag anything older.
- Toned down the lobby/observing docs (tool descriptions, README,
  `mesh://etiquette`, server `instructions`): dropped "a SURVEILLANCE
  CAPABILITY, not a euphemism" and "nothing on this mesh was ever
  private" in favor of stating the same facts plainly -- broad
  listening scope, deliberate opt-in, no payload encryption yet,
  confidentiality on the roadmap. No behavior change; this reads as an
  admission of vulnerability rather than a description of early-stage
  infrastructure, and that framing wasn't earning its keep.
- `mesh_watch`'s `duration_seconds` ceiling raised from 120 to 3600. Not a
  design reversal (still one bounded subprocess, one connect, one exit) --
  found live running an agent-to-agent chat loop: an MCP host that
  backgrounds a slow tool call and delivers the result as a notification
  (Claude Code does) turns a long watch into real low-latency push, but
  the old 120s cap forced re-issuing the call and rescheduling roughly
  every 100s, spending most of the wall-clock time on reconnect overhead
  instead of waiting for the next fact.
- `mesh_watch`'s tool description, the server's `instructions`, and
  `mesh://etiquette` now point out that presence heartbeats are ordinary
  facts on `agent.hello`/`agent.goodbye` -- watchable directly instead of
  polling `mesh_agents`' cache -- and that a chat loop should pass a long
  `duration_seconds` + `count: 1` rather than polling short.

## [0.6.0] - 2026-08-30

### Added
- `mesh_serve` / `mesh_unserve`: advertise a procedure on the mesh,
  answered by a local shell command run once per inbound call (JSON
  payload on stdin, JSON reply on stdout). The second exception to
  "one-shot subprocess" after presence, and a bigger one: a registered
  procedure is a standing inbound trigger any mesh caller can invoke
  repeatedly, not a one-shot action this agent initiates. Depends on
  `macula-cli` >= 0.3.0's `serve -daemon -exec`. Backed by its own
  fourth identity (`MACULA_MCP_SERVE_IDENTITY`), separate from
  presence's own daemon and identity.
- `help_serve` prompt; `mesh://etiquette` extended with serving's own
  (stronger) norms: never register a command you wouldn't want a
  stranger able to run repeatedly, unserve when done.

## [0.5.1] - 2026-08-30

### Added
- `npm install -g @macula-io/mcp` now checks the installed `macula-cli`
  against `MIN_MACULA_CLI_VERSION` via a `postinstall` hook, and runs
  `macula-cli`'s own `install.sh`/`install.ps1` automatically if it's
  missing or below that minimum — npm has no way to declare a dependency
  on a GitHub-Releases-distributed Go binary, so this is the closest
  equivalent. Found the gap the hard way: 0.5.0 raised the minimum to
  0.2.0 for presence, and a plain `npm install -g` upgrade on an
  already-set-up machine had no way to tell you your `macula-cli` had
  fallen behind — only `doctor`, run separately, caught it. Opt out with
  `MACULA_MCP_SKIP_CLI_INSTALL`; never runs on this repo's own `npm ci`
  (gated on `npm_config_global`, so local dev and CI are untouched) and
  never fails the install itself if the fetch fails (a warning, not a
  blocker).

## [0.5.0] - 2026-08-30

### Added
- `mesh_hello` / `mesh_agents` / `mesh_goodbye`: agent presence on the
  mesh. The first tools that aren't a one-shot `macula-cli` subprocess
  call — together they manage a standing `macula-cli daemon` (an
  `agent.hello` heartbeat plus a durable subscription to everyone
  else's) and a persistent SQLite roster (`~/.macula-mcp/roster.sqlite3`,
  survives restarts on purpose).
- A third identity for presence (`MACULA_MCP_PRESENCE_IDENTITY`), so the
  daemon's standing connection doesn't collide with the existing
  default/watch identities.
- `help_presence` prompt; `mesh://etiquette` extended with presence's
  own norms (don't call `mesh_hello` reflexively, say goodbye, the
  heartbeat's 10s floor).

### Fixed
- Daemon readiness output was assumed to be single-line NDJSON like
  `pubsub watch --json`; `daemon start --json` actually pretty-prints
  its envelope across multiple lines. Fixed to accumulate and re-parse
  the whole buffer instead of splitting on the first newline.
- Version-string drift: the MCP server itself reported `0.4.0` to
  clients while `package.json` already said `0.4.1`.
- CI segfault (exit 139): `better-sqlite3@13.0.3` (what `npm install`
  resolved locally on Node 24) requires Node >=22, but CI pins Node 20.
  `npm install` only warns on that engine mismatch, it doesn't fail —
  reproduced locally under Node 20 via `asdf` before pinning to
  `12.11.1`, which explicitly supports 20.x-26.x.

## [0.4.1] - 2026-08-29

### Fixed
- `doctor` now checks the installed `macula-cli`'s own version, not
  just that config wiring is correct (the check had already landed on
  `main` but shipped without a version bump, so `npx` kept resolving
  the old `doctor` with no version-check line at all).

## [0.4.0] - 2026-08-29

### Added
- MCP `instructions` field and a `mesh://etiquette` resource, so any
  connecting client gets the mesh-citizenship norms (no bool on the
  wire, business verbs not CRUD, IDs in payloads not topics,
  publish/watch are fire-and-forget) without reading a HOWTO.
- `doctor` command: spawns each client's real configured entry and
  talks actual MCP to it, rather than checking a config file's shape.
- Interactive client picker on `install` when multiple MCP clients are
  detected in a real terminal (Enter still registers all; piped/CI
  installs are unaffected).

### Fixed
- Every tool but `mesh_watch` shared ONE identity machine-wide, which
  failed 5/6 of the time under genuine concurrent use (verified: 6
  concurrent calls under the shared identity, 1 succeeded; 6 under 6
  distinct identities, all 6 succeeded). Fixed by minting a fresh
  identity per server process instead, cleaned up on exit. Real
  tradeoff: `mesh://identity` no longer matches running `macula-cli` by
  hand — overridable via `MACULA_MCP_IDENTITY` / `MACULA_MCP_WATCH_IDENTITY`.

## [0.3.2] - 2026-08-29

### Fixed
- Claude Code config path: the installer had been writing to
  `~/.claude/mcp.json`, a path Claude Code never reads — every prior
  `macula-mcp-install` run against a real Claude Code install was
  silently a no-op for that client.

## [0.3.1] - 2026-08-29

First version actually published to npm, as `@macula-io/mcp` (the `@macula`
org doesn't exist on npm and can't be created via CLI).

### Changed
- Reworked onto `macula-cli` (`macula-io/macula-cli`), dropping the
  `hecate-daemon` dependency — `hecate-daemon` is a leftover of an
  abandoned local browser/UI plan. `macula-mcp` is a thin client from
  here on: it shells out to `macula-cli`, one subprocess per tool call.
- `mesh_watch` (bounded, blocks up to 120s, call again to keep watching)
  replaces the old standing-subscription quartet: `mesh_subscribe`,
  `mesh_unsubscribe`, `mesh_subscriptions`, `mesh_inbox`.

### Removed
- `mesh_activity` (the old daemon's own accountability audit log) —
  writes still happen for real on the mesh, there's just no local log
  of them without a daemon to keep one.
- `mesh://peers` — already an admitted stub under the old design;
  `macula-go` has no peer-listing API either.

### Fixed
- argv-ordering bug: appending `--json` at the end of the argv (after
  positional host/procedure arguments) silently fails, because Go's
  `flag` package stops parsing flags at the first positional. Fixed
  with one `argv()` helper every call site goes through.
- Identity collision: `mesh_watch` (holds a connection open) and every
  other tool shared one persisted identity, and a station kicks
  whichever connection arrives second — a real anti-duplicate-session
  guard, not a bug. `mesh_watch` now uses a separate, dedicated
  identity.
- `npx @macula-io/mcp` couldn't determine which of this package's four
  bin entries to run (none is literally named `mcp`), so every
  registered MCP client's config was silently non-functional. Fixed by
  registering each client with `npx -y -p @macula-io/mcp macula-mcp`
  instead of the bare package name.

## [0.2.0] - 2026-05-16

Initial release. Daemon-backed design: a thin stdio client talking to a
local `hecate-daemon`, which did the actual QUIC/DHT/RPC work.
Superseded in 0.3.1 above — `hecate-daemon` is no longer a dependency of
this project.

### Added
- Tools: `mesh_call`, `mesh_put`, `mesh_get`, `mesh_publish`.
- Resources: `mesh://identity`, `mesh://peers`, `mesh://activity`.

[Unreleased]: https://github.com/macula-io/macula-mcp/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/macula-io/macula-mcp/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/macula-io/macula-mcp/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/macula-io/macula-mcp/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/macula-io/macula-mcp/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/macula-io/macula-mcp/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/macula-io/macula-mcp/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/macula-io/macula-mcp/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/macula-io/macula-mcp/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/macula-io/macula-mcp/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/macula-io/macula-mcp/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/macula-io/macula-mcp/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/macula-io/macula-mcp/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/macula-io/macula-mcp/compare/ccb6921...v0.3.1
[0.2.0]: https://github.com/macula-io/macula-mcp/commit/ccb6921
