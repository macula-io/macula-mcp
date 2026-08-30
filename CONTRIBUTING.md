# Contributing to macula-mcp

## Setup

```bash
npm ci
```

Node >=20 (matches `engines` in `package.json` and what CI pins). If your
own machine runs a newer Node than that, see
[the native-dependency gotcha](#native-dependencies) before adding one.

## Build, typecheck, test

```bash
npm run typecheck   # tsc --noEmit
npm run build        # tsc
npm test             # vitest run
```

All three run in CI (`.github/workflows/ci.yml`) on every push to `main`
and every PR, on Node 20. `install.sh`/`uninstall.sh` are also
shellchecked, and `install.ps1`/`uninstall.ps1` are parse-checked with
PowerShell's own parser — touch either pair and expect those jobs to run
too.

## Verify against the real mesh, not just the test suite

CI's `test` job is deliberately offline-only (see its own comment in
`ci.yml`): every tool here shells out to `macula-cli`, which isn't
installed on the runner and shouldn't need to be for a unit-test job.
That means `npm test` passing does not confirm a tool actually works —
it confirms the parsing/wrapping logic around `macula-cli`'s output is
correct.

If your change touches what a tool actually does against the mesh
(not just how its output is parsed), verify it for real before calling
it done: build the server, connect a real MCP `Client` to it (or run it
through an actual agent harness), and call the tool against a live
station. `MACULA_MESH_STATION` defaults to a public demo fleet
(`station-de-frankfurt.macula.io:4433`) — treat it as shared
infrastructure, not a sandbox (see `mesh://etiquette` for the norms that
apply to anything you publish or call while testing).

## Native dependencies

`npm install`/`npm ci` only *warn* on an `engines` mismatch, they don't
fail the install — so a native dependency (a compiled binding, not pure
JS) can resolve to a version that requires a newer Node than CI actually
pins, pass every check on your own machine, and segfault the instant CI
loads it. This has happened once already (`better-sqlite3` 13.x vs. CI's
Node 20, see `CHANGELOG.md`'s `[Unreleased]` entry). Before adding or
upgrading a native dependency, check its own declared `engines.node`
against what `ci.yml` pins, not just what installs cleanly for you
locally.

## Code conventions

**Building `macula-cli` argv: always go through `argv()` in `src/macula_cli.ts`.**
This bit the repo's own code once, not just a hypothetical: an early
version appended `--json` at the END of the argv, after positional
host/procedure arguments. Go's `flag` package stops parsing flags at the
first positional, so that silently misparses `--json` as an extra
positional instead of a flag — every tool call failed with a usage error,
and `tsc --noEmit` had no way to catch it since the bug was in argument
*order*, not shape. Only caught running the built server for real against
a live `macula-cli` (see "Verify against the real mesh" above). Fixed
with one `argv()` helper (subcommand words, then `--json` and other
flags, then positionals, always) that every operation in `macula_cli.ts`
goes through. If you add a new operation, use it rather than building the
argv by hand.

## Commit messages

Plain quoted strings, not backtick-delimited or HEREDOC'd shell — a
literal backtick or `$(...)` in a commit message passed through a shell
command gets interpreted rather than committed literally.

## Releasing

`.github/workflows/release.yml` publishes to npm on a `v*` tag push, and
only then — pushing to `main` never publishes anything. Before tagging:

1. Bump `version` in `package.json`.
2. Move the `[Unreleased]` section in `CHANGELOG.md` under a new
   `## [X.Y.Z] - YYYY-MM-DD` heading, and add its compare-link footnote.
3. Commit, push, then tag and push the tag:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The release workflow re-runs `typecheck`/`build`/`test` itself (it
triggers off a separate event from the branch-push CI, so there's no
prior run to reuse), confirms the tag's version matches
`package.json`, then publishes via npm's OIDC Trusted Publishing — no
stored `NPM_TOKEN`, no manual `npm publish` needed or wanted.
