# Plan: `role` prompt — load a Hecate role skill from the mesh

**Status:** Planning
**Created:** 2026-09-01
**Last Updated:** 2026-09-01
**Scope:** macula-mcp (this repo)

## End goal

A human types `/mcp__macula__role devops` and that role's exact
system-prompt body lands in the conversation, fetched live from the
shared mesh corpus — not pasted from a local file, not a semantic
approximation of it.

## Classification

BUILD.

## Relationship to other plans

- **Depends on** `hecate-rag`'s `plans/PLAN_VERBATIM_RETRIEVAL_AND_FRESHNESS.md`
  Phase 2 (`hecate-rag.get_document_verbatim`) — this plan cannot land
  before that RPC exists and is deployed.
- **Resolves** the "MCP-prompts bridge" question `PLAN_MARTHA_MULTI_AGENT_MCP.md`
  left open, and supersedes that plan's `mesh_get`-based verbatim-fetch
  sketch (content-addressing has no answer for "what's the current MCID
  for role X," and cross-station `mesh_get` delivery is only
  best-effort — see that plan's updated Architecture section). Not
  Martha-specific: any mesh-served markdown can use this prompt, role
  files are just the first consumer.

## Design

- One new MCP Prompt, `role`, with a **required** argument
  `role: z.string()`. Confirmed safe against the installed SDK (1.30.0):
  the all-optional-args bug that forced `mesh_help.ts`'s seven prompts
  into zero-argument form does not apply to a required-arg schema.
- Callback: `role` → `roles/${role}.md` — deterministic, matches
  `hecate-corpus/roles/`'s existing file-per-role layout, no new naming
  scheme to invent or keep in sync.
- Calls the same discover-realm-then-call composition `mesh_recall`/
  `mesh_list_stations` already establish: find `hecate-rag`'s realm via
  `mesh_find_records_by_type`, then call `hecate-rag.get_document_verbatim`
  with that path. Returns the fetched markdown as the prompt's message
  content — a client-enforced injection, not a tool result the model
  might skip.
- Not-found handling: an unmatched role name returns a clear error
  message, not a silent empty prompt. Listing known roles in that error
  (e.g. via `list_sources_page` filtered to the `roles/` prefix) is a
  nice-to-have, not blocking for the first cut.
- New file: `src/mesh_role.ts` — its own file, not folded into
  `mesh_help.ts`. Every existing prompt there returns a static string;
  this one does real mesh I/O in its callback, worth keeping visibly
  separate.

## Housekeeping (same session, unrelated but trivial)

`src/mesh_help.ts` line 91 carries a Demon #58 instance ("now AUTOMATIC
(2026-08-31)") of the same history-narration pattern already fixed in
`README.md` this session — fix alongside this work.

## Success criteria

- [ ] `/mcp__macula__role devops` in Claude Code injects `roles/devops.md`'s
      exact content, byte-for-byte matching the file in `hecate-corpus`.
- [ ] An unknown role name produces a clear error, not a crash or an
      empty message.
- [ ] README's Prompts table and CHANGELOG updated.
- [ ] `mesh_help.ts`'s stale date-stamped phrasing is fixed.
