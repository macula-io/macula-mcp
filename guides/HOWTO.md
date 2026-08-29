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
you), install `macula-cli` if it isn't already on `PATH`, `npm install -g
@macula/mcp`, then run `macula-mcp-install` to register with every detected
MCP client.

| Env var | Effect |
|---|---|
| `MACULA_MCP_VERSION` | Pin a version (e.g. `0.3.0`) instead of latest. |
| `MACULA_MCP_SKIP_CLI_INSTALL` | Don't touch `macula-cli` at all — use this if you're managing its version yourself. |
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
@macula/mcp`. **Does not touch `macula-cli`** — that's a separate concern
with its own [install/uninstall](https://github.com/macula-io/macula-cli).

### Troubleshooting the install

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

### `mesh_publish`

One-shot: connects, publishes, exits. No delivery confirmation beyond the
send succeeding (PUBLISH has no ack on this wire protocol).

```json
{ "topic": "macula_mcp.smoketest", "seq": 1788005387052, "duration_ms": 158 }
```

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
any other tool call sharing the default identity while a watch is in
flight would silently kill the watcher's connection the moment it fired.
Fixed by giving `mesh_watch` its own persisted identity
(`~/.macula-mcp/watch-identity.seed`, or `%USERPROFILE%\.macula-mcp\
watch-identity.seed` on Windows — override with
`MACULA_MCP_WATCH_IDENTITY`). **Two concurrent `mesh_watch` calls would
still collide with each other** — not solved, a known limitation, not a
silent one.

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

---

## 3. Resources

### `mesh://identity`

```json
{
  "node_id": "7facb3bdbf646393c3177fbf84b3d83dd2e5dce81235966bf8a5ae38e0ec7b47",
  "path": "/home/user/.config/macula-cli/identity.seed",
  "generated": false
}
```

This is `macula-cli`'s own default identity (the one `mesh_call`/
`mesh_publish`/`mesh_put`/`mesh_get` use) — not the same file as
`mesh_watch`'s dedicated one, see above.

---

## 4. A note for anyone extending this server

The argv-ordering gotcha bit this repo's own code once, not just users of
it: `src/macula_cli.ts` originally appended `--json` at the END of the
argv (after positional host/procedure arguments), which Go's `flag`
package silently treats as an extra positional rather than a flag — every
tool call failed with a usage error until this was caught running the
built server for real against a live `macula-cli`, not just via
`tsc --noEmit`. Fixed with one `argv()` helper (subcommand words, then
`--json` + other flags, then positionals, always) that every operation in
`macula_cli.ts` goes through — if you add a new operation, use it rather
than building the argv by hand.

---

## 5. See also

- [`README.md`](../README.md) — what macula-mcp is, architecture, tool/resource tables, status
- [`macula-io/macula-cli`](https://github.com/macula-io/macula-cli)'s own [HOW-TO guide](https://github.com/macula-io/macula-cli/blob/master/guides/HOWTO.md) — the identity-collision and argv-ordering gotchas were both found and documented there first
- [`macula-io/macula-station`](https://github.com/macula-io/macula-station)'s `docs/` — real production incidents, useful context for what a tool-call failure might mean station-side
