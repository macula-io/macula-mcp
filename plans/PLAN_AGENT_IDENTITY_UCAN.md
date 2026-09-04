# PLAN: Per-agent UCAN delegation for macula-mcp

⚠ **SUPERSEDED 2026-09-04.** The blocker this plan's own status line and
both "Update" notes below describe — `-ucan -direct` composability gated
on a macula-cli release — no longer applies at all: macula-mcp dropped
macula-cli entirely and talks to the mesh in-process via `@macula-io/ts`.
`mesh_call`'s `direct: true` now routes through `Session.callDirect`/
`callDirectWithUcan` directly and is **live-verified working**, including
with `MACULA_MCP_UCAN` attached (see CHANGELOG.md's 0.19.0 entry). Kept
here for historical context on how the gap was diagnosed, not as a
statement of current status — the feature works today.

Status: **This repo's half (items 1–2 below) implemented, 2026-09-03 —
but NOT yet functional against any macula-cli a real user can install**
(see the second "Update" below and "What's open"'s first item). Every
claim about *existing* infrastructure below was verified against the
actual source, not assumed — see "What's already real."

**Update, 2026-09-03**: this plan's own blocker (no hecate-service verifies
`ucan_token`) is now sequenced as Phase 4 of
`macula-io/macula-architecture/plans/PLAN_CLOSE_SERVICE_AUTH_GAPS.md`, and a
DEEPER blocker was found the same day: no client SDK's direct-dial call
path can attach a UCAN at all (identical gap in go/rust/dotnet/php, that
plan's own Phase 0) — this plan's `-ucan -direct` combination literally
cannot work yet, confirmed by `macula-cli call`'s own explicit refusal to
combine the two flags. This plan is Phase 2 of that one; start there.

**Update, 2026-09-03 (later, same day)**: that deeper blocker was
*fixed* (macula-go v0.5.0 adds `directdial.CallWithUCAN`; macula-cli
commits 52dec80/6e951fa consume it — `call -direct -ucan <file>` now
composes on macula-cli's own **master** branch) — but not yet
*released*: v0.6.0 remains the newest tagged macula-cli, the only one
`install.sh`/`install.ps1`/this package's own `postinstall` will ever
fetch, and it still contains the explicit refusal those two commits
replaced (`"-ucan cannot be combined with -direct"`, `call.go`).
Confirmed against macula-cli's own git history and release list, not
assumed — see "What's open"'s first item, which is now the load-bearing
blocker.

Given that, this repo's own two mechanical changes were built anyway
(the wiring is real and correct; only the upstream release is missing):
`MACULA_MCP_UCAN` (`macula_cli.ts`'s `ucanPath()`) is attached to every
`call()` when set, gated by a check (`assertUcanUsableWithIdentity()`)
that fails loudly, at first use inside `call()` — not at process
start/module load, despite this doc's own earlier wording — if
`MACULA_MCP_IDENTITY` is unset, names a path that doesn't exist yet
(would be freshly minted — can never be the node ID a UCAN's audience
was minted against), or names a file that isn't a real 32-byte identity
seed. A SECOND guard (`assertUcanDirectComposable()`) now refuses
`direct: true` outright whenever a UCAN is set, precisely because of
the release gap above — rather than letting a caller reach macula-cli's
own raw refusal several steps into a doomed subprocess. `publish()`
deliberately does NOT attach one: `macula-cli pubsub publish` has no
`-ucan` flag at all today, unlike `call`, so wiring it in would fail
every publish once `MACULA_MCP_UCAN` is set, for a flag macula-cli
doesn't accept. Item 3 (manual provisioning) needed no code, as
designed. This plan is still not *useful* end-to-end for TWO
independent reasons now, not one — the "What's open" items below (no
tagged macula-cli release contains the composability fix; no
hecate-service verifies an incoming `ucan_token` at all) are both
untouched by this work and both gate everything downstream of it.

## Goal

An agent session acting through `macula-mcp` should carry its own
delegated, independently-revocable authority, distinct from the human's
own root identity — so a gated hecate-service call is attributable to
the agent that made it, and a misbehaving agent session can be shut off
without rotating the human's own key. This is channel (b) of
`hecate-corpus/philosophy/HECATE_AUTH_MODEL.md`.

## What's already real (verified against source, not assumed)

- **`macula-cli` already mints and attaches UCANs.** `ucan mint
  <issuer> <audience>` signs a token with a chosen identity and a
  `-capability with:can` list (`cmd/macula-cli/ucan.go`); `ucan inspect`
  decodes one; `call -ucan <file>` attaches a pre-minted token to a
  plain (non-direct) call, alongside `-identity <path>` to pick which
  keypair signs the call itself (`cmd/macula-cli/call.go`). None of this
  needed building — the corpus's own `HECATE_AUTH_MODEL.md` claimed
  otherwise and was wrong; fixed there.
- **`macula-mcp` already mints per-concern identities, but never a UCAN.**
  `src/macula_cli.ts` mints a fresh, throwaway Ed25519 identity per
  server process for each of five concerns (default mesh ops, watch,
  presence, serve, observe) — deliberately separate so concurrent tool
  calls or sessions never collide under one node ID at a station. Every
  one of those identities can already be pinned to a fixed, persisted
  path via an env var (`MACULA_MCP_IDENTITY`, `MACULA_MCP_WATCH_IDENTITY`,
  etc.) instead of a fresh throwaway. But no exported operation in that
  file — `call`, `publish`, `watch`, `findRecord`, `artifactPut`, ... —
  ever passes `-ucan`. The identity-pinning plumbing exists; the
  UCAN-attachment plumbing doesn't.
- **`hecate_om_capabilities`'s `verify => true` checks the wrong side of
  the call for this purpose.** It verifies the *provider's* org-rooted
  service-cert chain before a consumer dials it
  (`keep_chain_verified` → `macula_record:verify_advertisement_cert_chain/3`)
  and forwards a caller's `ucan_token` to that provider opaquely. It does
  not check that the token resolves to a human's realm membership —
  that check, if it exists at all, would live on the *receiving*
  hecate-service's side, and this plan does not know whether it does.
  See "What's open."

## What this plan builds

Two small, mechanical changes to `macula-mcp`, plus a manual,
zero-new-code provisioning step for a human to run once per agent:

1. **✅ Done, 2026-09-03. A `MACULA_MCP_UCAN` env var**, read the same way
   `MACULA_MCP_IDENTITY` already is (`ucanPath()`, `macula_cli.ts`). When
   set, `call()` adds `-ucan <path>` to its flags on every invocation.
   `publish()` deliberately does not: `macula-cli pubsub publish` has no
   `-ucan` flag to receive it (checked against source), so this stays
   undone until that changes rather than shipping a flag macula-cli would
   reject. Reaching an actually-gated capability still needs the caller
   to also pass `direct: true` (`mesh_call`'s own field) — gated
   capabilities are direct-dial only, so this doesn't force it on every
   call, since a UCAN can harmlessly ride along on an ordinary plain call
   to something that isn't gated at all. **Not yet reachable in practice**:
   see the second "Update" above and `assertUcanDirectComposable()` below
   — no released macula-cli can actually carry `-ucan` over `-direct` yet.
2. **✅ Done, 2026-09-03. A check at first use, not a silent fallback,
   and not literally a process-startup check either** — corrected
   wording; the original draft of this line overclaimed "startup".
   (`assertUcanUsableWithIdentity()`, `macula_cli.ts`, called from
   `call()` right before it would attach `-ucan`): throws if
   `MACULA_MCP_UCAN` is set but `MACULA_MCP_IDENTITY` is not, names a
   path that doesn't exist yet (detected via a plain `existsSync` — that
   path would be freshly minted by macula-cli's own `identity` command
   the moment anything used it, which can never be the node ID a human
   already minted the UCAN's audience against), or names a file that
   exists but isn't a real 32-byte identity seed (empty/truncated/
   otherwise not something `macula-cli identity` ever wrote). A UCAN's
   audience is a specific node ID; presenting it from a different,
   throwaway identity is a token that will never verify, and doing that
   silently would look like working authorization right up until a
   gated call actually needs it. This is a per-`call()` check, not a
   process-boot one — a session that never calls a `call()`-based tool
   never pays for it, which is fine, since it also never needed the
   UCAN. It STILL cannot detect a right-*sized* but wrong identity (a
   real 32-byte seed for a different node than this UCAN's audience) —
   see the function's own doc comment for why that needs either a real
   Ed25519 derivation or a macula-cli subprocess spawn, both
   deliberately avoided here (this file's functions stay spawnable
   offline, matching `ci.yml`'s own test job).
2b. **✅ Done, 2026-09-03. `assertUcanDirectComposable()`** (`macula_cli.ts`,
   called from `call()` alongside the check above): refuses `direct: true`
   outright whenever `MACULA_MCP_UCAN` is set, unconditionally — not a
   version check, because no released macula-cli exists yet to check
   against (see the second "Update" above). Replace this with a real
   version comparison, folded into `MIN_MACULA_CLI_VERSION`, the day
   macula-cli tags a release containing 52dec80/6e951fa.
3. **Provisioning (a human, by hand, once per agent — no new code)**:
   ```
   macula-cli identity --identity ~/.config/macula-cli/agent-identity.seed
   # prints the agent's node ID -- this is the UCAN's <audience>

   macula-cli ucan mint \
     --identity ~/.config/macula-cli/identity.seed \
     --capability <realm>:<capability> \
     --expires-in <duration> \
     --out ~/.config/macula-cli/agent-delegation.ucan \
     <human-node-id> <agent-node-id>
   ```
   The human's own default identity signs the delegation; the agent's
   node ID is the audience. Then, wherever this agent's `macula-mcp` is
   launched:
   ```
   MACULA_MCP_IDENTITY=~/.config/macula-cli/agent-identity.seed
   MACULA_MCP_UCAN=~/.config/macula-cli/agent-delegation.ucan
   ```

## What's open — not decided here

- **No tagged macula-cli release contains the `-direct -ucan`
  composability fix.** It's real and it's on macula-cli's master
  (commits 52dec80, 6e951fa), but v0.6.0 is still the newest git tag as
  of this writing, and `install.sh`/`install.ps1`/this package's own
  `postinstall.mjs` only ever fetch a tagged release — there is no path
  from a real, documented install of macula-cli to the fix today.
  `assertUcanDirectComposable()` (`macula_cli.ts`) refuses the
  combination outright rather than letting a caller discover that only
  via macula-cli's own raw refusal. Since every currently-gated
  capability is direct-dial only, this is the load-bearing blocker —
  `MACULA_MCP_UCAN` genuinely cannot reach a gated capability from any
  macula-mcp install pointed at a real macula-cli release until this is
  cut. Whoever cuts that release should also bump
  `MIN_MACULA_CLI_VERSION` (`macula_cli.ts`) to name it and delete
  `assertUcanDirectComposable()` in favor of a real version check.
- **Confirmed, not just unconfirmed now**: no hecate-service verifies an
  incoming `ucan_token` at all today — `macula:advertise/5`'s
  `{ucan_required, Issuer}` policy exists and works, but every
  hecate-service (hecate-rag included) hand-rolls its own advertise loop
  with a hardcoded open policy, and nothing calls into it. See
  `hecate-om/plans/PLAN_UCAN_GATED_CAPABILITIES.md` for the scoped fix —
  and its own confirmed boundary: that policy checks one exact issuer's
  direct signature, not a human-membership-rooted delegation chain of
  arbitrary depth. This plan's own work has nothing to attach to until
  that one lands.
- **Expiry and refresh.** A manually-minted, manually-placed token file
  doesn't refresh itself. Nothing here re-mints it before `-expires-in`
  runs out; a session just starts failing gated calls at that point.
- **Revocation.** `HECATE_AUTH_MODEL.md`'s premise is that a compromised
  agent session is "revocable on its own." Nothing checks a revocation
  list anywhere in this design — only expiry stops a token, and an
  actively-revoked-but-not-yet-expired one still works.
- **Should `macula-mcp` mint the UCAN itself** (spawning `ucan mint`
  under the human's identity on first run, prompting for a capability
  list) instead of requiring the manual steps above? Leaning toward
  manual-first — smaller, and doesn't need macula-mcp to ever touch the
  human's own identity file — but not decided.

None of the above blocks starting; the first two items (the missing
macula-cli release, then the missing hecate-service-side verification)
each independently block the whole plan being *useful*, not just
finishing — both must clear before a UCAN attached by this repo's own
code ever reaches a capability that actually checks it.
