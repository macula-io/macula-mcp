# PLAN: Large-payload mesh calls (args-file, for upload_knowledge et al.)

Status: **Implemented, not yet released.** `macula-cli`'s `-args-file`
flag and `macula-mcp`'s transparent temp-file fallback (`call()` →
`resolveCallArgsFlags`) are both built and tested. What's left: tagging
a `macula-cli` release carrying `-args-file`, then bumping
`MIN_MACULA_CLI_VERSION` in `macula-mcp` to match -- deliberately not
done here, since bumping it first would require a release that doesn't
exist yet.

## Goal

`macula-cli call`'s `-args` flag only accepts an inline JSON string, and
`macula-mcp`'s `call()` always builds one. That's fine for the vast
majority of mesh procedures, but `hecate-rag.upload_knowledge` and
`hecate-rag.add_knowledge` expect a document's raw bytes inline in the
JSON payload — base64-encoded, a real document can be large enough to
exceed a safe command-line length on any platform. This plan makes any
mesh call with a large payload work the same way a small one does,
transparently, without the MCP tool caller needing to know the
difference.

## What's already real (verified against source, not assumed)

- **`macula-cli call -args <json>` is inline-only.** `cmd/macula-cli/call.go`
  defines `-args` as `fs.String("args", "null", ...)` — no file or stdin
  alternative exists for it today.
- **`hecate-rag.upload_knowledge` and `hecate-rag.add_knowledge` expect
  raw bytes in the payload.** `upload_knowledge_v1.erl`'s `raw_bytes`
  field is a required part of the command; the server chunks, embeds,
  and stores it, but the caller still has to get the bytes there in the
  first place.
- **`macula-cli` already has a working file-based pattern for exactly
  this shape of problem.** `content put <file>` and `ucan mint -out
  <file>` both read/write a file path rather than cramming content into
  an inline flag. `-args-file` is the same pattern applied to `call`,
  not a new one.
- **`macula-mcp` already writes-then-cleans-up a temp file for large
  content.** `artifactPut` in `src/macula_cli.ts` does exactly this for
  `content put`: writes decoded bytes to a temp file, passes the path,
  removes the temp dir in a `finally` block. The mechanism this plan
  needs already has a working precedent in the same file.

## What this plan builds

**`macula-cli`** (`cmd/macula-cli/call.go`):
- Add `-args-file <path>`, reading the call payload from a file instead
  of `-args`. Passing both is a usage error (`fs.Usage` + exit 2),
  matching how `-ucan` + `-direct` are already rejected together.
- Default behavior is unchanged when neither flag is given.

**`macula-mcp`** (`src/macula_cli.ts`):
- `call()` decides transparently: if `JSON.stringify(args.callArgs)`
  exceeds a conservative threshold (32KB — safe under Windows'
  `CreateProcess` command-line limit, the tightest cross-platform
  constraint this project's own install/release tooling has to respect),
  write it to a temp file (same `mkdtemp`/`writeFile`/`finally { rm }`
  shape `artifactPut` already uses) and pass `-args-file` instead of
  `-args`. Below the threshold, behavior is unchanged.
- No new MCP tool, no schema change visible to a calling model — `call`
  (and therefore `mesh_call`) just stops having a hidden size ceiling.
- Bump `MIN_MACULA_CLI_VERSION` once `-args-file` ships upstream,
  following the same version-gate pattern already used for `daemon`,
  `serve -exec`, `dht`, and the inbox-watch fix.

## What's open — not decided here

- **The exact threshold.** 32KB is a safe default, not a measured one —
  worth revisiting once `upload_knowledge` is used for real documents
  and an actual failure mode (if any) is observed.
- **Whether `mesh_call`'s tool description to the model should mention
  this at all.** Leaning toward no — the whole point is that a calling
  model never needs to know a payload was "large," the same way it
  doesn't know today whether a call went out inline or not.
- **`add_knowledge`'s short-text path** (under 80 bytes, per
  `hecate-rag`'s own chunker skip) will basically never hit this
  threshold — this plan matters almost entirely for `upload_knowledge`.

None of the above blocks starting.
