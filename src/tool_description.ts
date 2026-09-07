// Terse tool descriptions: an opt-in way to cut what every tool schema
// costs a small-context or self-hosted-model consumer, without touching
// what a full-context client (or a human reading this codebase as
// reference material -- see feedback_macula_code_is_canon_study_material)
// still gets by default.
//
// Every mesh_*.ts tool file keeps its existing verbose description
// EXACTLY as it was, as a DESCRIPTION_FULL constant -- that prose is real
// documentation, not something this cuts down or replaces. Each file also
// gets a hand-written DESCRIPTION_TERSE: a genuinely separate, short
// summary (never an automatic truncation of the full text, which risks
// silently dropping a safety-relevant caveat -- e.g. "no booleans on the
// wire", a ring proof's exact binding, mesh_serve's own standing-inbound-
// trigger warning). toolDescription() picks which one actually reaches
// the wire, based on MACULA_MCP_TERSE_TOOLS.
//
// Wired per-tool-file, not centrally: a reader studying one tool's own
// source (e.g. mesh_say.ts) needs to see that a terse mode exists right
// there, not discover it only by knowing to check a separate table
// elsewhere in the codebase.

/**
 * Whether this process should serve terse tool descriptions instead of
 * the full ones. Off (full, the historical default) unless explicitly
 * set to "1" -- every existing consumer's behavior is unchanged until it
 * opts in. Read fresh on every call, the same convention ring_service.ts's
 * own disabled() (MACULA_MCP_NO_RING) already uses, deliberately not
 * cached at module load -- lets a test flip it between two calls in the
 * same process instead of needing vi.resetModules() per variant.
 */
export function terseToolsEnabled(): boolean {
  return process.env.MACULA_MCP_TERSE_TOOLS === "1";
}

/** The description a tool registration should actually pass to server.tool()/registerTool(), given both variants. */
export function toolDescription(full: string, terse: string): string {
  return terseToolsEnabled() ? terse : full;
}
