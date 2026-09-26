# Contributing to macula-mcp

## Setup

```bash
npm ci
```

Node >=24.18.1 (matches `engines` in `package.json` and what CI pins). If your
own machine runs a newer Node than that, see
[the native-dependency gotcha](#native-dependencies) before adding one.

This package ships zero lifecycle scripts of its own (no `postinstall`,
nothing else in `package.json`'s `scripts` that npm runs automatically) —
`npm ci`/`npm install` here just install dependencies, nothing more.

## Build, typecheck, test

```bash
npm run typecheck   # tsc --noEmit
npm run build        # tsc
npm test             # vitest run
```

All three run in CI (`.github/workflows/ci.yml`) on every push to `main`
and every PR, on Node 24.20.0. `install.sh`/`uninstall.sh` are also
shellchecked, and `install.ps1`/`uninstall.ps1` are parse-checked with
PowerShell's own parser — touch either pair and expect those jobs to run
too.

## Verify against the real mesh, not just the test suite

CI's `test` job is deliberately offline-only (see its own comment in
`ci.yml`): every tool here talks to the mesh in-process via
`@macula-io/ts` (`macula_ts_client.ts`), which the test suite mocks at
that module boundary where it's tested at all (`mesh_stations.test.ts`,
`mesh_memory.test.ts`, `rooms.test.ts`, `citizenship.test.ts`,
`presence.test.ts`, `ring_service.test.ts`, `serve.test.ts`, `mesh_call.test.ts`
— see any of those for the pattern), and `macula_ts_client.test.ts` tests the
client layer itself against a fake `Pool`. That means `npm test` passing does
not confirm a tool actually works against a real station.

If your change touches what a tool actually does against the mesh
(not just how its output is parsed), verify it for real before calling
it done: `npm run build`, then `node scripts/fleet-live-check.mjs`, which
runs two throwaway agents through the compiled tool handlers against the
fleet (`MACULA_MESH_STATIONS` picks other stations). The fleet is shared
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

**Talking to the mesh: always go through `macula_ts_client.ts`, never
touch `@macula-io/ts`'s `Pool`/`NodeKey` directly from a tool file.**
There is one pool and one key per process, shared by every tool;
`macula_ts_client.ts` owns both, maps every mesh error onto `MeshError`
with its code, and refuses what the wire cannot carry (booleans) before
anything is sent. If you add a new operation, add it there, next to the
existing ones.

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
