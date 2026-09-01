# PLAN: Per-agent UCAN delegation for macula-mcp

Status: **Proposal — sketch, not started.** Every claim about *existing*
infrastructure below was verified against the actual source, not
assumed — see "What's already real."

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

1. **A `MACULA_MCP_UCAN` env var**, read the same way
   `MACULA_MCP_IDENTITY` already is. When set, every operation in
   `macula_cli.ts` that can reach a gated capability (`call`, at minimum;
   `publish` if publishing ever gates) adds `-ucan <path>` to its flags.
2. **A startup check, not a silent fallback**: if `MACULA_MCP_UCAN` is
   set but `MACULA_MCP_IDENTITY` is not (or points at a freshly-minted
   throwaway), fail loudly at first use. A UCAN's audience is a specific
   node ID; presenting it from a different, throwaway identity is a
   token that will never verify, and doing that silently would look like
   working authorization right up until a gated call actually needs it.
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

None of the above blocks starting; the first item blocks the whole plan
being *useful*, not just finishing.
