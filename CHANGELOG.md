# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions match
the git tags this repo actually publishes from (`.github/workflows/release.yml`
fires on a `v*` tag push, not on every commit to `main`).

## [Unreleased]

### Fixed
- `mesh_join_realm` was 404ing in production. The join-session route moved from macula.io to
  realm.macula.io (its own app/domain since the 2026-08-30 macula-realm/macula-portal split) and
  this client's defaults were never updated to follow: `realm.ts`'s `DEFAULT_PORTAL_URL` still pointed
  at `https://macula.io`, and its `JOIN_PROOF_PROCEDURE` still signed proofs over
  `"macula_portal.join_session"` rather than macula-realm's own `"macula_realm.join_session"` (verified
  against that app's `join_session_controller.ex`/`joining.ex` directly) -- fixing only the URL would
  still have failed signature verification. `MACULA_MCP_PORTAL_URL` is replaced by
  `MACULA_MCP_REALM_URL` (a new variable, not a repurposed one: portal and realm are genuinely separate
  services now, and silently changing what an existing variable affects would break anyone already
  relying on its old meaning). `realm.test.ts`'s coverage of this was previously a false negative --
  every test overrode the URL via env var and so never actually exercised the real default -- now
  asserts the real target and procedure string directly, not just the URL-building logic around them.

## [0.22.0] - 2026-09-05

### Changed
- Dependency refresh. Real version moves: `zod` 3.25.76 → 4.5.4, `typescript` 5.9.3 → 6.0.3, `vitest`
  3.2.7 → 5.0.0 (all major-version jumps, each verified against this repo's actual behavior, not just
  taken on trust from a changelog — see below). `@modelcontextprotocol/sdk`, `@types/node` and
  `typescript`'s own floor were also widened in `package.json` (`^1.0.0`→`^1.30.0`, `^24.0.0`→`^24.13.3`),
  but the lockfile had already resolved those exact versions before this change under the old ranges, so
  there's no real code delta there — just documenting where the range floor actually sits.
- `z.record(z.unknown())` → `z.record(z.string(), z.unknown())` in `mesh_call`'s `args` and
  `mesh_publish`'s `fact` — zod 4 requires an explicit key schema; the one-argument shorthand no longer
  type-checks. Runtime behavior verified identical for every JSON-reachable input.
- Added explicit `"types": ["node"]` to `tsconfig.json`. TypeScript 6 defaults an unset `types` array to
  empty; this repo's Node ambient types (`process`, `Buffer`, etc.) were only reaching the program by
  accident, via a `/// <reference types="node" />` inside `@types/qrcode`'s own `.d.ts`. Dropping or
  swapping `qrcode` would have silently broken every `node:`-API type check.
- **Client-visible:** the JSON Schema this server advertises for its 26 argument-taking tools changed
  shape (not meaning) as a side effect of `@modelcontextprotocol/sdk` 1.30's zod-4-native JSON Schema
  conversion: `additionalProperties: false` no longer appears at the schema level (the server still
  rejects unknown keys at runtime — this is a description-only change for any client that renders the
  raw schema), integer fields now advertise an explicit `maximum` (`Number.MAX_SAFE_INTEGER`), and
  `mesh_call`'s `args` / `mesh_publish`'s `fact` gained an explicit `propertyNames: {type: "string"}`.
  No description, default, enum, or required field was lost.
- zod 4's `.int()` now rejects values outside the safe-integer range at parse time (zod 3 accepted them
  silently); affects every `.number().int()` argument (`timeout_ms`, `page`, `interval_seconds`,
  `near.limit`, `max_rooms`, `exec_timeout_seconds`, `count`) — a caller passing an unsafe integer now
  gets a clean validation error instead of an unsafe value reaching the mesh.
- `@macula-io/ts` 0.14.0 → 0.14.1, carrying real fixes this server inherits directly: a malformed
  `realm` argument on `Pool.publish()`/`Pool.call()` was being misclassified as a dead control link,
  live-verified taking a pool from every healthy link to zero over one caller-side validation error; plus
  a stale-`unsubscribe()` use-after-reuse bug and an identity-dispose race. Also bumps `macula-go` to
  v0.6.2, fixing a `Session.Close` GOODBYE send with no write deadline (a withholding peer could block it
  forever) and, pre-auth: a malformed CBOR frame's entry count was used unbounded as a slice/map capacity
  hint (a 9-byte frame claiming 2^64-1 entries panics the process before any signature check runs), plus
  an O(n²) CBOR map-key-dedup decode cost.

## [0.21.0] - 2026-09-05

### Added
- **Outbound secret/credential scanning**, hard-blocked with no override flag, wired into every tool that
  sends content over the mesh (`mesh_publish`, `mesh_call`, `mesh_say`/`mesh_open_room`, `mesh_ring`,
  `mesh_answer_ring`, `mesh_hello`, `mesh_put`, `mesh_remember`/`mesh_remember_directory`, and `mesh_serve`'s
  `-exec` reply path). Pattern-matches known secret shapes (AWS keys, PEM private-key blocks, GitHub/Slack/
  Stripe/OpenAI/Anthropic key prefixes, `Authorization: Bearer` headers, `.env`-style lines) rather than
  entropy heuristics, since this server's own normal traffic (node ids, MCIDs, UCANs) is full of long hex/
  base64 strings that would false-positive constantly under an entropy-based check. `mesh_remember_directory`
  also excludes known credential-file names (`.env`, `.pem`, `.key`, `id_rsa`, `.ssh`, `.aws`, `.npmrc`,
  `credentials.json`) before a file is even opened. Object-key names are scanned too, not just values, and a
  real `cert_pem`/UCAN are in the test suite as required clean passes so legitimate mesh traffic doesn't trip
  it.
- **`claim_confirmed`/`claim_disputed` envelope kinds**, plus `claim_verification.ts`'s pure derivation logic
  (`unconfirmed` → `corroborated` → `verified`) for checking a peer's "done" against what's actually in a
  room's thread instead of trusting it on say-so. A token-less claim is deliberately *harder* to confirm than
  an evidence-rich one, and a confirmer's realm-membership tier now counts categorically: only a citizen-tier
  (Hanko-bound) confirmation can reach `verified` — any number of free device-tier confirmations never
  substitutes for one, since device-tier identities cost nothing to mint. No tool wired to this yet (same
  scope as `lane_claimed`/`lane_released`'s own initial shipment) — wire protocol + tested logic first.

### Changed
- **`call()`/`publish()`/`watch()` now route through `@macula-io/ts` 0.14.0's connection `Pool`** instead of
  a fresh one-shot connection per call, holding 3 simultaneous seed-station connections (`mesh_config.ts`'s
  `DEFAULT_STATIONS`) instead of only ever having one live connection at a time. Live-verified against the
  real fleet: forcing a real per-identity kick on one of the pool's 3 links left `call()`/`publish()` still
  succeeding via the other 2 immediately afterward, self-healing within the health-check window; warm-pool
  calls averaged 53ms vs. 286ms for a cold connect. Partial by design, not wholesale: an explicit `host`
  override, `direct`/`ucanPath` calls, `callThenDirect()`'s direct-dial fallback leg, and every DHT/content
  function stay on the original one-shot path, since Pool has no equivalent for targeting a single station or
  for those call shapes. `watch()` loses the one-shot path's "give up early if the connection dies" behavior
  when pool-routed — Pool hides a dropped link behind its own reconnect instead of surfacing it, so a
  pool-routed `watch()` now always waits out its full duration/count.

### Fixed
- A room tap (`lobbyObserver.tapRoom()`) was fire-and-forget, so `openRoom()`/`joinRoom()`/`ensureTapped()`
  could publish a fact into a room before the tap's own connect+subscribe had actually finished. `tapRoom()`
  now awaits its first connect attempt settling before resolving. Does not fix a separate, deeper issue found
  in the same investigation — a room tap not observing a different party's fact after joining — reported
  separately, not bundled in as fixed here.

## [0.20.0] - 2026-09-04

### Fixed
- Every one-shot mesh call (`mesh_call`, `mesh_publish`, `mesh_watch`, etc.) awaited its own `Session.close()`
  before returning — including `@macula-io/ts`'s own ~250ms connection-teardown drain — paid on the hot path
  of every single tool call for zero benefit the caller could observe (the result is already final before
  teardown starts). `withSession`'s close/dispose now happen in the background instead. Found via an
  adversarial review of the connect-per-call architecture; verified live before shipping that backgrounding
  the close doesn't open a new race against an immediate next call under the same identity (it doesn't — a
  graceful close in flight is not the same connection state as the orphaned one that trips the station's
  per-identity dedupe, confirmed separately, live, as a real but different bug tracked for the eventual
  session-pooling work this one is a precondition for, not a fix for).
- `issue_membership_ucan`'s procedure string was mistraced (missing its embedded realm-name segment), and its
  `citizen_did`/`ucan` reply fields needed one more unwrap than expected (macula-realm sends them as raw
  binaries that are already text, so `@macula-io/ts` — unable to safely assume an untagged binary is UTF-8 —
  represents them as `0x`-prefixed hex, doubly so for a value that's already hex/text). Both fixed; the
  realm-membership auto-join below is live-verified end to end against `io.macula`, not just unit-tested.

### Added
- **Device-tier realm auto-join**: on connect, silently proves this identity holds its own keypair
  (`DeviceKeyOwnershipProof`, no human involved) and mints a device-scoped realm membership UCAN — the lighter
  of two membership tiers (the heavier one is the existing Hanko-bound `mesh_join_realm` human flow, unchanged
  and unaffected). Opt-in only via `MACULA_MCP_AUTOJOIN_REALM` (unset = no-op); `RealmCredential`/`RealmStatus`
  gained a `tier: "device" | "citizen"` field to tell the two apart.
- `lane_claimed`/`lane_released` envelope kinds, so a room can show who's actively working a piece of handed-
  off work and when they're done, without a separate presence-level status field that could drift out of sync
  with the room's own facts (see `envelope.ts`'s `REPLY_REQUIRED_KINDS` doc for how `lane_released` closes a
  specific `lane_claimed`).

## [0.19.0] - 2026-09-04

### Fixed
- **`mesh_serve` could only ever serve ONE procedure per process, and `presence`'s own ring endpoint silently
  claimed that one slot.** `serve.ts` held every registration on a single shared `@macula-io/ts` `Session`,
  but a `Session` only ever serves one procedure at a time (its own stated contract) — since `presence.ts`
  registers this agent's `agent.<node_id>.ring` endpoint (`ring_service.ts`) the moment presence starts, and
  presence starts on nearly every mesh tool call, any real `mesh_serve` call after that failed with an
  internal "Session is already serving" error the caller couldn't act on (the reverse order broke the ring
  registration instead, silently). Fixed by giving every registration — the ring endpoint included — its
  OWN persistent `Session` and its OWN identity (`mesh_config.ts`'s new `serveProcedureIdentityPath()`,
  hashed per procedure). The shared direct-dial advertisement leg (`putProcedureAdvertisement`) stays
  shared across registrations, deliberately — it never calls `Session.serve()`, so it was never part of the
  bug. Live-verified: presence's ring endpoint plus two independently-registered `mesh_serve` procedures now
  all serve concurrently and answer real calls; unserving one leaves the others untouched.
- **`mesh_call`'s `direct: true` unconditionally threw**, even after `@macula-io/ts` gained real direct-dial
  support earlier this same day — the flag was simply never wired to it. `macula_ts_client.ts`'s `call()`
  now routes `direct: true` through `Session.callDirect`/`callDirectWithUcan` (the same primitives
  `callThenDirect()` already used successfully for its own automatic fallback), instead of refusing outright.
  Live-verified against the real fleet, including with `MACULA_MCP_UCAN` attached via `callDirectWithUcan`
  using a deliberately mismatched token audience (the bearer-token property holds through the direct path
  too).
- **The server never exited when its MCP client disconnected** — a dropped pipe, a crashed harness, or a
  killed parent process all left it running forever, still heartbeating `agent.hello` under a persistent
  identity and holding every QUIC connection open, since an active `subscribe()` deliberately keeps Node's
  event loop alive. Root cause, found the hard way: the installed MCP SDK's `StdioServerTransport` never
  detects its own stdin closing — it only ever listens for `data`/`error`, so nothing calls `.close()` (and
  `Server#onclose` never fires) on a real client disconnect. Fixed by listening for `process.stdin`'s own
  `end`/`close` events directly and running the same graceful async teardown a deliberate `mesh_goodbye`
  already does (publish a real goodbye, stop ring service/lobby observer/presence, stop any served
  procedures), bounded by a 10s timeout so a stuck network call can't keep the process alive either.
  `Server#onclose` is still wired too, belt-and-suspenders, for whatever code path does call `.close()`
  explicitly. Live-verified: a spawned server, driven through a real MCP handshake, with its stdio closed —
  now publishes a real `agent.goodbye` (received by an independent watcher session) and exits with code 0 on
  its own, no external kill needed.
- Two resource leaks in `presence.ts`'s/`lobby_observer.ts`'s reconnect logic, found by the same review:
  a reconnected leg's previous (dead) `Session` was never `close()`d, just overwritten (one leaked Go-side
  handle per reconnect cycle); and `stopLeg()` could dispose a leg's identity while a reconnect was still
  mid-flight, so that fresh connection's own eventual `close()` threw into a swallowed catch and was left
  open until the station idled it out. Both fixed: the old session is now closed before being replaced, and
  `stopLeg()` awaits any in-flight connect/reconnect attempt before touching the identity.
- Doc/version leftovers: `mesh_call`'s `direct` description no longer claims it's unsupported; the UCAN
  provisioning error message no longer tells the user to run a `macula-cli` command that no longer exists in
  this project; `macula-mcp-doctor`/`-install`/`-uninstall`/`-status` no longer report a hardcoded, long-stale
  `0.4.0` — they read the real package version now (`version.ts`'s `serverVersion()`), the same fix `index.ts`
  itself already got for the identical bug.

### Changed
- **`@macula-io/ts` is now a real npm dependency (`^0.13.5`), not a vendored tarball.** Now that it's actually
  published, `vendor/macula-io-ts-0.12.0.tgz` and the whole vendoring stopgap it needed are gone. Note the
  version floor: `0.13.0` through `0.13.4` all shipped a stray native-compile install script on the registry
  (found and root-caused during this same work, fixed upstream in `0.13.5`) — `^0.13.5` deliberately excludes
  all of them, don't loosen this range without checking that history first. Verified end to end against the
  real published package: a fresh `npm install` shows zero compile/gyp signals, and a real `mesh_serve` →
  `mesh_call` round trip against the production fleet succeeds through it.

## [0.18.0] - 2026-09-04

> Never tagged or published to npm as its own release — work continued the same day straight through
> to 0.19.0, which is what actually shipped. Kept here as an accurate record of what was built and when;
> don't look for a `v0.18.0` git tag or npm version, there isn't one.

### Changed
- **Cut over to [`@macula-io/ts`](https://github.com/macula-io/macula-ts) for most mesh operations**,
  replacing the `macula-cli` subprocess: `mesh_call`, `mesh_publish`, `mesh_watch`,
  `mesh_find_record`/`mesh_find_records`/`mesh_find_records_by_type`, `mesh_put`/`mesh_get`, and
  `mesh_serve`/`mesh_unserve` now talk QUIC/DHT/RPC directly in-process. `mesh_serve`/`mesh_unserve` is the
  biggest structural change: a single persistent `Session` this process holds in memory for as long as
  anything is registered, replacing the `macula-cli serve -daemon` subprocess, its control socket, and its
  NDJSON IPC protocol entirely — that machinery existed only to let separate one-shot CLI invocations share
  one connection, which stops mattering once the SDK is called in-process. The `-exec` behavior (a served
  procedure answered by a local shell command, JSON on stdin/stdout, per-call timeout) is reimplemented in
  `serve.ts` directly, since there's no daemon subprocess left to own it.
- New `src/macula_ts_client.ts`: the thin adapter layer between the cut-over `mesh_*.ts` tool files and
  `@macula-io/ts`'s `Session`/`Identity`. Connects fresh per one-shot call (mirroring `macula-cli`'s own
  one-shot subprocess model) rather than holding a shared session for these — a deliberate, simpler,
  easier-to-reason-about choice over a connection pool, left as a real future optimization if the extra
  per-call handshake latency turns out to matter.
- Added `@macula-io/ts` as a dependency — **vendored as a packed tarball** at `vendor/macula-io-ts-0.9.0.tgz`,
  not a git or npm registry dependency, and this is deliberate, not an oversight: `@macula-io/ts`'s own
  zero-install-script packaging (no `binding.gyp`/`addon`/`cabi` at install time, only a prebuilt native
  addon) only holds when installed from a packed tarball. Both a `git:` dependency and a local-directory
  `file:` dependency were tried first and both silently bypass `package.json`'s `"files"` filtering, so npm
  sees `binding.gyp` in the raw checkout and runs `node-gyp rebuild` anyway — reintroducing the exact
  native-compile-at-install problem `@macula-io/ts` exists to avoid. Confirmed live: a git dependency failed
  outright in a clean environment with no Go/C++ toolchain; the vendored tarball installs with zero compile
  signals. This is a real, honest stopgap pending a real npm publish of `@macula-io/ts` (a separate decision,
  not made here) — the vendored `.tgz` should be replaced with a real registry dependency once that happens,
  not left as a permanent pattern.
- Identity/seed continuity preserved exactly: the cut-over tools reuse `macula_cli.ts`'s existing
  `defaultIdentityPath()`/`watchIdentityPath()`/`serveIdentityPath()` seed-file conventions
  (`~/.config/macula-mcp/identities/<kind>-<scopeKey>.seed`) via a new `loadOrGenerateIdentity()` helper —
  same load-or-generate policy, same per-kind identity separation, same node IDs a deployment already
  depends on.
- **`presence.ts`'s `macula-cli daemon` replaced by two persistent `@macula-io/ts` Sessions**, backing
  `mesh_hello`/`mesh_goodbye`/`mesh_agents`. TWO Sessions, not one: a Session allows only one active
  `subscribe()` at a time (confirmed against `macula-go`'s own `connection.Session` — concurrent
  subscriptions sharing one session corrupt the shared read loop), so `agent.hello` and `agent.goodbye`
  each get their own. And TWO different identities, not the same one twice — a second connection under
  the same node ID gets the FIRST one closed by the station (`macula_station_listener.erl`'s per-identity
  peer dedupe), confirmed live during this cutover's own verification. New
  `presenceGoodbyeIdentityPath()` / `MACULA_MCP_PRESENCE_GOODBYE_IDENTITY` (`macula_cli.ts`) is the sixth
  identity this needs. Both subscription handlers now write directly into `roster.ts`, in-process — no
  NDJSON feed, no separate daemon child process. The heartbeat stays a one-shot connect-publish-close via
  `macula_ts_client.ts`'s `publish()` under the DEFAULT identity (unchanged from `macula-cli`'s own old
  `publish()`) rather than riding either subscribe Session, which would turn it into a THIRD standing
  connection sharing an identity with every ordinary one-shot `mesh_call`/`mesh_publish` — colliding with
  them the same way two presence Sessions under one identity would collide with each other.
- **Real reconnect, not just a connection**: each subscribe leg's `subscribe()` call is given an
  `onClosed` hook — delivered by `@macula-io/ts`'s subscription-lifecycle fix from earlier this cycle,
  which turned a silently-dead subscription into an actual signal — that reconnects and re-subscribes
  with exponential backoff (1s base, doubling, capped at 30s) the moment that leg's connection dies for
  any reason other than a deliberate `mesh_goodbye`. The heartbeat interval tolerates the same kind of
  failure on its own terms: a failed publish tick is caught and logged, never thrown, and the next tick
  tries fresh on its own. Verified live against the production fleet: dialing a second connection under
  presence's own hello-leg identity forced the station to kick the first one mid-session (not a clean
  `stop()`), and the leg reconnected and resumed delivering `agent.hello` events into `roster.ts` within
  one backoff cycle. `mesh_serve`'s own cutover deliberately left this as a "known, honest gap" (see its
  own doc comment in `serve.ts`) — presence needed it now, since a roster that silently stops updating was
  the exact failure mode presence's old daemon existed to prevent. New `src/presence.test.ts` covers the
  two-identity wiring, the roster handlers, heartbeat resilience, the reconnect/backoff sequence
  (including a forced-mid-flight `stop()` racing an in-flight `onClosed`), and `stop()`'s teardown, all
  mocked at the `macula_ts_client.ts` boundary the same way `ring_service.test.ts` mocks `serve.ts`.
- `citizenship.ts` (presence's hecate-citizens registration, driven by `presence.start()`) is
  **unaffected by this cutover, on purpose**: it still shells out to `macula-cli` for everything it does
  (`call`, `identity sign`, realm discovery via `discoverProcedureRealm`), the same `@macula-io/ts` gaps
  already listed above for `mesh_call`/`mesh_stations` — no non-default realm, no ownership-proof signing,
  no direct-dial fallback. Presence's own two subscribe Sessions and heartbeat are fully in-process now;
  the citizen-directory registration `presence.start()` also drives is not, and can't be until those
  three capabilities land in `@macula-io/ts`.
- **`lobby_observer.ts`'s `macula-cli daemon` replaced by one persistent `@macula-io/ts` `Session` PER
  WATCHED TOPIC**, backing `mesh_observe_lobby`/`mesh_lobby_transcript`/`mesh_unobserve_lobby` (and, through
  it, `rooms.ts`'s own `tapRoom()`/`untapRoom()`). The old daemon multiplexed central plus every room topic
  over ONE mesh connection/identity; `Session` allows only one active `subscribe()` per connection (same
  constraint presence's own cutover hit first), so multiplexing is gone — central gets the existing fifth
  identity (`observeIdentityPath()`/`MACULA_MCP_OBSERVE_IDENTITY`, unchanged), and every concurrently-tapped
  room gets its OWN identity, new `observeRoomIdentityPath()` (`macula_cli.ts`, no env override — there's no
  fixed slot to pin a dynamically-tapped room to), minted from the room's own topic. `tapRoom()` stays a
  synchronous, fire-and-forget call (rooms.ts never awaits it, matching the old daemon-child-spawn shape) —
  the room's Session is registered in the tap map immediately, before its connect even starts, and the
  connect itself runs in the background.
- **Genuinely improved resilience, not just a port**: every leg (central, and each room tap) is now
  independently self-healing, adapted from presence.ts's own reconnect-with-backoff pattern (1s base,
  doubling, capped at 30s) rather than reinvented. This is a real behavior upgrade over the old daemon
  model, not a like-for-like port of it — previously the WHOLE daemon dying tore down every tap at once, and
  a single tap's watcher child dying silently removed just that tap, leaving `rooms.ts`'s own
  `ensureTapped()` to notice and re-tap on next use. Now a died central connection reconnects on its own
  without touching any room tap, and a died room tap reconnects on its own without anyone needing to notice
  or re-tap — there is no more "a tap died silently" condition to report, so the old `status()`'s
  `taps_died` field (and the daemon-crash detection it existed for) is gone with it. `stop()` and
  `untapRoom()` now do a graceful async `Session.close()` (`stop()` itself became `async` — its two callers,
  `mesh_unobserve_lobby` and `presence.ts`'s own `stop()`, now `await` it) instead of a bare child-process
  `kill()`. Verified live against the production fleet: a `room_opened` envelope from another identity on
  central dynamically tapped that room and its own chat was recorded with station-attested `publisher`; a
  real forced disconnect on a room tap's own Session (dialing a second connection under its exact identity,
  the same technique presence's own live check used) reconnected it within one backoff cycle while central
  and the observer's own `isActive()` stayed unaffected throughout; `presence.ts`'s real `start()`/`stop()`
  round-trip (which drives this module) confirmed end to end. New `src/lobby_observer.test.ts` (17 cases)
  covers the wiring, dynamic room discovery and the `max_rooms` cap, `tapRoom()`/`untapRoom()` including the
  connect-still-in-flight race, and independent per-leg reconnect, mocked at the `macula_ts_client.ts`
  boundary the same way `presence.test.ts` does. `macula_cli.ts`'s now-unused `startDaemon()`/
  `watchTopicOnDaemon()` (their last caller) are removed.
- **`rooms.ts`'s lifecycle envelopes (`mesh_open_room`/`mesh_join_room`/`mesh_leave_room`/`mesh_say`) now
  publish through `macula_ts_client.ts`'s `publish()`**, not `macula-cli`'s subprocess one — the same
  cutover `mesh_publish.ts` already took. `selfNodeId()` reads identity the same way: `tsIdentity()` (a
  synchronous seed-file read/mint, no connection) instead of `macula-cli`'s async `identity()`. It already
  talked to `lobby_observer.ts`'s new session-per-topic design unchanged (that module's own daemon-to-
  in-process cutover, above, needed no matching change in `rooms.ts` — it calls `lobbyObserver.start()`/
  `tapRoom()`/`untapRoom()`/`isTapped()` exactly as it did against the old daemon-backed version of the same
  module). `published_seq` is gone from `mesh_open_room`/`mesh_join_room`/`mesh_leave_room`/`mesh_say`'s
  results — `@macula-io/ts`'s `publish()` reports no sequence number at all, and the one `macula-cli`
  reported was never real (its own README says so: current-time-millis, one per one-shot subprocess call);
  each envelope's own `message_id`/`sent_at` is the real, useful ordering signal. Verified live against the
  production fleet: two separate processes under two separate identities — one opens a room, the other
  joins it, says something, and leaves — with the opener's own lobby-observer transcript recording all
  three lifecycle facts plus the message, each with station-attested `publisher` matching `from`.
  `rooms.test.ts` updated to mock `macula_ts_client.js`'s `publish`/`tsIdentity` at the boundary instead of
  `macula_cli.js`'s `publish`/`identity`, same pattern as `presence.test.ts`.
- **Vendored `@macula-io/ts` refreshed 0.9.0 → 0.12.0** (`vendor/macula-io-ts-0.12.0.tgz`, rebuilt via its own
  `build:prebuilds` + `npm pack`), picking up three capabilities landed there since 0.9.0: `Identity.sign()`
  (a generic Ed25519 signing primitive), realm support on `Session.call`/`callWithUcan`/`publish`/`subscribe`,
  and direct-dial (caller-side resolve+one-hop-call, provider-side advertise-direct). Re-verified the
  zero-install-script property still holds against the new tarball (no `install`/`postinstall`/`preinstall`
  script on the installed package, prebuilt native addons for all five platforms present).
- **`mesh_join_realm`'s ownership-proof signing cut over from `macula-cli`'s `identity sign` subprocess to
  `@macula-io/ts`'s new `Identity.sign()`**, now that it exists: `realm.ts`'s `begin()` loads the default
  identity in-process (`macula_ts_client.ts`'s `loadOrGenerateIdentity(defaultIdentityPath())` — the same
  seed file every other in-process tool already reads/mints from) and signs `ownership_proof.ts`'s
  `proofMessage()` directly, rather than shelling out. `proofMessage()` (already the verifier-side
  reimplementation `mesh_ring` relies on) is reused unchanged as the single source of truth for the exact
  byte layout hecate-citizens'/hecate-mail's `*_ownership_proof` modules require — node_id (32 raw bytes) ++
  timestamp (8 bytes big-endian) ++ procedure (raw UTF-8), no delimiters — so this cutover cannot drift from
  what the Erlang side verifies. `mesh_join_realm.ts` also reads its own node_id via `tsIdentity()` instead
  of `macula-cli`'s async `identity()`, matching `mesh://identity`'s own identity source. Verified live: a
  real join session created against the production `https://macula.io` portal (HTTP 201) with a real
  `Identity.sign()` signature, self-checked with `verifyOwnershipProof()` and confirmed the portal itself
  accepted it as valid proof of possession. `mesh_call`'s own `prove_identity` is a separate, narrower
  ownership proof (bound to whatever procedure the caller is invoking, not the fixed join procedure) and is
  intentionally NOT touched by this cutover — see the "Known gaps" note below, updated to match.
- **`macula_ts_client.ts`'s `call`/`publish`/`watch` now thread a caller-supplied `realm` straight through**
  to `@macula-io/ts`'s `Session.call`/`callWithUcan`/`publish`/`subscribe` (their `CallOptions.realm`/
  `PublishOptions.realm`/`SubscribeOptions.realm`, all landed in the 0.12.0 vendor refresh above) — the
  `assertRealmSupported()` guard that used to throw for any non-default realm on all three is gone. This was
  a real, live bug for `mesh_call`/`mesh_publish`/`mesh_watch` themselves, not just for `mesh_stations`/
  `mesh_recall`/`mesh_remember`: all three tools already accepted and forwarded a `realm` argument, so
  passing one always threw "not supported by this server's in-process implementation yet" even though the
  underlying SDK had supported it since 0.12.0 landed — now it works. `assertDirectNotRequested()` is
  unchanged and still throws for `mesh_call`'s `direct: true` (see the direct-dial gap below — a separate,
  larger cutover).
- **`mesh_stations.ts`/`mesh_memory.ts` (`mesh_list_stations`/`mesh_recall`/`mesh_remember`/
  `mesh_remember_directory`) finish cutting over to `@macula-io/ts`**, closing the exact gap the previous
  bullet fixed: both the DHT discovery half and the actual realm-scoped call (`hecate_stations.list_stations`
  / `hecate-rag.answer_query`/`add_knowledge`/`upload_knowledge`) now go through `macula_ts_client.ts`'s
  `call()`, not `macula-cli`'s subprocess one. New `src/mesh_stations.test.ts` and expanded
  `src/mesh_memory.test.ts` cover the discover-then-call composition and its realm threading, mocked at the
  `macula_ts_client.ts` boundary the same way `rooms.test.ts`/`presence.test.ts` do (confirmed RED against
  the pre-cutover code, GREEN after). Verified live against the production fleet: `mesh_list_stations` and
  `mesh_recall` (read-only) ran fully live end to end; `mesh_remember`/`mesh_remember_directory` (which
  write to the real shared `hecate-rag` corpus) were also verified live, each write small, distinctly
  tagged, and immediately retired again via `hecate-rag.retire_document` (its `document_id` is the
  `source_label` for a `mesh_remember` deposit, and `mesh_memory.ts`'s own deterministic
  `documentIdFor(relativePath)` hash for a `mesh_remember_directory` file), then confirmed gone from a
  follow-up `mesh_recall` search — see `scripts/mesh-stations-memory-live-check.mjs`.

- **`citizenship.ts`/`ring_service.ts`/`rings.ts`/`mesh_ring.ts` (backing `mesh_call`'s `prove_identity`,
  `mesh_ring`, `mesh_answer_ring`) cut over to `@macula-io/ts`**, closing the `prove_identity`/ring gap the
  previous release flagged. New `macula_ts_client.ts` functions: `signOwnershipProof(identityPath, procedure)`
  (`Identity.sign()` over `ownership_proof.ts`'s own `proofMessage` byte layout — the SAME helper its
  `verifyOwnershipProof()` uses, not a second, independently-drifting implementation of that layout) and
  `callThenDirect(...)` (an ordinary `session.call()`, falling back to `session.callDirect()` — real
  direct-dial, not a stub — on failure, both attempts sharing one connection so a genuinely dead session
  fails both for the same underlying reason instead of masking it). `citizenship.ts` gets a thin `signIdentity()`
  / `callThenDirect()` pair pinned to this server's own default identity, replacing `macula_cli.ts`'s
  `identitySign()`/CLI-subprocess `call()` at every call site: `citizenship.ts`'s own `register()`,
  `ring_service.ts`'s `handleRing`/`answerPendingRing`, `mesh_ring.ts`'s `placeRing`, and `mesh_call.ts`'s
  `prove_identity` option. `rings.ts`'s local SQLite bookkeeping (already on `node:sqlite`) is untouched —
  only the mesh-transport calls moved.
- **Found and fixed two real, pre-existing bugs while live-verifying the above** (neither introduced by this
  cutover, both were already broken on `main`):
  - `rings.ts`'s `parseProven()` was called on the whole reply object (`payload.citizen_did`/`payload.proof`)
    but `ring_service.ts`'s `provenReply` actually nests the proof under a `proven` key
    (`{..., proven: {citizen_did, proof}}`) — so `parseRingReply`/`parseRingAnswerReply` silently dropped
    every real reply's proof, and `mesh_ring.ts`'s `placeRing` treated every genuine accept/decline as
    unproven-and-unreachable, defeating the hijack-protection the 2026-09-03 release review added. Fixed by
    having both callers pass `p.proven` (the nested value) instead of `p` itself; `parseProven()`'s own
    contract is unchanged. New regression coverage in `rings.test.ts` (confirmed RED against the pre-fix
    code) and live-confirmed: `scripts/ring-two-process-check.mjs`'s accepted-ring check now genuinely
    verifies the callee's signature instead of accidentally short-circuiting to "not verifiably signed."
  - `serve.ts`'s `direct: true` path called `Session.putProcedureAdvertisement()` on the SAME `Session`
    already running `serve()` — @macula-io/ts's own `#requireHandleNotServing` guard rejects that
    combination outright (`putProcedureAdvertisement`'s `PutRecord` CALL would race `serve()`'s reads of the
    shared control stream), so every direct-dial registration — `ring_service.ts`'s ring endpoint included —
    failed to register at all. Fixed with a SECOND, lazily-opened `Session` (new seventh identity,
    `serveAdvertiseIdentityPath()` / `MACULA_MCP_SERVE_ADVERTISE_IDENTITY`) dedicated to the DHT
    advertisement, naming the SERVING session's own resolved station (not the advertise session's, which
    could in principle land on a different one via its own fallback). New `serve.test.ts` (0 coverage
    before this), confirmed RED against the pre-fix code (4/5 new tests failed without the second Session).
- Live-verified against the real production fleet: `scripts/ring-two-process-check.mjs` (13/15 checks —
  the 2 failures are `lobby_observer.ts` room-tap reconnect flakiness under concurrent load, pre-existing,
  unrelated to this cutover), including a real accepted ring with a verified callee signature, a deferred
  ring answered and carried back as a proven `ring_answer`, an unreachable ghost node whose error message
  shows BOTH the plain-call and the direct-dial-retry attempts genuinely ran
  (`unknown_error ...; direct-dial retry: directdial: resolve ... procedure has no direct-dial advertisement`),
  and a forged-procedure proof correctly declined via the new `citizenship.signIdentity()`/`callThenDirect()`.
  A separate, dedicated check proved the direct-dial SUCCESS half specifically: `session.resolveDirect()` +
  `session.callDirect()` against a real, running `ring_service.ts` endpoint (registered via the `serve.ts`
  fix above) resolved a real station identity/host/port and got back a real, signed reply over a genuine
  one-hop QUIC dial — not gossip-routed.

### Removed
- **`macula-cli` is no longer a dependency of this project at all.** This is the capstone of the migration
  documented throughout this 0.18.0 section above: every tool had already been cut over to
  `@macula-io/ts`, and `citizenship.ts`'s `register()` was the one remaining subprocess-backed call (its
  realm discovery, a DHT `find-records-by-type` scan) — moved in-process too, as
  `macula_ts_client.ts`'s new `discoverProcedureRealm()`. With nothing left calling it, `src/macula_cli.ts`'s
  entire subprocess-execution surface (`spawn`/`execFile`, the `--json` argv builder, `call`/`publish`/
  `watch`/`serve -daemon`/`daemon status`/`daemon stop`/the three DHT `find-*`/`content put`/`content get`,
  `identity`/`identity sign`, and all of `checkCliVersion`/`MIN_MACULA_CLI_VERSION`/`extractSemver`/
  `isOlder`/`binPath`/`installedCliCandidates`) was deleted outright, not deprecated in place. The file's
  remaining genuinely CLI-independent parts (station defaults, the seven per-concern identity seed-file
  paths, the shutdown-hook registry, `MaculaCliError`, `splitRealmPrefix`) survive, renamed to
  `src/mesh_config.ts` — a file named `macula_cli` implying a CLI dependency that no longer exists would
  have been actively misleading to keep.
- `scripts/postinstall.mjs` (the hook that fetched/updated a separately-installed `macula-cli` binary on
  `npm install -g`) is deleted, along with `package.json`'s own `postinstall` script and its `files` entry —
  this package now ships **zero lifecycle scripts of its own**. `install.sh`/`install.ps1` no longer probe
  for or install `macula-cli` (step removed entirely, not just skippable), and no longer need
  `--allow-scripts` (there is nothing left for that flag to unblock). `MACULA_MCP_SKIP_CLI_INSTALL` is gone;
  `install/existing_cli.ts` (the macula-cli-binary probe `macula-mcp-install`/`macula-mcp-status` used to
  run first) is deleted, and both commands' output no longer mentions macula-cli at all.
  `macula-mcp-doctor`'s own `checkCliVersion`/`MIN_MACULA_CLI_VERSION` check (an entirely separate concern
  from its real smoke test, which is unaffected) is gone the same way. `MACULA_CLI_BIN`/
  `MACULA_CLI_INSTALL_DIR` are no longer read anywhere.
- Grepped the whole repo for "macula-cli" (case-insensitive) after this pass: what's left is (a) this
  CHANGELOG's own historical entries, accurate as written, and (b) a handful of source comments comparing
  current behavior to what the old subprocess client used to do, or advising a human operator who wants to
  mint a UCAN by hand (`macula-cli ucan mint ...` — a real, separate, still-existing tool this package no
  longer depends on or installs, but that a human may still reach for outside of macula-mcp entirely). None
  of it names macula-cli as something this package requires, installs, or shells out to.

### Known gaps (real, not hidden — see README.md)
- `@macula-io/ts` itself now supports non-default realms, direct-dial, and `Identity.sign()` (0.12.0, see
  above), and `macula_ts_client.ts` now routes realm through (see above) — but `mesh_call`'s own
  caller-facing `direct` OPTION is NOT wired up yet: `assertDirectNotRequested()` still throws a clear error
  for it instead of using `@macula-io/ts`'s `callDirect`/`resolveDirect` (which `citizenship.ts`'s
  `callThenDirect()` now uses internally for the ring/citizenship flows above). This gap got a real edge
  since the Removed section above: reaching a UCAN-gated capability (which requires `direct: true`) through
  `mesh_call` used to have a fallback — a separately-installed `macula-cli`, invoked by hand, outside this
  server — and now that macula-cli is not something this project depends on or advises installing, that
  fallback is gone too. `mesh_call`'s `direct: true` genuinely cannot reach a UCAN-gated capability at all
  right now; wiring it to `callDirect`/`resolveDirect` is real, scoped follow-up work, not attempted in this
  pass.
- The DHT tools no longer report `verified`/`verify_error` — `@macula-io/ts` does not verify a record's
  signature or expiry on the caller's behalf yet (documented in its own `findRecord`/`findRecords`/
  `findRecordsByType`). A caller that needs to trust a record's payload must check the signature itself.
- `mesh_call`'s result no longer includes `responded_by`; `mesh_publish`'s no longer includes `seq`;
  `mesh_watch`'s events no longer include `delivered_via`/`received_at` — none of these are surfaced by
  `@macula-io/ts` yet.
- `mesh_serve`'s persistent Session has no reconnect supervisor yet (the old `macula-cli` daemon had one,
  mirroring the Erlang reference SDK's `respawn_link` pattern) — if the underlying connection dies, served
  procedures stop answering until `mesh_serve` is called again. Real, scoped future work, not attempted here.
- Existing narrow unit tests (`mesh_call.test.ts`) test pure helper functions (`splitRealmPrefix`, etc.)
  unaffected by this cutover and still pass; they do not exercise `mesh_call`/`mesh_publish`/`mesh_watch`'s
  own `@macula-io/ts`-backed call paths (including the realm threading fixed above) with a boundary mock.
  `mesh_memory.test.ts` is the exception as of the `mesh_stations`/`mesh_memory` cutover above — it now also
  covers `mesh_recall`/`mesh_remember`/`mesh_remember_directory`'s discover-then-call composition and realm
  threading via a boundary mock (as does the new `mesh_stations.test.ts`), verified RED against the
  pre-cutover code. New mocked unit tests for `mesh_call.ts`/`mesh_publish.ts`/`mesh_watch.ts`/the DHT tools/
  `serve.ts` were not added in this pass — correctness there still rests on live verification against the
  real production fleet (every cut-over tool, including a full `mesh_serve` → call-from-a-separate-process →
  `mesh_unserve` → confirm-gone cycle), not on unit test coverage. A real, narrower gap now, flagged for
  follow-up.

## [0.17.0] - 2026-09-03

> Never tagged or published to npm as its own release, same as 0.18.0 above — folded into 0.19.0.

**Requires Node.js 24.18.1 or newer** (`engines.node` bumped from `>=20`):
`node:sqlite` needs it, see below.

### Changed
- `roster.ts`, `lobby_transcript.ts`, and `rings.ts` (the local caches behind
  `mesh_agents`, `mesh_read_inbox`/`mesh_lobby_transcript`, and
  `mesh_ring`/`mesh_answer_ring`) moved from `better-sqlite3` to Node's own
  built-in `node:sqlite`. `better-sqlite3` is a native module, and it had
  caused real install friction twice: a Node-ABI segfault on its 13.x line
  that forced a version pin, and npm 12's install-script lockdown silently
  breaking its native build unless `--allow-scripts` named it explicitly.
  `node:sqlite` ships inside Node itself, so there is no native module to
  compile per platform/Node version and one less thing `--allow-scripts`
  needs to name (`install.sh`/`install.ps1` now only allow-list
  `@macula-io/mcp`, for the still-separate macula-cli-fetch postinstall
  step). Same schema, same queries, same exported function signatures on
  all three files -- an internal storage-driver swap only.
- Picked up two correctness differences along the way, both now fixed
  before landing rather than carried into node:sqlite's stricter behavior:
  node:sqlite defaults its busy-timeout to 0ms where better-sqlite3
  defaulted to 5000ms (now explicitly set to 5000ms on all three DBs, so a
  write collision between two sessions on one machine waits instead of
  throwing immediately), and node:sqlite throws on a bind object carrying a
  named parameter with no matching placeholder in the SQL text where
  better-sqlite3 silently ignored it (`recentFacts()` and `listRings()` now
  build their bind params conditionally instead of always passing the full
  set).

## [0.16.0] - 2026-09-03

**Requires macula-cli 0.6.0 or newer** (`MIN_MACULA_CLI_VERSION` bumped from
0.5.1), released alongside this entry: 0.5.1 and earlier don't recognize the
`-seed` flag at all, so any of this server's own `-seed` args against an
older binary fails with "flag provided but not defined: -seed" the moment
`MACULA_MESH_STATIONS` names more than one station.

### Added
- `MACULA_MESH_STATIONS` (comma-separated): every direct-dial tool call and
  the internal presence/serve/lobby-observer daemons now dial a primary
  station plus fallbacks (macula-cli's own `-seed`), instead of exactly one
  station with no recourse if it's down. The older singular
  `MACULA_MESH_STATION` still works, treated as a one-element list. Default,
  when neither is set, is the existing primary plus two more from the demo
  fleet spanning both providers (frankfurt, nuremberg, falkenstein).
  Presence/serve/lobby-observer's daemons benefit the most: macula-cli's
  `daemon start` now redials and replays (re-advertises registered
  procedures, re-subscribes topics) if its connection dies, so a station
  restart no longer silently takes one of these off the mesh until
  something restarts it by hand.
- `serve.ts` now notices its daemon dying unexpectedly and marks itself
  inactive so the next `mesh_serve` call restarts it cleanly, mirroring the
  fix `presence.ts`'s own `watchForUnexpectedDeath` already had (2026-09-02)
  -- serve.ts was missing the equivalent listener entirely.

## [0.15.0] - 2026-09-03

Work packages 1 to 3 of [`plans/PLAN_AGENT_CONVERSATIONS.md`](plans/PLAN_AGENT_CONVERSATIONS.md):
conversations get an envelope, rooms, rings and a consent policy. The wire is
broken, not versioned: nothing was in production, and both ends of every
conversation are this package.

**Breaking**, not additive: `mesh_send_chat` and `mesh_open_lobby_session` are
gone, along with the deterministic `agents.dm.<node_id>` inbox topic. A
0.14.0 caller of either tool gets a normal MCP unknown-tool error, not a
silent behavior change. See Removed below.

**Requires macula-cli 0.5.1 or newer**, released alongside this version:
0.5.0 and earlier publish a daemon registration's direct-dial record over the
session `ServeForever` is reading, so the ring endpoint's registration always
times out on those binaries. `doctor`/the installer fetch the current release.

Before this release is tagged, an adversarial review (five lenses over the
new code, three release audits, every finding checked by three independent
refuters) found and this version fixes: a hijack where an unproven reply let
any peer serving `agent.<victim>.ring` intercept a ring meant for someone
else; a race that could start two lobby-observer daemons under one identity;
no detection of a crashed room tap or observer daemon; rings and room
transcripts stored per machine while identities are scoped per session;
unbounded pending rings and joined rooms; a shell-quoting gap in the ring
handler's command line; and a caller timeout shorter than the callee's own
handler budget. Full detail in the sections below.

### Added
- **Rings** (`mesh_ring`, `rings.ts`, `ring_service.ts`, `ownership_proof.ts`;
  work package 2): the addressed invite is a `mesh_call` to the callee's
  `agent.<node_id>.ring` procedure, carrying a room and the caller's
  `{node_id, timestamp, procedure}` ownership proof (the same one
  hecate-citizens verifies; verified here with Node's own Ed25519). Presence
  serves that procedure automatically -- the one exception to "serving is never
  automatic" -- with a relay handler shipped in the package
  (`dist/ring_handler.js`) that forwards the call over a local socket into the
  running server, where proof verification, the operator's contact policy
  (`MACULA_MCP_CONTACT_POLICY`: `open`, `ask` (default), `closed`) and the
  room join happen. Answers are integers: `1` accepted (the callee joins the
  room before answering; the caller waits for `participant_joined`), `2`
  declined with a reason, `3` deferred (pending in the callee's
  `mesh_read_inbox`); a node nobody serves is `unreachable`, not silent.
  `MACULA_MCP_NO_RING=1` serves nothing. Rings sent and received are recorded
  in `rings.sqlite3` (`MACULA_MCP_RINGS_DB`); `mesh_rooms` lists outgoing rings
  still awaiting an answer; `mesh://identity` and `mesh_hello` report the
  endpoint under `ring`. The endpoint is also published as a direct-dial DHT
  record (renewed every 20 min inside a 1 h TTL), so a cross-station ring
  resolves the callee's station and dials it in one hop. Verified live in two
  processes, callee on Paris and caller on Frankfurt:
  `scripts/ring-two-process-check.mjs`.

- **Consent policy and answering deferred rings** (`policy.ts`,
  `mesh_answer_ring`; work package 3): the contact policy lives in
  `~/.config/macula-mcp/contact_policy.json` (`MACULA_MCP_CONTACT_POLICY_FILE`),
  re-read on every ring: `contact_policy` (`open`/`ask`/`allowlist`/`closed` or
  `1`..`4`), `allowlist` (node ids accepted under `allowlist`), `offers`. A
  malformed file falls back to `ask` and surfaces the problem under
  `ring.policy_error`. `mesh_answer_ring` answers a deferred ring: on `1` it
  joins the room first, then carries the answer back as a proven `ring_answer`
  call to the caller's own ring endpoint (`caller_notified: 0` when they are
  gone; the answer is recorded regardless). Ring args now carry `kind: "ring"`;
  a `ring_answer` is the second kind that procedure accepts, verified the same
  way and matched against the caller's own record of the ring.
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
- **`MIN_MACULA_CLI_VERSION` is `0.5.1`.** Every macula-cli release up to
  0.5.0 published a daemon registration's direct-dial record over the session
  `ServeForever` was reading, so `serve -daemon -direct` always timed out;
  0.5.1 puts it over the daemon's calling session (fixed while wiring the ring
  endpoint). `doctor` reports an older binary; the installer fetches the
  current one.
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

### Fixed

Found by an adversarial review before this version was tagged (five review
lenses, three release audits, three refuters per finding).

- **Ring hijack.** A ring's reply carried no proof from the callee, so
  whoever currently served `agent.<to>.ring` was believed regardless of
  whether it held `to`'s key. Every ring and ring_answer proof is now bound
  to its exact `(kind, ring_id, answer)`, not the bare procedure name; every
  reply the ring service gives is itself signed; `mesh_ring` refuses an
  unproven or mismatched accept/decline and reports `unreachable` instead of
  trusting it.
- **Lobby observer race.** `lobbyObserver.start()` had no in-flight guard, so
  a fresh session's first room tool and `ensurePresence`'s own background
  start could both see no state and each spawn a daemon; the second silently
  overwrote the first, leaking a daemon and its taps. Guarded the same way
  `presence.ts` already guards its own start.
- **Silent tap and daemon death.** Neither the lobby observer's daemon nor
  any individual room-tap child had an exit/error handler, so a crash left
  `isTapped()` reporting true and `mesh_say`'s reply wait polling a
  transcript nothing was feeding. A dead daemon now tears the observer down
  so the next `mesh_hello` rebuilds it; a dead single tap is removed from the
  tap set so `mesh_rooms`/`say()` re-tap on next use.
- **Rings and transcripts scoped per machine, not per session.** Identities
  are deliberately scoped per logical session, but `rings.sqlite3` was one
  file per machine with no owner column, so two sessions on one box could see
  and answer each other's rings. Every ring row now carries `self`; every
  read is scoped to it.
- **No caps.** A caller under an accepting policy could make the callee
  spawn unbounded room watchers and fill its rings store. Added
  `MAX_PENDING_PER_PEER`, `MAX_JOINED_ROOMS` and a per-`from` rate limit,
  and a 24-hour TTL on pending rings.
- **Shell-unsafe command construction.** The ring handler's command line was
  built with double-quoted paths, inside which `sh` still expands `$` and
  backticks. Every argument is now single-quoted for POSIX `sh`.
- **Timeout ordering.** The caller's ring call timeout (20 s) was shorter
  than the callee's own accept-handling budget (up to 30 s), so a slow but
  genuine accept could be reported as unreachable while the callee had
  already joined. Raised to 40 s.
- **Unattested attribution.** Every room decision (who joined, who replied,
  who opened it) trusted the envelope's own `from` field, a self-claim,
  while the station-reported publisher of each fact was discarded before it
  reached the transcript. The publisher is now recorded and compared;
  `participants_seen`, `mesh_say`'s reply match and `mesh_ring`'s join-wait
  all require it to agree with `from`.
- **Threading order.** `threadEnvelopes` mis-rooted a reply that arrived
  before its parent inside the same read window. Now two passes, so arrival
  order no longer matters within a page.
- **Tap leaked on a failed publish.** `openRoom`/`joinRoom` tapped a room
  before publishing to it; a failed publish left the tap live with no room
  record and nothing ever untapped it. Both now untap on failure.
- **Local relay hardening.** The Unix socket the ring handler relays
  through, and the SQLite stores under `~/.macula-mcp` and
  `~/.config/macula-mcp`, are now created `0700`/`0600` (previously default
  `umask`-dependent modes), and the socket server caps line length, idle
  time and concurrent connections.
- Several stale doc claims fixed to match the shipped code: the identity
  persistence model (per-session, not a throwaway temp file), the full tool
  and prompt lists, `mesh_agents`' persistent roster, `mesh_remember`'s real
  `add_knowledge` call, and the presence auto-start trigger list, now
  identical everywhere it appears.

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

[Unreleased]: https://github.com/macula-io/macula-mcp/compare/v0.20.0...HEAD
[0.20.0]: https://github.com/macula-io/macula-mcp/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/macula-io/macula-mcp/compare/v0.16.0...v0.19.0
[0.16.0]: https://github.com/macula-io/macula-mcp/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/macula-io/macula-mcp/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/macula-io/macula-mcp/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/macula-io/macula-mcp/compare/v0.12.3...v0.13.0
[0.12.3]: https://github.com/macula-io/macula-mcp/compare/v0.12.2...v0.12.3
[0.12.2]: https://github.com/macula-io/macula-mcp/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/macula-io/macula-mcp/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/macula-io/macula-mcp/compare/v0.11.0...v0.12.0
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
