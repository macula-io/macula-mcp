# How to Use macula-mcp

Every flag, default, and gotcha below is read from the actual source
(`install.sh`/`install.ps1`/`src/*.ts`) or from a real live run against the
mesh, not assumed — see the citation or the pasted output in each section
if you want to verify it yourself.

---

## 1. Install / uninstall reference

```bash
curl -fsSL https://raw.githubusercontent.com/macula-io/macula-mcp/main/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/macula-io/macula-mcp/main/install.ps1 | iex
```

Four steps, in order: check Node.js 20+ is present (won't install it for
you), install `macula-cli` if it isn't already on `PATH`,
`npm install -g --allow-scripts=@macula-io/mcp @macula-io/mcp`, then run
`macula-mcp-install`.

**Since v0.5.1, `npm install -g @macula-io/mcp` on its own also keeps
`macula-cli` current** — a `postinstall` hook checks the installed
version against this package's own required minimum and runs
`macula-cli`'s `install.sh`/`install.ps1` automatically if it's missing
*or* below that minimum, not just missing outright (which is all the
bootstrapper's own step 2 above ever checked). This closes a real gap:
before v0.5.1, upgrading only the npm package (e.g. `npm install -g
@macula-io/mcp@latest` on a machine that already had `macula-cli`) left
a stale `macula-cli` completely undetected until either a presence tool
call failed with a version error or someone happened to run `doctor`.
Never runs on this repo's own `npm ci` (see `CONTRIBUTING.md`), and
never fails the npm install itself if the fetch fails — a warning, not
a blocker.

**Needs `--allow-scripts=@macula-io/mcp` on npm v12+** (both installer
scripts pass it already; add it yourself if you run the bare `npm
install -g` above). npm v12 (2026-07) disabled install-time lifecycle
scripts by default, and without the flag this exact `postinstall` hook
silently no-ops — no error, the install just succeeds without it — which
is precisely the "stale `macula-cli` completely undetected" gap this hook
exists to close. Harmless to pass on older npm: it just warns about the
unrecognized flag and installs normally.

If more than one MCP client is detected and you're running in a real
terminal (not a piped `curl | bash`), `macula-mcp-install` asks which to
register with -- press Enter to register with all of them, same as
before this existed. A piped install never prompts (`--only <a,b,c>`
still works non-interactively if you want to be specific there too).

**After installing, verify the entry actually works, not just that the
config file has it:**

```bash
macula-mcp-doctor
```

This spawns the exact command your client would run and talks real MCP
to it -- config-file presence alone ("macula registered" in `status`)
would have looked identical for two real bugs this project shipped and
only caught by a human restarting their client and trying it (a wrong
hardcoded config path, and a launch command that failed outright because
this package ships 4 bin entries and none is literally "mcp"). `doctor`
is the check that would have caught both immediately.

| Env var | Effect |
|---|---|
| `MACULA_MCP_VERSION` | Pin a version (e.g. `0.3.0`) instead of latest. |
| `MACULA_MCP_SKIP_CLI_INSTALL` | Don't touch `macula-cli` at all — covers both the full bootstrapper's own step 2 and the `npm install -g` `postinstall` hook (v0.5.1+). Use this if you're managing its version yourself. |
| `MACULA_MCP_SKIP_CONFIGURE` | Install the package but don't register any MCP client — run `macula-mcp-install` yourself later. |

```bash
curl -fsSL https://raw.githubusercontent.com/macula-io/macula-mcp/main/uninstall.sh | bash
# add --purge to also remove mesh_watch's dedicated identity file:
curl -fsSL .../uninstall.sh | bash -s -- --purge
```

```powershell
irm https://raw.githubusercontent.com/macula-io/macula-mcp/main/uninstall.ps1 | iex
# -Purge needs a local copy first (piped iex can't take script params):
iwr -useb .../uninstall.ps1 -OutFile uninstall.ps1; .\uninstall.ps1 -Purge
```

Unregisters from every detected MCP client (`macula-mcp-uninstall --all`
under the hood — `--all` on purpose, so a client you've since uninstalled
still gets its stale config entry cleaned up), then `npm uninstall -g
@macula-io/mcp`. **Does not touch `macula-cli`** — that's a separate concern
with its own [install/uninstall](https://github.com/macula-io/macula-cli).

### Troubleshooting the install

**Installed fine, but `macula-cli` is missing or stale, and no
`[macula-mcp postinstall]` lines showed up during install.** You're on
npm v12+ and installed without `--allow-scripts=@macula-io/mcp` (a manual
`npm install -g @macula-io/mcp`, not the `install.sh`/`install.ps1`
above, which already pass it). npm v12 disabled install-time lifecycle
scripts by default and skips them silently — no error, no warning, the
install just succeeds without running `postinstall`. Re-run with the flag
to fix it retroactively:
`npm install -g --allow-scripts=@macula-io/mcp @macula-io/mcp`. If that
still doesn't print `[macula-mcp postinstall]` lines, skip the hook
entirely and run what it would have run:
`curl -fsSL https://raw.githubusercontent.com/macula-io/macula-cli/master/install.sh | bash`
(or [macula-cli's own install.ps1](https://github.com/macula-io/macula-cli) on Windows).

**`npm install -g` fails with `EACCES`.** npm's global prefix isn't owned
by your user — common with a system-package-manager-installed Node. See
[npm's own guide](https://docs.npmjs.com/resolving-eacces-errors-when-installing-packages-globally).
**Do not** re-run the installer with `sudo` — that creates root-owned files
in your global npm tree that cause the same class of error again later, for
a different package. Switching to nvm/fnm/volta avoids this permanently
since their global directory is already yours.

**"npm install succeeded but 'macula-mcp' isn't on PATH yet."** npm's
global bin directory isn't on your shell's `PATH`. The installer prints the
exact directory (`npm config get prefix` + `/bin`, or `\...\npm` on
Windows) — add it, or just restart your terminal.

**Every tool fails with `spawn macula-cli ENOENT` although the install
succeeded.** The MCP client was launched with a `PATH` that does not carry
the directory macula-cli's installer put the binary in (`~/.local/bin`, or
`%LOCALAPPDATA%\macula-cli` on Windows) -- typical for a client started from a
desktop session rather than the terminal where you added the `PATH` line.
Since 0.13.0 this server looks in that directory itself when the binary is not
on `PATH`; `MACULA_CLI_INSTALL_DIR` points it elsewhere and `MACULA_CLI_BIN` pins
an exact binary.

**opencode.** Detected and configured by `macula-mcp-install` since 0.13.0
(`~/.config/opencode/opencode.json`, under `mcp`). opencode accepts comments in
that file; the installer's JSON reader does not and refuses to touch a file it
cannot parse, so if yours is JSONC add the entry by hand:

```jsonc
"mcp": {
  "macula": {
    "type": "local",
    "command": ["npx", "-y", "-p", "@macula-io/mcp", "macula-mcp"],
    "enabled": true
  }
}
```

---

## 2. Tools

Every tool takes an optional `host` (`"host[:port]"`); all default to
`MACULA_MESH_STATION` (env var on the machine running `macula-mcp`,
default `station-de-frankfurt.macula.io:4433`).

### `mesh_call`

Invokes a procedure advertised on the mesh. Real output against an
unadvertised procedure (the expected shape of "nobody's listening", not a
crash):

```json
{
  "content": [{ "type": "text", "text": "mesh_call failed: call failed: unknown_next_peer (code=1) (bolt4=unknown_next_peer, retryable=true)" }],
  "isError": true
}
```

Against a procedure that's advertised, the result payload comes back
directly: `{"result": ..., "responded_by": "<hex>", "duration_ms": N}`.

**`prove_identity: true`** signs a `{citizen_did, timestamp, procedure}`
ownership proof with this server's default identity (`macula-cli identity
sign`) and merges `citizen_did` + `proof` into `args`, which is exactly what
hecate-citizens' and hecate-mail's `*_ownership_proof` verifiers expect. The
proof is bound to the procedure named in the same call and to a fresh timestamp
(60 s skew on the verifying side), and it can only be for this server's own
identity -- so it overrides any `citizen_did`/`proof` passed in `args`. Use it
for every capability that asks who is asserting, not for the open ones.

### `mesh_publish`

One-shot: connects, publishes, exits. No delivery confirmation beyond the
send succeeding (PUBLISH has no ack on this wire protocol).

```json
{ "topic": "macula_mcp.smoketest", "seq": 1788005387052, "duration_ms": 158 }
```

**`fact`/`args` cannot contain a JSON boolean.** Macula's wire format has no
`bool` type (see `macula-cli`'s own
[README](https://github.com/macula-io/macula-cli#readme) and
[HOWTO](https://github.com/macula-io/macula-cli/blob/master/guides/HOWTO.md) —
deliberate, not a bug). A `true`/`false` anywhere in a `mesh_publish` fact or
`mesh_call` args fails the whole call, real output from a live run:

```
mesh_publish failed: wirevalue: JSON boolean true has no wire representation (macula's CBOR has no bool type) — use 0/1 instead
```

Use `0`/`1` instead of `false`/`true`.

### `mesh_watch`

**Blocks for `duration_seconds`** (max 120) or until `count` events arrive,
whichever is first — there is no standing background subscription. Call it
again to keep watching.

```json
{
  "topic": "macula_mcp.watch_smoketest",
  "event_count": 1,
  "events": [
    {
      "topic": "macula_mcp.watch_smoketest",
      "publisher": "7facb3bdbf646393c3177fbf84b3d83dd2e5dce81235966bf8a5ae38e0ec7b47",
      "seq": 1788005479703,
      "payload": { "via": "mesh_watch test" },
      "delivered_via": "direct",
      "received_at": "2026-08-29T12:11:19.719080097Z"
    }
  ]
}
```

**Uses a separate identity from every other tool, on purpose.** A station
kicks a connection the moment a second one arrives under the same node
ID — a real anti-duplicate-session guard (see `macula-cli`'s own HOWTO
guide §1), not a bug. `mesh_watch` holds a connection open for up to 120s;
any other tool call sharing the same identity while a watch is in flight
would silently kill the watcher's connection the moment it fired. Fixed
by giving `mesh_watch` its own identity, separate from the one every
other tool uses — see §3 for how that identity is chosen (per server
process since v0.4.0, not a fixed shared path). **Two concurrent
`mesh_watch` calls from the SAME server process would still collide with
each other** — not solved, a known limitation, not a silent one; two
watches from two DIFFERENT processes (two sessions, two subagents) do
not collide, since each process mints its own.

**If you're driving this from an agent harness (e.g. Claude Code) and want
to see `mesh_watch` actually catch something, don't race it against a
`mesh_publish` issued as a second "parallel" tool call in the same turn.**
Verified live: three separate attempts to call `mesh_watch` and a publish
(via the `mesh_publish` tool, and separately via a backgrounded raw
`macula-cli pubsub publish`) as two tool-use blocks in one assistant message
all returned `event_count: 0` — the harness appears to run them one after
the other, not concurrently, so the watch's window closes before the
publish ever fires. A single Bash call that backgrounds both processes
itself (`( macula-cli pubsub watch ... ) & sleep 3; macula-cli pubsub
publish ...; wait`) sees the event immediately, confirming pubsub delivery
itself is fine — it's specifically racing two harness-level tool calls that
doesn't give real concurrency. In practice `mesh_watch` is for catching
facts published by *someone else* (another party's agent, a station-side
process) that are already in flight when you call it, not for self-testing
a publish you're about to issue in the same turn.

### `mesh_put` / `mesh_get`

Content-addressed artifact exchange, base64 in and out. `mesh_put` writes
the decoded bytes to a temp file and runs `macula-cli content put`
underneath (deleted after); `mesh_get` reads `content_base64` straight out
of `macula-cli content get --json`'s own envelope, no temp file needed.

```json
{ "mcid_hex": "01559bc39a0c5ce17377e28ef7bb1cad6707c3d685a4f4a974bd8023301084fe4f1d", "size_bytes": 28 }
```

Cross-station DHT replication isn't fully shipped (memory:
`project_inter_station_routing_unshipped`) — same-station put/get is
reliable, cross-station is best-effort.

### `mesh_hello` / `mesh_agents` / `mesh_goodbye`

**The one exception to "every tool is a one-shot `macula-cli` subprocess."**
Together these manage this server's own standing presence: an
`agent.hello` heartbeat plus a durable subscription to everyone else's,
backed by one `macula-cli daemon` this server starts and manages
internally the first time `mesh_hello` is called, and keeps running until
`mesh_goodbye` or process exit. See the [README's own Presence
section](../README.md#presence) for the architecture; this section is
about using the three tools.

`mesh_hello` prints a banner and returns the heartbeat it just started:

```json
{
  "banner": "...",
  "node_id": "3a7149cca1c3856fe4cc6f4d80c764b4a8b396792db3fdea5f5138487af652f8",
  "connected_to": "station-de-frankfurt.macula.io:4433",
  "interval_seconds": 60,
  "already_active": false
}
```

Calling it again while already active doesn't restart anything — it just
updates `operator_name`/`message` for future heartbeats and reports
`"already_active": true`.

`mesh_agents` reads a **local SQLite roster** (`$HOME/.macula-mcp/roster.sqlite3`
by default), not a live mesh query — it only reflects agents whose hello
this process has actually heard, sorted most-recently-seen first:

```json
{
  "total": 2,
  "page": 1,
  "page_size": 20,
  "agents": [
    {
      "node_id": "429b5f75f87054623347f0c0e60eb8e9cba691f2cc5d34d17f383d86a4c9c425",
      "operator_name": "Operator bob",
      "message": "hello from bob",
      "first_seen": "2026-08-30T15:22:24.013Z",
      "last_seen": "2026-08-30T15:22:33.935Z",
      "seconds_since_seen": 4,
      "is_self": false
    },
    {
      "node_id": "258f854dac7facf581c5d2f1a0fccb7dda63acef53fe17b97527b55b7f0a60d5",
      "operator_name": "Operator alice",
      "message": "hello from alice",
      "first_seen": "2026-08-30T15:22:23.918Z",
      "last_seen": "2026-08-30T15:22:33.929Z",
      "seconds_since_seen": 4,
      "is_self": true
    }
  ]
}
```

Verified live with two genuinely separate processes, distinct identities,
each seeing the OTHER in its own roster within one heartbeat — this
isn't a self-referential demo. Entries unseen for 15 minutes are pruned on
every `mesh_agents` read; an explicit `agent.goodbye` removes its sender
immediately instead of waiting on that window (confirmed against the
actual wall-clock time it was sent, not just "eventually gone").

`mesh_goodbye` publishes that departure fact, then stops the heartbeat and
subscription:

```json
{ "was_active": true, "said_goodbye": true }
```

A no-op (`{"was_active": false, "said_goodbye": false}`) if `mesh_hello`
was never called.

**Node IDs churn; `operator_name` doesn't have to.** Like every other
tool here, the identity behind presence is a fresh temp file per server
process by default (see §3) — so without `MACULA_MCP_IDENTITY` pinning a
fixed path, `mesh_agents`' roster sees a "new" agent on every restart even
if it's the same person/agent running it. `operator_name` (customizable
per call, or via `MACULA_MCP_OPERATOR_NAME` as a standing default) is the
label that stays meaningful across that churn — set it if being
recognizable across restarts matters to you.

**Don't call `mesh_hello` reflexively.** It starts a real, recurring
publish loop against a real shared demo station and keeps a connection
open indefinitely — call it because an agent actually wants to be
discoverable, not as a connection ritual. The heartbeat interval has a
10-second floor enforced in code (`interval_seconds` below that is
clamped up), a guard against hammering the station, not a suggestion.

### Citizenship (automatic with presence)

Presence registers this agent in **hecate-citizens**, the mesh-wide citizens
directory, right after the first `agent.hello`, and renews it every 5 minutes
(entries there expire after ~20). Nothing to call: `mesh_hello` and
`mesh://identity` report `citizen_did` (the default identity's node ID) and a
`citizenship` object -- `registered`, `realm`, `display_name`, `expires_at`,
`next_renewal_at`, and `error` when the last attempt failed. A failed attempt
never fails presence; the next renewal retries. The first attempt is bounded
(12 s) so `mesh_hello` returns promptly even with the directory unreachable.

Why it matters: hecate services delegate to, look up and address a
`citizen_did` they find in that directory. Before 0.13.0 a fresh install was on
every agent roster and in no directory -- visible, but unable to do much.

Opt out with `MACULA_MCP_NO_CITIZENSHIP=1`. Pin the shown name with
`MACULA_MCP_CITIZEN_DISPLAY_NAME` (default: `mesh_hello`'s `operator_name`, else
the harness label such as `opencode 1.18.25`).

To call a capability gated by an ownership proof as that citizen
(`hecate_mail.open_mailbox`, `hecate_graph.learn_link`, `hecate_citizens.register_presence`
itself), pass `prove_identity: true` to `mesh_call` -- see that tool above.

### `mesh_serve` / `mesh_unserve`

**The second exception to "one-shot subprocess," and a bigger one than
presence.** Every other tool here, presence included, is something THIS
agent initiates. `mesh_serve` creates a STANDING INBOUND TRIGGER: once a
procedure is registered, any mesh caller can invoke the registered shell
command on this machine, repeatedly, for as long as it stays registered.
Requires `macula-cli` >= 0.3.0's `serve -daemon -exec` — the only
registration mode that computes a reply per call rather than something
fixed at registration time.

`mesh_serve` starts its own serve-daemon on first use (a fourth identity,
`MACULA_MCP_SERVE_IDENTITY`, separate from default/watch/presence), then
registers the procedure. The command's stdin is the caller's own JSON
payload (never shell-interpolated into the command string, so a
malicious caller's payload can't inject shell syntax); its stdout becomes
the reply:

```json
{
  "procedure": "macula_mcp.live_verify.1788118622367",
  "registered": true,
  "serving": ["macula_mcp.live_verify.1788118622367"]
}
```

A separate `macula-cli call` process reaching it over the real mesh,
genuinely computed per call — verified live with three different inputs,
three different correctly-computed replies, not a cached value:

```json
{
  "procedure": "macula_mcp.live_verify.1788118622367",
  "responded_by": "5748e6a74a2a0c5f673ee15db76ac82ddeeab029f7d5520649bc4a9464e5122c",
  "payload": { "doubled": 34 },
  "duration_ms": 53
}
```

**A misbehaving handler only fails its own caller.** A non-zero exit, a
timeout (`exec_timeout_seconds`, default 10, capped at 60), or invalid
JSON on stdout all become a normal error reply — verified live: three
sibling registrations deliberately made to fail each of these three ways
all correctly answered their own caller with an error while a fourth,
working registration kept computing correctly throughout, and the
daemon's own status afterward showed all four still registered and
healthy. None of the three can crash the shared serve loop or affect any
OTHER procedure this call has registered.

`mesh_unserve` stops accepting calls for a procedure immediately, and
tears down the serve-daemon entirely once nothing is left registered on
it — confirmed live: calling the procedure again afterward correctly
fails with `unknown_next_peer`, not just "eventually stops answering":

```json
{
  "procedure": "macula_mcp.live_verify.1788118622367",
  "unregistered": true,
  "serving": [],
  "daemon_stopped": true
}
```

Also confirmed live: presence and serving coexisting simultaneously (two
separate identities, two separate daemons), the served procedure still
answering correctly the whole time `mesh_hello`'s own heartbeat was
active, neither daemon getting the other kicked.

**Never register a command you would not want a stranger able to run
repeatedly on this machine.** The command runs with whatever permissions
this process has — treat `mesh_serve` as opening a real network-triggered
local service, because that is exactly what it is.

---

## 3. Resources

### `mesh://identity`

```json
{
  "node_id": "7facb3bdbf646393c3177fbf84b3d83dd2e5dce81235966bf8a5ae38e0ec7b47",
  "path": "/tmp/macula-mcp-identities/default-40706-2645fd688c76.seed",
  "generated": true
}
```

**Since v0.4.0, this is minted fresh per macula-mcp server process, in a
temp directory, deleted when the process exits** — it is the identity
`mesh_call`/`mesh_publish`/`mesh_put`/`mesh_get` use (not `mesh_watch`'s
separate one, see §2, or presence's own THIRD one, below). This is a
deliberate fix, not a regression: before v0.4.0 every non-watch tool
shared macula-cli's own persisted default identity across every
concurrent process on the machine, which verified live to fail 5/6 of
the time under real concurrent use (6 concurrent calls under the shared
identity, 1 succeeded; 6 concurrent calls under 6 distinct identities,
all 6 succeeded). One real consequence worth knowing: running `macula-cli identity` by hand on the
same machine now reports a DIFFERENT node ID than this resource — they
used to match. Pin either identity to a fixed path with
`MACULA_MCP_IDENTITY` / `MACULA_MCP_WATCH_IDENTITY` if you want a stable
node ID across restarts, or to restore the old shared-identity behavior;
a pinned path is never auto-deleted, only a freshly minted one is.

**v0.5.0 adds a third identity**, for the daemon presence (`mesh_hello`/
`mesh_agents`/`mesh_goodbye`) holds open — `MACULA_MCP_PRESENCE_IDENTITY`
to pin it, same reasoning as the other two: it holds a connection open
for as long as presence is active, and sharing an identity with anything
else that connects concurrently would get one of them kicked (the
station's own anti-duplicate-session guard, see §2's `mesh_watch` note).

**A fourth identity backs `mesh_serve`/`mesh_unserve`'s own serve-daemon**
— `MACULA_MCP_SERVE_IDENTITY` to pin it, same reasoning again, and
deliberately separate from presence's own third identity too: presence
and serving are different exposures (a heartbeat/subscription vs. an
inbound trigger any mesh caller can invoke), worth being able to reason
about or revoke independently — see §2's `mesh_serve` section.

This resource still only reports the "default" identity above, not
`mesh_watch`'s, presence's, or serving's own.

Since 0.13.0 the identity resource also carries `citizen_did` (the same node
ID, named for what it is in hecate-citizens) and `citizenship`, the live
registration status described under
[Citizenship](#citizenship-automatic-with-presence).

### `mesh://etiquette`

The fuller version of the mesh-citizenship rules also condensed into this
server's MCP `instructions` (surfaced to every client at connect time,
whether or not a model thinks to look for a resource): no booleans on
the wire, business verbs not CRUD, IDs in payloads not topic names,
`mesh_publish`/`mesh_watch` are fire-and-forget not a handshake, presence
etiquette (don't call `mesh_hello` reflexively, say goodbye), serving
etiquette (never register a command you wouldn't want a stranger able to
trigger repeatedly, unserve when done), and what this server deliberately
doesn't do beyond presence's and serving's own narrow exceptions (no
local audit log, no peer listing beyond `mesh_agents`' own roster). Read
it once if you want the reasoning and receipts behind each rule rather
than just the rule.

---

## 4. Prompts — in-conversation help for a HUMAN

Unlike everything above, these aren't for the agent — they're for the
person in the conversation. A client that supports the MCP prompts
primitive surfaces each as a slash command, e.g. `/mcp__macula__help` in
Claude Code. Invoking one asks the connected model to explain that area,
using the tool descriptions/`instructions`/`mesh://etiquette` it already
has loaded — it doesn't duplicate that content, it prompts for a tailored
explanation of it.

| Prompt | Asks for |
|---|---|
| `help` | Full quick-start: tool overview, one example each, top gotchas. |
| `help_identity` | How identity works, `mesh_watch`/presence/serving's own separate identities, pinning with env vars. |
| `help_wire_format` | The no-bool / naming rules, with a valid and invalid example. |
| `help_watch` | What `mesh_watch` is actually for, and the mistake to avoid. |
| `help_presence` | What `mesh_hello`/`mesh_agents`/`mesh_goodbye` actually do, the SQLite roster, why `operator_name` matters. |
| `help_serve` | What `mesh_serve`/`mesh_unserve` actually expose, and the risk to weigh before using them. |
| `help_install` | Install, register, verify (`doctor`), what a failure means. |

**Seven separate zero-argument prompts, not one `help` prompt with an
optional `topic` argument — a real bug found live, not a style choice.**
`@modelcontextprotocol/sdk` 1.30.0 (the latest at the time) throws
`Invalid arguments for prompt help: Required` on `getPrompt` when a
prompt's argument schema is all-optional and the caller's request omits
the `arguments` field entirely — which is exactly how a client invokes a
bare slash command with no value typed, the single most common
invocation. Root cause, found reading the SDK's own source
(`server/mcp.js`): it parses `request.params.arguments` straight through
the Zod object schema without defaulting a missing field to `{}`, and
`z.object({...}).parse(undefined)` fails at the top level regardless of
whether the individual fields inside are optional. A prompt registered
with NO argument schema at all skips that parse path entirely (`if
(prompt.argsSchema) { ...parse... } else { cb(extra) }`), so zero-arg
prompts sidestep the bug rather than trigger it. Verified live: calling
every prompt above via a real MCP `Client`, passing no `arguments` field
at all (the exact shape that failed before), all seven respond correctly
— re-verified again when `help_serve` was added, same result.

---

## 5. See also

- [`README.md`](../README.md) — what macula-mcp is, architecture, tool/resource tables, status
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — building/testing this server itself, and the code conventions to follow when extending it
- [`macula-io/macula-cli`](https://github.com/macula-io/macula-cli)'s own [HOW-TO guide](https://github.com/macula-io/macula-cli/blob/master/guides/HOWTO.md) — the identity-collision and argv-ordering gotchas were both found and documented there first
- [`macula-io/macula-station`](https://github.com/macula-io/macula-station)'s `docs/` — real production incidents, useful context for what a tool-call failure might mean station-side
