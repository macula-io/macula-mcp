// Tools: mesh_trust_agent / mesh_untrust_agent -- manage this operator's
// own contact-policy allowlist (policy.ts) from inside a session, instead
// of hand-editing ~/.config/macula-mcp/contact_policy.json off the mesh
// (macula-mcp#1). Natural moment to call this: right after deciding a
// peer is trustworthy, e.g. straight after mesh_answer_ring accepted
// their ring, or mesh_ring's own result named who you just reached --
// both already hand back the node_id this tool needs.
//
// Pure local file edit, no mesh round trip: unlike every tool index.ts
// calls "genuinely mesh-touching," this one never talks to a station, so
// it does not call presence.ensurePresence() either -- same reasoning as
// mesh_rooms.ts's own local-read tool (mesh_rooms), just on the write
// side instead of the read side.
//
// See policy.ts's own comment block right above addToAllowlist for the
// design decision this closes: keyed by node_id (the only thing here
// that is a cryptographic identity), never by operator_name or petname
// (both self-asserted or collidable) -- this tool only ever echoes
// petname(node_id) back as a human-legible label, the same way
// mesh_ring/mesh_answer_ring already do, never as the lookup key.
//
// A petname IS accepted as INPUT here (resolve_node_id.ts, 2026-09-06) --
// that does not weaken the paragraph above. Resolution happens entirely
// LOCALLY, against this operator's own roster, before either allowlist
// function is ever called; what actually gets stored/compared as the
// trust key is always the resolved real node_id, never the petname
// string itself. This is operator convenience for WHICH node_id to
// trust, not a new trust boundary.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorContent, jsonContent } from "./reply.js";
import { addToAllowlist, removeFromAllowlist, policyFilePath, type AllowlistMutationResult } from "./policy.js";
import { petname } from "./petname.js";
import { nodeIdOrPetnameSchema, resolveNodeId } from "./resolve_node_id.js";

/** What the caller should understand about a mutation beyond the raw fields -- the file changed, but is that change actually in effect right now? */
function explain(res: AllowlistMutationResult, verb: "added" | "removed"): string {
  if (res.ok === 0) return res.error ?? "failed";
  if (process.env.MACULA_MCP_CONTACT_POLICY) {
    return `${verb} in ${res.path}, but MACULA_MCP_CONTACT_POLICY=${process.env.MACULA_MCP_CONTACT_POLICY} overrides contact_policy for this process -- the file change has no effect until that env var is unset.`;
  }
  if (verb === "added" && res.policy_changed === 0 && res.contact_policy !== undefined) {
    if (res.policy_label === "closed") {
      return `added to the allowlist, but contact_policy is "closed" -- ring_service.ts declines everyone under closed without even consulting the allowlist. Change contact_policy yourself (edit ${res.path}, or set MACULA_MCP_CONTACT_POLICY) if you want this peer through while staying closed to everyone else.`;
    }
    if (res.policy_label === "open") {
      return `added to the allowlist, but contact_policy is already "open" -- everyone is already accepted, so this entry has no additional effect right now (it will matter if you switch to "allowlist" later).`;
    }
  }
  if (verb === "added" && res.policy_changed === 1) {
    return `added, and switched contact_policy from its "ask" default to "allowlist" in ${res.path} -- rings from this peer are now auto-accepted, everyone else is still asked.`;
  }
  return `${verb} in ${res.path}.`;
}

export function registerMeshTrustAgent(server: McpServer): void {
  server.tool(
    "mesh_trust_agent",
    "Add a peer's node_id to this operator's own contact-policy allowlist (~/.config/macula-mcp/contact_policy.json), " +
      "so their NEXT ring skips the \"ask\" round-trip and is auto-accepted -- without hand-editing that file. " +
      "Call this once you have decided a peer is trustworthy, e.g. right after mesh_answer_ring accepted their " +
      "ring, or from mesh_ring's/mesh_agents' own node_id. If contact_policy is still the \"ask\" default, this " +
      "also switches it to \"allowlist\" (an allowlist nobody is consulting does nothing); an explicit \"closed\" " +
      "or \"open\" policy is left as-is (closed stays authoritative, open already accepts everyone) -- the reply " +
      "says which happened. Keyed by node_id, never by operator_name or petname: only node_id is a verified, " +
      "signed identity here (see ring_service.ts's proof checks) -- operator_name is self-reported and petname " +
      "can collide, neither is safe as a trust boundary. The policy file re-reads on every ring, so this takes " +
      "effect immediately, no restart needed.",
    {
      node_id: nodeIdOrPetnameSchema.describe("The peer to trust: a node_id or petname from mesh_agents, mesh_ring's `to`, mesh_answer_ring's `peer`, or mesh_read_inbox's rings.pending."),
    },
    async ({ node_id }) => {
      const resolved = resolveNodeId(node_id);
      if (!resolved.ok) return errorContent(resolved.error);
      const res = addToAllowlist(resolved.node_id);
      return jsonContent({ ...res, ...(res.node_id ? { petname: petname(res.node_id) } : {}), note: explain(res, "added") });
    },
  );

  server.tool(
    "mesh_untrust_agent",
    "Remove a peer's node_id from this operator's own contact-policy allowlist " +
      "(~/.config/macula-mcp/contact_policy.json), added earlier by mesh_trust_agent or by hand. Never changes " +
      "contact_policy itself either way -- untrusting one peer says nothing about whether \"allowlist\" should " +
      "still be the standing answer for everyone else on it, so that decision is left to the operator. A peer " +
      `that was never listed is a no-op, not an error. The file lives at ${policyFilePath()} unless ` +
      "MACULA_MCP_CONTACT_POLICY_FILE overrides the path.",
    {
      node_id: nodeIdOrPetnameSchema.describe(
        "The peer to remove: a node_id from mesh_agents or the allowlist itself, or a petname -- petname resolution needs " +
          "the peer in your CURRENT roster (mesh_agents), so it may not resolve someone trusted long ago who has since gone " +
          "stale/offline; use their raw node_id from the allowlist file in that case.",
      ),
    },
    async ({ node_id }) => {
      const resolved = resolveNodeId(node_id);
      if (!resolved.ok) return errorContent(resolved.error);
      const res = removeFromAllowlist(resolved.node_id);
      return jsonContent({ ...res, ...(res.node_id ? { petname: petname(res.node_id) } : {}), note: explain(res, "removed") });
    },
  );
}
