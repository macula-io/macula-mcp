# PLAN: Martha as a portable multi-agent crew, over macula-mcp

Status: **Proposal — sketch, not started.** Nothing here is built; every
claim about *existing* infrastructure below was verified against the
actual source, not assumed — see "What's already real."

## Goal

Martha today is `hecate-martha` (`hecate-marthad` + `hecate-marthaw`): a
daemon-hosted plugin with its own Tauri-loaded Svelte frontend, one
specific human's specialist crew, running inside one specific
`hecate-daemon`. That whole substrate is obsolete.

The crew itself — six named specialists (Domain Expert, Architect,
DevOps, QA, Reporter, Mentor), phase-mapped, cost-tiered, gated by human
approval at five points — is not a bad idea that needs retiring with it.
This plan turns it into something any MCP-speaking harness can pull in,
with real per-agent attribution, and without a bespoke backend service:
the crew is corpus content plus a git-and-mesh convention, not
infrastructure that needs to be built and run.

## What's already real (verified, not assumed)

- **The roster is a real, current, `stage: stable` doc**:
  `hecate-corpus/roles/AGENT_ARCHITECTURE.md` defines 6 roles — **Domain
  Expert** (research-first, via `hecate-rag`/web, before opining),
  **Architect**, **DevOps** (development through deployment — one role,
  not three coders plus a separate delivery role), **QA** (test execution
  + code review + release-readiness), **Reporter** (continuous
  documentation), **Mentor** (continuous live observation + gate coaching
  + post-mortem) — each mapped to a lifecycle stage and cost-tiered. Five
  gates carry a mandatory human-in-the-loop checkpoint.
- **Role content is already externalized as plain markdown**:
  `hecate-corpus/roles/*.md`, one file per role, each with its own
  front matter. Nothing to author — the personas exist today.
- **A retrieval backend already exists for corpus content**: `hecate-rag`
  is a real, running Layer-2 service (confirmed on the beam cluster this
  session) exposing `hecate-rag.answer_query` over the mesh.
  `macula-mcp`'s own existing generic `mesh_call` tool already reaches
  it. A code-generation role never needs a bespoke `martha_*` tool to
  retrieve corpus patterns; it needs its prompt to say "call `mesh_call`
  against `hecate-rag.answer_query`."
- **Planning-as-git-artifact is already this org's own convention, not
  a new idea**: every repo in this workspace already tracks its planning
  documents as `plans/PLAN_*.md` files, versioned in git, read at session
  start and kept in sync as work proceeds. Division planning and crafting
  artifacts (EventStorm output, desk inventory, technical design) fit the
  same shape — a document that exists and is kept current, with git
  supplying whatever history is needed. No new persistence mechanism to
  build.
- **`macula-mcp` is already the proven template for MCP-side work**: per
  its own README and `PLAN_MACULA_MCP.md`, it shells out to `macula-cli`
  as a subprocess per call, carries no daemon of its own, and works with
  any MCP harness.
- **Per-agent identity already has a design**: `HECATE_AUTH_MODEL.md`
  channel (b) proposes a `macula-cli --identity` separate from the
  human's own, delegated a narrower UCAN — exactly what "multiple
  agents collaborating with individual attribution" needs.

## Architecture

The load-bearing design choice: **an agent's own harness does the
reasoning, always.** No service in this design calls a model on an
agent's behalf, under any circumstance — see "Where inference actually
happens."

The second load-bearing choice, decided 2026-09-01 (see the Decisions
Log in the global `CLAUDE.md`): **development-process tracking is not
event sourced.** Software development is chaotic and non-linear — a
design gets reopened after Crafting starts, a plan gets revisited after
Discovery — and that doesn't fit a single-current-state aggregate. Only
the five human-approval gates are genuinely append-only, audit-worthy
facts, and those are covered by git history on the artifact itself, not
by a purpose-built event store.

Two pieces, not three — there is no `hecate-martha` backend service:

- **Planning and design artifacts** — git-tracked documents living in
  the domain's own repo, following this workspace's existing
  `plans/PLAN_*.md` convention. A division's EventStorm output, desk
  inventory, and technical design are files that exist and get edited,
  not commands dispatched against an aggregate. A human-approval gate is
  a commit (or a merged PR) that marks the relevant section approved —
  the commit itself is the audit-worthy fact; git log is the history,
  free.
- **`hecate-rag`** — all corpus content, personas included. Two
  retrieval shapes, not one: `hecate-rag.answer_query` (semantic,
  `top_k`) for "find me the relevant template/antipattern list," and
  `hecate-rag.get_document_verbatim` (path-keyed exact fetch, new — see
  `hecate-rag`'s own `PLAN_VERBATIM_RETRIEVAL_AND_FRESHNESS.md`) for
  "give me `domain_expert.md` verbatim" — a role's persona has to be
  exact, not a RAG-reranked approximation of itself. Not `mesh_get`:
  content-addressing has no answer for "what's the current MCID for
  role X" once a persona file changes, and cross-station delivery is
  only best-effort; path-keyed retrieval against a service `macula-mcp`
  already discovers by realm has neither problem.
- **`macula-mcp`** — new code, scoped and small: a `role` MCP Prompt
  (`macula-mcp`'s own `PLAN_MACULA_ROLE_PROMPT.md`) that resolves a role
  name to `hecate-rag.get_document_verbatim` and injects the result as a
  client-enforced prompt rather than a plain tool result an agent might
  not attend to. No new daemon, no new storage — one new prompt callback
  doing a discover-then-call the same way `mesh_recall`/`mesh_list_stations`
  already do.

```
┌────────────────┐   ┌────────────────┐   ┌────────────────┐
│ harness A       │   │ harness B       │   │ harness C       │
│ (Claude Code,   │   │ (Cursor,        │   │ (Claude Code,   │
│  role: architect,│  │  role: devops,   │  │  role: qa,      │
│  own model does  │   │  own model does  │  │  own model does │
│  the reasoning)  │   │  the reasoning)  │  │  the reasoning) │
└───────┬────────┘   └───────┬────────┘   └───────┬────────┘
        │ MCP/stdio          │ MCP/stdio          │ MCP/stdio
        ▼                    ▼                    ▼
┌──────────────────────────────────────────────────────────┐
│  macula-mcp                                                  │
│  mesh_call · mesh_find_records_by_type · mesh_watch ·        │
│  mesh_publish  ← ALL ALREADY EXIST                           │
│  role (new prompt) ← calls get_document_verbatim below       │
└───────────────────────────┬──────────────────────────────┘
                             │ spawns per call (macula-cli --identity)
                             ▼
                        Macula mesh
                             │
                             ▼
                        hecate-rag
              (ALL corpus content: role personas
               AND templates/antipatterns — exact
               fetch via get_document_verbatim, fuzzy
               via answer_query)

        (planning/design state lives in git, in the
         domain's own repo — not on the mesh at all;
         mesh_publish/mesh_watch carry only the live
         "something changed, go look" signal)
```

## Where inference actually happens

There is exactly **one** execution context, not two: **an agent —
someone's harness, channel (b) of `HECATE_AUTH_MODEL.md` — does the
reasoning, on its own already-configured model, always.** A role is a
persona only: whatever surfaces a role's markdown to a harness (see
"MCP surface" below) hands it a system prompt, nothing more. No service
anywhere in this design performs inference.

"Interactive" and "background" describe *whether a human is watching a
particular session right now*, not two different execution paths. A
background task still runs inside some harness's own agent session; the
harness that picks up a gate-unlocked notification does the reasoning,
exactly like the interactive case.

When a phase needs something the harness's model can't do alone —
retrieve corpus patterns, search the web — the role's own prompt names
the capability (`hecate-rag.answer_query`, a web-search tool) and the
harness calls `mesh_call` (or its own native tool) to reach it.
`macula-mcp` never chooses a model on anyone's behalf — it has no
visibility into what models a harness even has configured.

**The T0–T1 tier vocabulary is advisory, without exception.** A role
names a tier as guidance — "this is a T1 task; if your harness supports
switching models, prefer your strongest one" — a suggestion the human or
harness can act on, never something enforced. There is no context in
this design where it's anything else, because there is no context where
a server does the calling instead of a harness. That's a genuine,
unresolved tradeoff, not a solved one: a human running a weak model
against a QA task at the Review Gate gets a weak review, and nothing in
this design stops that.

## MCP surface

Checked against what `macula-mcp` already exposes:

| Martha need | Already covered by | New code needed? |
|---|---|---|
| Discover available roles/capabilities | `mesh_find_records_by_type` (`record_type: "procedure_advertisement"`), filtered client-side | No |
| Fetch a role's exact persona content | New `role` MCP Prompt → `hecate-rag.get_document_verbatim` | Yes — `PLAN_MACULA_ROLE_PROMPT.md` (macula-mcp) + `PLAN_VERBATIM_RETRIEVAL_AND_FRESHNESS.md` (hecate-rag) |
| Retrieve a template/antipattern list mid-task | `mesh_call` → `hecate-rag.answer_query` | No |
| Read/edit a division's planning or design doc | Ordinary git/filesystem access — the harness's own tools | No |
| Announce a gate was just crossed | `mesh_publish`, called by whichever harness made the commit | No |
| Get notified a gate unlocked the next stage | `mesh_watch` on that published fact | No |

**The MCP-prompts bridge, resolved 2026-09-01: building it.** A plain
tool result is data the model *might* attend to; MCP's "prompt"
primitive is a stronger, client-enforced injection the harness threads
into context directly. Not Martha-specific — any mesh-served markdown
could use the same bridge — so it lives in `macula-mcp` as a generic
`role` prompt, not a Martha-only mechanism. See
`PLAN_MACULA_ROLE_PROMPT.md`.

## macula-mcp, or a separate martha-mcp?

**`macula-mcp`, and the question is close to moot now.** There is no
Martha-specific backend to own — no service, no new mesh logic. What
Martha needs from the MCP layer is `hecate-rag` retrieval and generic
mesh pub/sub — generic capabilities (existing or, for verbatim fetch,
newly built as generic) any future role-based system would also want,
never Martha-specific ones. A separate repo would have nothing of its
own to hold.

## Multi-agent coordination

If two harnesses both hold a capability-matching role, who picks up the
next unit of work? Resolution happens the same way it already does for
any git-tracked document with more than one contributor: whichever
harness pushes (or merges) first wins, and the second one hits a
conflict and backs off — no bespoke locking primitive, no aggregate,
just git doing what it already does. The harness that completes a
gate-crossing commit is responsible for calling `mesh_publish` to
announce it (e.g. `hecate.gate_passed`, with the domain/division id and
which gate in the payload, never the topic — per the mesh's own
topic-design rule); interested harnesses `mesh_watch` for it and
self-select to pick up the next stage.

## What this makes possible that one app's UI couldn't

`PROPOSAL_MARTHA_UX.md`'s "Agent Relay" idea — a pipeline of specialist
agents handing a dossier to each other, made visible as animated
handoffs — was always describing something real underneath. Today
that's simulated inside one Tauri app watching one daemon. Once a gate
crossing is a `mesh_publish` any harness can make and any harness can
watch for, the handoff can be **literally** a different harness or a
different human's agent picking up the next phase — not a UI animation
of something that was always sequential in one process.

## What's open — not decided here

- **Where exactly a domain's planning/design documents live** — the
  domain's own (possibly not-yet-created) repo, or a shared location
  visible before that repo exists? Not decided.
- **What "claiming" a unit of work looks like in practice** — a commit
  that adds an agent's name to a section, a lightweight status line, a
  PR draft? The git-conflict race-resolver works regardless of the exact
  convention, but the convention itself isn't chosen.
- **Does `hecate-martha`'s UI survive** as one specific channel-(c)
  "operator website" implementation (a dashboard reading the same
  git-tracked documents), or retire outright? Either is consistent with
  this plan; neither is chosen.
- **Per-agent UCAN delegation isn't wired into `macula-mcp` yet** — see
  `PLAN_AGENT_IDENTITY_UCAN.md` for the scoped work and the one thing it
  depends on that isn't confirmed to exist yet.
- **No enforced quality floor for interactive roles** — advisory tier
  metadata is a suggestion, not a gate. Whether a Review-Gate-class task
  should *refuse* to proceed on a harness that can't report its model
  strength is a real open question this plan doesn't answer.

None of the above blocks starting; they block finishing.
