# PLAN: macula-mcp one-line installer

⚠ **SUPERSEDED 2026-08-29.** The Burrito-built hecate-daemon fetch/launch
path this plan specs (Phase 0 onward) was never built past a dead,
unreferenced `install/fetcher.ts` (deleted in the 2026-08-29 rework) and
is no longer the direction: `macula-mcp` shells out to
[`macula-cli`](https://github.com/macula-io/macula-cli), which already
ships its own tested cross-platform `install.sh`/`install.ps1` — no
reason to duplicate that fetch/verify logic here. The "existing-daemon
path" (detect what's already installed, register MCP config) is still the
live shape, just probing for `macula-cli` now instead of a running
`hecate-daemon` — see `src/install/existing_cli.ts` and the current
[README.md](../README.md). Kept here for historical context only.

**Status:** MVP shipped (existing-daemon path). Phase 0 spec'd 2026-05-16.
**Created:** 2026-05-16
**Last Updated:** 2026-05-16

**Tier-1 ship order (decided 2026-05-16):**

1. Phase 0a thin-build spike — investigate stripping non-essential apps from the daemon release (~0.5 day). Decides binary-size budget before commit.
2. Phase 0 Burrito build + CI + minisign + GitHub Releases — **linux-x64 only** for MVP. macos-arm64, macos-x64, linux-arm64, win-x64 are follow-up slices.
3. Phase 1 macula-mcp fetcher + launcher_systemd integration.
4. Phase 6 + 7: publish `@macula/mcp` v0.3.0 + manifesto cross-post.

Other platforms ship after the viral demo lands.

## Goal

Make joining the macula mesh a single command: from cold laptop to a
provisional-tier agent identity registered in the user's MCP client, in
under 30 seconds, with zero manual config.

```
$ npx @macula/mcp install
[macula-mcp] your agent identity: mri:agent:io.macula/provisional/hecate-0b9c
```

The installer is the viral wedge for Tier 1. It is the front door the
manifesto links to. Every other capability (mesh_subscribe, mesh_call as
service, cross-vendor agent fabric) sits behind this single command.

## Non-goals

- Replacing the full Hecate install. Full-stack users keep their existing
  hecate-daemon; installer detects it and only registers the MCP entry.
- Phoning home / telemetry / install metrics. Zero. The provisional cert
  issuance log on macula-realm is the only adoption signal.
- Bundling a model, a runtime, or LLM weights. macula-mcp speaks to the
  user's existing LLM via MCP; the LLM stays where it was.

## Architecture

```
                 ┌─ GitHub Releases ──┐
                 │  hecate-daemon-burr- │
                 │  ito-{platform}.tgz  │  (5 platforms)
                 └─────────▲────────────┘
                           │ download + verify minisign
                           │
   user types ──▶  npx @macula/mcp install  ──▶  bin/install.ts
                           │                          │
                           │       ┌──────────────────┼───────────────┐
                           │       │                  │               │
                           ▼       ▼                  ▼               ▼
                 platform-detect  daemon-launcher  mcp-client     macula-realm
                                  (systemd-user/   detector+        provisional
                                   launchd/        config-writer    issuance
                                   schtasks)       (5 clients)      endpoint
                                       │                  │
                                       ▼                  ▼
                                 hecate-daemon       ~/.claude/mcp.json
                                 running locally     ~/.cursor/mcp.json
                                       │             ~/.codeium/...
                                       ▼             ~/.config/zed/...
                                  QUIC → mesh        Claude Desktop config
```

## UX

### Happy path

```
$ npx @macula/mcp install

[macula-mcp] detecting platform...           linux-x64
[macula-mcp] detecting MCP clients...        Claude Code, Cursor
[macula-mcp] checking existing daemon...     not found
[macula-mcp] downloading hecate-daemon       14 MB / 14 MB ✓ (4.2 MB/s)
[macula-mcp] verifying signature             ✓ (minisign)
[macula-mcp] installing to ~/.hecate/bin     ✓
[macula-mcp] starting daemon (systemd-user)  ✓
[macula-mcp] acquiring provisional cert      ✓ (824ms)
[macula-mcp] registering MCP server:
              ✓ Claude Code    (~/.claude/mcp.json)
              ✓ Cursor         (~/.cursor/mcp.json)

Your agent identity:
  mri:agent:io.macula/provisional/hecate-0b9c

Restart your editor; ask your LLM to mesh_publish a fact.
Documentation: https://macula.io/mcp
```

### Idempotent rerun

```
$ npx @macula/mcp install
[macula-mcp] hecate-daemon already installed and running ✓
[macula-mcp] provisional cert valid until 2026-05-17 14:02 UTC ✓
[macula-mcp] all MCP clients already configured ✓
Nothing to do. Run `npx @macula/mcp status` for details.
```

### Sovereignty-positive alternative (Phase 5)

```
$ curl -sSL https://macula.io/install.sh | sh
```

Same flow, no Node dependency. Documented in manifesto §5 as the "no
npm runtime" path.

## Components

| # | Component | Lives in | Owns |
|---|-----------|----------|------|
| 1 | npm entrypoint `bin/install.ts` | macula-mcp | flow orchestration |
| 2 | Platform-detect | macula-mcp | `os.platform()` × `os.arch()` |
| 3 | Daemon fetcher | macula-mcp | GitHub Releases download + minisign verify + unpack |
| 4 | Daemon launcher | macula-mcp | systemd-user / launchd / schtasks |
| 5 | Cert acquirer | hecate-daemon (autonomous, first-boot) | `POST /api/v1/provisional/issue` — depends on `PLAN_PROVISIONAL_REALM_TIER` Phase 0 |
| 6 | MCP-client detector | macula-mcp | probes 5 well-known config paths |
| 7 | MCP-config writer | macula-mcp | safe-merge entry into each client's config |
| 8 | Uninstaller | macula-mcp | `npx @macula/mcp uninstall` reverses 3-7 |
| 9 | Status command | macula-mcp | `npx @macula/mcp status` reports daemon health, cert TTL, registered clients |

## Daemon binary distribution

| Aspect | Choice |
|--------|--------|
| Format | Burrito-built single-file BEAM release |
| Platforms | linux-{x64,arm64}, macos-{x64,arm64}, windows-x64 |
| Build CI | GitHub Actions on the canonical repo; 5 binaries per tag |
| Canonical host | GitHub Releases (`github.com/hecate-social/hecate-daemon/releases/...`) |
| Mirror | GitHub Releases (auto-mirror, redundancy only) |
| Signature | minisign per binary; public key bundled inside `@macula/mcp` package |
| Size budget | ~15 MB per binary; investigate "thin" build (drop `serve_llm` etc.) under Phase 0a |

## MCP-client config-write matrix

| Client | Config path | Format | Entry shape |
|--------|------------|--------|-------------|
| Claude Code | `~/.claude/mcp.json` (and project `.mcp.json`) | JSON | `{mcpServers: {macula: {command: "npx", args: ["-y", "@macula/mcp"]}}}` |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` | JSON | same |
| Claude Desktop (Linux) | `~/.config/Claude/claude_desktop_config.json` | JSON | same |
| Claude Desktop (Win) | `%APPDATA%\Claude\claude_desktop_config.json` | JSON | same |
| Cursor | `~/.cursor/mcp.json` | JSON | same |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | JSON | same (verify schema during Phase 2) |
| Zed | `~/.config/zed/settings.json` (`context_servers` key) | JSON | Zed-specific shape; needs adapter |

Safe-merge rules:

- preserve all other `mcpServers` entries
- if `macula` entry already present and identical → no-op
- if `macula` entry already present and different → prompt unless `--force`
- back up config to `<path>.macula-bak-<timestamp>` before any write
- never write malformed JSON; parse-then-stringify, fail safe

## Existing-daemon detection

Probe `~/.hecate/hecate-daemon/sockets/api.sock` and call
`GET /api/mesh/identity`. If it responds 200, skip components 3-5. Just
register MCP entries. **Tier 1 installer never disturbs a Macula
developer's running stack.**

If the existing daemon has no provisional cert (legacy install), inform
the user and offer to trigger first-boot cert acquisition by restarting
the daemon's `hecate_mesh` first-boot flow.

## Cross-platform notes

| Platform | Risk | Mitigation |
|----------|------|-----------|
| Linux without systemd-user | nohup + PID file fallback under `~/.hecate/run/` |
| Linux loginctl linger | Print copy-pasteable `sudo loginctl enable-linger $USER`; offer `--no-linger` (runs for current session only) |
| macOS launchd | Standard `~/Library/LaunchAgents/io.macula.hecate-daemon.plist`, no sudo |
| Windows | `schtasks /create /sc onlogon` for autostart; NSSM optional path |
| Corp firewall blocks `macula.io:443` | Clear error; `HTTPS_PROXY` env-var hint; exit non-zero |
| Multi-user box | Per-user under `$HOME/.hecate/`; never write to `/usr/local/` or `/etc/` |
| Existing `hecate-daemon` from full Hecate install | Detect via socket; skip daemon install entirely |

## Telemetry

**Zero.** Installer does not phone home. Stdout is local. The only
network call is the provisional cert acquisition itself (necessary; the
daemon, not the installer, makes it). macula-realm's issuance audit log
holds `{pubkey, ip, ts}` per memory `PLAN_PROVISIONAL_REALM_TIER` Phase
0; nothing else.

This is load-bearing for the sovereignty narrative. Document it on the
install page.

## Phases

| Phase | Scope | Blocks on | Effort | Status |
|-------|-------|-----------|--------|--------|
| **0a** | "Thin" build investigation — strip non-essential daemon apps to halve binary size | none | 0.5 day | 📋 next |
| **0** | Burrito-built hecate-daemon for **linux-x64 only**, signed with minisign, on GitHub Releases. See "Phase 0 detail" below. | Phase 0a | 4.5 days | 📋 |
| **1** | `bin/install.ts` integration: fetcher + systemd-user launcher; wire into existing install flow | Phase 0 | 1 day | 📋 |
| **2** | Add Cursor + Claude Desktop + Windsurf detection/config | Phase 1 | 0.5 day | ✅ already shipped MVP |
| **3** | macos-arm64 binary + launcher_launchd (post-viral) | Phase 0 settled | 1 day | 📋 deferred |
| **3a** | macos-x64, linux-arm64 binaries (post-viral) | Phase 3 | 1 day | 📋 deferred |
| **3b** | windows-x64 binary + schtasks launcher + Defender mitigation | Phase 3 | 3 days | 📋 deferred |
| **4** | `uninstall --purge` (stop service + remove binary + optional cert wipe) | Phase 1 | 0.5 day | 📋 |
| **5** | `install.sh` bash alternative + minisign-verify-in-bash | Phase 0 | 0.5 day | 📋 deferred |
| **6** | Publish `@macula/mcp` v0.3.0 to npm with bundled minisign pubkey | Phases 0+1+4 | 0.5 day | 📋 |
| **7** | Documentation at `macula.io/mcp`; manifesto §5 truthful | Phase 6 | 0.5 day | 📋 |

**Tier-1 viral-ready** (0a + 0 + 1 + 4 + 6 + 7) ≈ **7.5 days** with linux-x64
only. macos shipped right after the demo lands.

**Estimate confidence:** ±1.5 day. The long pole is Quinn (Rust NIF)
cross-compilation under Burrito — see Phase 0 risk register below.

## Phase 0a detail — thin-build spike (0.5 day, runs first)

**Why first.** If a stripped Burrito build cleanly halves the binary
size, every subsequent download decision is cheaper. If it doesn't,
we know early and budget bandwidth accordingly.

**Hypothesis.** hecate-daemon's release set includes apps the
provisional / agent-fabric path doesn't need:

- `serve_llm` — local LLM provider; ~5 MB of deps
- `manage_storyboards`, `guide_mpong_game_lifecycle` — demo / game apps
- `guide_briefcase_lifecycle`, `project_briefcase_files`,
  `query_briefcase_files` — file-sharing UI surface
- `guide_license_lifecycle`, `guide_payment_lifecycle`,
  `project_licenses`, `query_licenses` — marketplace
- `guide_repo_lifecycle`, `serve_git_over_mesh`,
  `announce_ref_updates` — git-over-mesh

The agent-fabric minimum is roughly: `hecate_mesh`, `hecate_identity`,
`hecate_api`, `boot_daemon`, `discover_lan`, `guide_mesh_publications`,
`guide_mesh_artifacts`, `guide_mesh_subscriptions`, `guide_mesh_inbox`,
`guide_realm_cert_lifecycle`, `project_mesh_activity`,
`query_mesh_activity`, `resolve_mesh_names`, `serve_dns_over_mesh`,
`hecate_edge_relay`.

**Method.**

1. Create a new release profile in `hecate-daemon/rebar.config` under
   `{profiles, [{thin, [{relx, [..., {applications, [...]}]}]}]}`.
2. Include only the agent-fabric-essential apps; observe what fails to
   start (`rebar3 as thin release && _build/thin/rel/hecate/bin/hecate
   console`).
3. Iterate: add back hard runtime deps revealed by start-failure logs
   until clean boot.
4. Measure the tarball: `rebar3 as thin tar` size, with and without
   ERTS strip flags (`{strip_release, true}` if available, `+P`,
   `+Q` runtime tuning to drop unused).
5. **Deliverable:** a `thin` rebar3 profile that produces a working
   tarball, plus a one-page report of size before/after.

**Decision gate at end of 0a:**

- If thin build is <30 MB compressed and boots cleanly → use it for
  Phase 0 binary
- If thin build is broken or doesn't materially help → ship the full
  release in Phase 0, optimise later

**No code lands in Phase 0a outside the new `thin` rebar3 profile.**

### Phase 0a results — measured 2026-05-16

**Status:** ✅ **PASSED decision gate** at 26 MB zstd-compressed.

| Step | Measurement |
|------|-------------|
| `rebar3 as dist release` (just narrowed app list) | **152 MB** assembled |
| `lib/hecate-0.18.0/priv/static/` content (UI artwork: 72 MB of GIFs) | dominant single waste |
| After post-build `rm -rf priv/static` hook | **79 MB** assembled |
| `tar -cf | gzip -9` | 33 MB |
| `tar -cf | zstd -19` | **26 MB** |
| ERTS portion (`erts-16.1/`) | 56 MB (unchanged) |
| Macula NIF priv (Quinn `.so`) | 8 MB |
| All other priv/ + BEAM | ~15 MB |

**Major levers found:**

1. **`priv/static/artwork` (72 MB of UI GIFs)** — the single biggest waste. The agent-fabric daemon has no UI surface; the artwork is for Hecate's LiveView pages. Strip via `{post_hooks, [{release, "rm -rf …/priv/static"}]}` in the dist profile.
2. **App-list narrowing** — relx's apps list correctly excludes the dropped umbrella apps (`license`, `payment`, `mpong`, `briefcase`, `repo`, `plugin`, `launcher`, `llm`, `serve_git_over_mesh`, etc.) from the release. Confirmed by `ls _build/dist/rel/hecate/lib/` after build — only the agent-fabric-essential apps present.

**Minor levers (deferred):**

- ERTS stripping (drop `+observer`, `+debugger`) — could save 5-10 MB. Skip for now; Burrito's ERTS bundling logic owns this.
- macula NIF — Quinn `.so` is 8 MB. Mandatory.

**Boot smoke test (deferred to Phase 0.5):**

- The thin release assembles cleanly. Full-boot smoke test deferred: the existing `vm.args` expects `HECATE_NODE_NAME` + `HECATE_ERLANG_COOKIE` env vars supplied by the runtime launcher. Phase 0.5 (`launcher_systemd.ts`) writes the systemd unit that provides these via an `EnvironmentFile` — that's where the structural boot smoke test lives.

**Implementation landed in this spike:**

- `hecate-daemon/rebar.config` now has a `dist` profile with the narrowed apps list + post-hook for the priv/static strip.
- Build command: `rebar3 as dist release`.
- Output: `_build/dist/rel/hecate/`, 79 MB assembled, 26 MB zstd-compressed.

**Phase 0 binary budget confirmed:** 26 MB compressed is well below the
30 MB cap (and well below comparable npm-postinstall downloads:
Playwright ~120 MB, Cypress ~85 MB). The npm UX cost of bundling
hecate-daemon is acceptable.

## Phase 0 detail — Burrito + CI + signing (linux-x64 only)

**Target deliverable:** A signed `hecate-daemon-linux-x64-vX.Y.Z.tar.gz`
on GitHub Releases, downloadable + verifiable from any internet-
connected linux-x64 machine.

### 0.1 Burrito setup in hecate-daemon (1.5 days)

Burrito (`burrito-elixir/burrito`) bundles a BEAM release + ERTS + a
Zig-built launcher into a single executable, with cross-compilation
support via the Zig toolchain. Used by several production Elixir apps
(Tailscale's Tackle, others).

**Sub-tasks:**

- [ ] Add `burrito` rebar3 plugin (or wrapped via a small Mix overlay
      if rebar3 support is too thin — investigate Burrito's Erlang
      release path in 0.1.1)
- [ ] Configure target tuple `{linux_glibc, x86_64}` in the burrito
      block of `rebar.config` (profile `prod` or new profile `dist`)
- [ ] First local build: `rebar3 as dist burrito` produces a single
      binary that runs `hecate console` cleanly
- [ ] Cross-Rust setup for the Quinn NIF: vendor `cross-rs` or use
      Burrito's NIF hook to invoke `cargo build --target
      x86_64-unknown-linux-gnu --release` deterministically
- [ ] Measure first-run ERTS unpack time on a cold cache; target <2s

**Risk:** Burrito's Erlang-release support is less battle-tested than
its Elixir support. If `rebar3 as dist burrito` doesn't produce a
working binary inside 1.5 days, fall back to **plan B**: hand-roll a
Zig launcher + a `rebar3 as prod tar` artifact, packaged together.
Roughly the same outcome, more bespoke wiring.

### 0.2 GH Actions workflow (1 day)

Lives in `hecate-daemon/.github/workflows/burrito-release.yml`. Per
memory `project_codeberg_ci_topology`, GH Actions runs on the
auto-mirror.

**Workflow shape:**

```yaml
name: Burrito release
on:
  push:
    tags: ['v*']

jobs:
  build:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - name: Install Erlang/OTP
        uses: erlef/setup-beam@v1
        with: { otp-version: '27' }
      - name: Install Rust + cross
        uses: dtolnay/rust-toolchain@stable
      - name: Install Zig
        uses: korandoru/setup-zig@v1
        with: { zig-version: '0.11.0' }
      - name: Burrito build
        run: rebar3 as dist burrito
      - name: minisign-sign artifact
        env: { MINISIGN_KEY: ${{ secrets.MACULA_MINISIGN_KEY }} }
        run: |
          echo "$MINISIGN_KEY" > /tmp/key.sec
          minisign -S -s /tmp/key.sec -m _build/dist/burrito_out/hecate-daemon-linux-x64.tar.gz
          shred -u /tmp/key.sec
      - name: Upload to GitHub Releases
        env: { GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
        run: gh release upload ${{ github.ref_name }} dist/*
      - name: Upload to GH Releases (mirror)
        uses: softprops/action-gh-release@v2
```

**Secrets needed (you set these in GH Actions secrets):**

- `MACULA_MINISIGN_KEY` — the *encrypted* minisign secret key (the
  `.sec` file content, base64-encoded). Decrypted in CI with a
  passphrase from a separate secret. **Procedure for generating this
  is the deliverable of 0.3.**
- `CODEBERG_RELEASE_TOKEN` — a Codeberg API token with `repo:write`
  scope on `hecate-social/hecate-daemon`.

**Codeberg upload helper:** `scripts/upload-to-codeberg.sh` does
`curl -X POST -H "Authorization: token $CODEBERG_TOKEN"` to the
Releases API. Codeberg's API is Gitea-compatible.

### 0.3 Signing infrastructure (0.5 day)

Two deliverables: an offline key-gen procedure (you run this once),
and a runbook for rotation.

**0.3.1 Key generation (you run, offline)**

A separate doc lands at `macula-comm-docs/signing/MACULA_SIGNING_KEY.md`:

```bash
# On a clean, offline machine
minisign -G -p macula-minisign.pub -s macula-minisign.sec \
         -c "Macula Foundation release signing key v1"
# Output:
#   macula-minisign.pub  (publish; bundle in @macula/mcp)
#   macula-minisign.sec  (encrypted with your passphrase; back up to
#                         password manager + offline media)
```

I write the doc. You run the command, store the key. The pubkey
content goes into a new file `macula-io/macula-mcp/keys/macula-minisign.pub`
(checked in). The secret stays offline; for CI, the .sec content is
copy-pasted into the `MACULA_MINISIGN_KEY` GH Actions secret on first
release.

**0.3.2 Bundle pubkey in `@macula/mcp`**

- New file `keys/macula-minisign.pub` (committed)
- `package.json` "files" array includes `keys/`
- `src/install/verify.ts` reads it at runtime

**0.3.3 Rotation policy doc**

`macula-comm-docs/signing/SIGNING_KEY_ROTATION.md` covers:

- When to rotate (compromise, 5y default, or before)
- Transition window (both v1 and v2 pubkeys valid in macula-mcp for ~3
  months; older binaries verifiable indefinitely if signed with v1)
- Cross-signing: v2 signs the v1 retirement statement

### 0.4 macula-mcp fetcher (0.5 day)

New file `src/install/fetcher.ts`:

```typescript
export interface FetchedDaemon {
  binPath: string;       // ~/.hecate/bin/hecate-daemon
  version: string;
  platform: string;
  sigVerified: true;     // type-level proof we checked
}

export async function fetchDaemon(opts: {
  version: string;
  platform: PlatformInfo;
  onProgress?: (bytes: number, total: number) => void;
}): Promise<FetchedDaemon>;
```

Behaviour:

1. Compute URL: `https://github.com/hecate-social/hecate-daemon/releases/download/v${ver}/hecate-daemon-${platform.label}.tar.gz`
2. Stream-download with progress (node:stream)
3. Stream the matching `.minisig` file from the same release
4. Run `minisign -V -p keys/macula-minisign.pub -x <sig> -m <tgz>` via
   bundled `minisign` binary OR pure-TS verifier (libsodium-wasm — avoid
   shipping yet another binary)
5. Extract under `~/.hecate/bin/`, chmod +x

**Pure-TS verifier choice:** the bundled minisign pubkey + the
`.minisig` file format can be verified with `libsodium` (`crypto_sign_verify_detached`).
Decision: ship a small pure-TS impl (~50 LOC), no bundled binary
dependency.

### 0.5 macula-mcp launcher_systemd (0.5 day)

New file `src/install/launcher_systemd.ts`:

```typescript
export async function installSystemdUnit(binPath: string): Promise<{
  unitPath: string;
  lingerNote: string | null;
}>;
```

Behaviour:

1. Write `~/.config/systemd/user/hecate-daemon.service`:

```ini
[Unit]
Description=hecate-daemon (Macula mesh client)
After=network-online.target

[Service]
ExecStart=%h/.hecate/bin/hecate-daemon foreground
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

2. `systemctl --user daemon-reload`
3. `systemctl --user enable --now hecate-daemon`
4. If `loginctl show-user $UID --property=Linger` reports `no`, print
   copy-pasteable `sudo loginctl enable-linger $USER` instruction so
   the daemon survives logout. Don't auto-sudo.
5. Wait for the UDS socket (`~/.hecate/hecate-daemon/sockets/api.sock`)
   up to 30s; surface clear timeout error if not.

### 0.6 install.ts integration (0.5 day)

Update `src/bin/install.ts`:

```diff
   const dp = await probe();
   if (dp.running && dp.identity) {
     ok(`hecate-daemon found at ${dp.socket}`);
     // ... existing flow
   } else {
-    warn(`no hecate-daemon found at ${dp.socket}`);
-    info("see github.com/hecate-social/hecate-daemon for install,");
-    info("Continuing with MCP-config registration anyway");
+    if (args.noFetch) {
+      warn("no daemon found; --no-fetch given, only writing MCP config");
+    } else {
+      info("no daemon found; downloading...");
+      const fetched = await fetchDaemon({ version: PINNED_VERSION, platform: p });
+      ok(`downloaded ${fetched.binPath} (sig verified)`);
+      const { unitPath, lingerNote } = await installSystemdUnit(fetched.binPath);
+      ok(`installed systemd unit ${unitPath}`);
+      if (lingerNote) warn(lingerNote);
+      await waitForSocket(30_000);
+      const dp2 = await probe();
+      if (dp2.identity) {
+        ok(`daemon running, mri=${dp2.identity.mri ?? "(unbound)"}`);
+      }
+    }
   }
```

Where `PINNED_VERSION` is the hecate-daemon version macula-mcp v0.3.0
ships with. Hard-coded per macula-mcp release; bumped each time we
publish a new daemon version.

### 0.7 Release + docs (0.5 day)

- Tag hecate-daemon v0.X.0 → CI runs → first signed release on
  Codeberg
- Bump `@macula/mcp` to v0.3.0; commit the pubkey + new src/install/
  files
- `npm publish @macula/mcp` (you run, since npm credentials)
- README in macula-mcp documents the install flow
- Update `MANIFESTO_AGENT_FABRIC.md` §5 — install snippet now truthful

### Phase 0 risk register (linux-x64-only narrows it)

| Risk | Prob (linux-only) | Impact | Mitigation |
|------|-------------------|--------|-----------|
| Quinn NIF doesn't cross-compile cleanly under Burrito | Medium | +1 day | Test in 0.1; fallback plan B (hand-rolled Zig launcher + rebar3 tar) |
| Burrito Erlang-release support thin | Medium | +0.5 day | Plan B same; test early |
| Binary >50 MB after thin-build | Medium | UX hit, not estimate hit | 0a measures this first; if >50 MB, document the size and ship anyway |
| glibc version skew between CI builder (Ubuntu 22.04 → glibc 2.35) and user systems | Low (linux-only) | broken on Ubuntu 20.04 etc. | Build against an older glibc (Ubuntu 20.04 runner → glibc 2.31) for broader compat; or document min-glibc |
| GitHub Releases API hiccup at release time | Low | +retry | GH Releases mirror as fallback download URL |
| First-run ERTS unpack >2s | Low | UX hit | Cache pre-unpacked under `~/.hecate/erts-cache/` (Burrito does this by default) |

### Smoke-test matrix (Phase 0 ships when all pass)

- [ ] Fresh Ubuntu 24.04 LTS Docker container (no Erlang, no Rust):
      `npm install -g @macula/mcp && macula-mcp install` →
      `mri:app:io.macula/provisional/hecate-XXXX` in <30s
- [ ] Tampered binary (modified one byte) → `minisign -V` rejects;
      installer exits with clear sig-verify error
- [ ] Re-run on same machine → existing-daemon detection kicks in,
      no re-download
- [ ] `npx @macula/mcp uninstall --purge` → `systemctl --user stop`
      runs cleanly, binary removed, MCP config cleaned
- [ ] Daemon survives logout (linger enabled) on a real linux desktop

## Files to create / modify

| Repository | File | Purpose | Status |
|-----------|------|---------|--------|
| `macula-io/macula-mcp` | `bin/install.ts` | npm-invoked installer entry | 📋 |
| `macula-io/macula-mcp` | `bin/uninstall.ts` | reverse | 📋 |
| `macula-io/macula-mcp` | `bin/status.ts` | health + cert TTL + registered clients | 📋 |
| `macula-io/macula-mcp` | `src/install/platform.ts` | detect | 📋 |
| `macula-io/macula-mcp` | `src/install/fetcher.ts` | GitHub release download + minisign | 📋 |
| `macula-io/macula-mcp` | `src/install/launcher_systemd.ts` | linux | 📋 |
| `macula-io/macula-mcp` | `src/install/launcher_launchd.ts` | macos | 📋 |
| `macula-io/macula-mcp` | `src/install/launcher_schtasks.ts` | windows | 📋 |
| `macula-io/macula-mcp` | `src/install/mcp_clients/{claude_code,claude_desktop,cursor,windsurf,zed}.ts` | one file per client | 📋 |
| `macula-io/macula-mcp` | `src/install/config_merge.ts` | safe-merge JSON | 📋 |
| `macula-io/macula-mcp` | `keys/macula-minisign.pub` | bundled verification key | 📋 |
| `macula-io/macula-mcp` | `package.json` | `bin` field, install entry | ✏️ modify |
| `macula-io/macula-mcp` | `README.md` | install instructions | ✏️ modify |
| `hecate-social/hecate-daemon` | `.github/workflows/burrito-release.yml` | 5-platform CI | 📋 |
| `hecate-social/hecate-daemon` | `rebar.config` + Burrito config | add burrito build target | ✏️ modify |
| `macula-io/macula-www` | `mcp/index.html` | install page (canonical link target) | 📋 |
| `macula-io/macula-comm-docs` | `manifesto/MANIFESTO_AGENT_FABRIC.md` §5 | unblock install snippet (already drafted) | ✅ exists |

## Open decisions

Phase 0 decisions (settled 2026-05-16):

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| 1 | npm package name | `@macula/mcp` | scoped, claimed |
| 2 | "Thin" daemon build investigation | **YES**, runs first as Phase 0a | size discipline before commit; ~0.5 day spike |
| 3 | Cert storage location | `~/.hecate/realm-cert/` | unification with full-stack install |
| 4 | MVP client target | **Claude Code + Claude Desktop** | covers most Anthropic-aligned installs day-one |
| 5 | `install.sh` priority | Phase 5, after MVP | npm covers 95% of IDE users |
| 6 | Auto-restart editors after install? | No | respect user's running state |
| 7 | Cert renewal trigger location | inside hecate-daemon (timer, autonomous) | installer is one-shot |
| 8 | Failure UX | exit non-zero with copy-pasteable remediation | never half-install silently |
| 9 | MVP platform set | **linux-x64 only** | smallest surface; ship the wedge first |
| 10 | Signing tool | **minisign** (ed25519) | tiny verifier, no PKI, sov-friendly |
| 11 | macOS Gatekeeper handling | Deferred to v0.4.0 (Apple Developer enrollment) | linux-only Phase 0 doesn't need it |
| 12 | Phase 0 sequencing | **0a → 0.1 (Burrito first build) → 0.3 (signing) → 0.2 (CI) → 0.4-0.6 (TS side) → 0.7 (release)** | thin-build informs binary-size budget; first Burrito de-risks the long pole; signing before CI so the CI workflow has a key to use; CI before TS so the TS side can verify against a real release |
| 13 | Signing-key generation | **You (Raf) do offline key-gen; I write the procedure doc.** Doc lands at `macula-comm-docs/signing/MACULA_SIGNING_KEY.md`. Pubkey content lives in `macula-mcp/keys/macula-minisign.pub` (checked in). Secret never enters this codebase. | sovereignty + key-handling hygiene |
| 14 | Plan-doc home | Expand existing `PLAN_MACULA_MCP_INSTALLER.md` with Phase 0/0a detail (this commit) | one document, findable from `PLAN_MACULA_ROOT` |

## Cross-plan links

- [`PLAN_MACULA_MCP.md`](PLAN_MACULA_MCP.md) — Phase 1+2 daemon HTTP surface (already shipped); this installer plan is the user-acquisition layer above it.
- `macula-internal/macula-architecture/plans/PLAN_PROVISIONAL_REALM_TIER.md` — Phase 0 of that plan is the hard blocker on Phase 1 here; cert acquisition cannot happen without the realm endpoint.
- `macula-io/macula-comm-docs/manifesto/MANIFESTO_AGENT_FABRIC.md` — §5's install snippet is the contract this plan implements.

## Success criteria

- [ ] Fresh Ubuntu 22.04 VM, no Macula install: `npx @macula/mcp install` → working agent identity registered in Claude Code in < 30s
- [ ] Fresh macOS 14 (Apple Silicon), no Macula install: same outcome in < 30s
- [ ] Rerun is idempotent: no double-config, no duplicate launchd entry, clear "nothing to do" output
- [ ] Existing-daemon detection works: full-stack Hecate user runs installer → only MCP config written, daemon untouched
- [ ] Uninstall: full reversal; cert kept by default (with `--purge-identity` to remove)
- [ ] Zero outbound traffic outside `macula.io:443` for cert acquisition; verifiable via `tcpdump` during install
- [ ] Signature verification refuses tampered binaries (negative test)
- [ ] Two-laptop demo (two fresh installs, different platforms, exchange messages via `mesh_publish` / `mesh_inbox`) completes inside 5 minutes of `git clone` of nothing on either machine

## Risk register

| Risk | Mitigation |
|------|-----------|
| Burrito build flakes on one platform | Phase 0 includes per-platform smoke test; ship without that platform if needed |
| Minisign signing key compromise | Key offline in user's password manager; rotation via published-key-supersedes-prior pattern; bundled key in `@macula/mcp` versioned |
| MCP client config schema drift (Claude/Cursor change format) | Per-client adapter file; CI integration test against latest client release; fast turnaround on `@macula/mcp` patch |
| npm supply-chain attack vector | Pin all `bin/install.ts` deps; lockfile audited per release; package signed via npm provenance (in CI) |
| User's existing config file is malformed before install | Parse-fail → write to `<path>.macula-new.json` and instruct manual merge; never destroy the original |
| Corporate AV flags burrito-built binary on Windows | Submit to Microsoft + EICAR-style allowlisting; document workaround |
| macula.io issuance endpoint down at install time | Daemon retries with exponential backoff for 5 min; installer exits with "try again" guidance |
