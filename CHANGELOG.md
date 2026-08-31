# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions match
the git tags this repo actually publishes from (`.github/workflows/release.yml`
fires on a `v*` tag push, not on every commit to `main`).

## [Unreleased]

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

[Unreleased]: https://github.com/macula-io/macula-mcp/compare/v0.8.0...HEAD
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
