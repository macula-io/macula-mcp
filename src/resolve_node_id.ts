// Resolves a node_id OR a petname (petname.ts) to a real 64-hex node_id,
// so a human/agent can say "call upbeat_savage_weasel" instead of a raw
// hex id. Feature request from Raf, 2026-09-06.
//
// petname() is sha256-based, one-way by construction: there is no way to
// compute a node_id from a petname alone, only to check candidates
// already SEEN. This resolves against this process's own roster
// (roster.ts, the same persistent store mesh_agents reads) -- you
// genuinely cannot resolve a petname for an agent you've never
// encountered. That is inherent to the design, not a gap to close, the
// same way a phone contacts list resolves a saved name but not a stranger's
// number.
//
// The natural shared seam, so this logic lives in exactly one place:
// mesh_ring.ts's placeRing() resolves its own `to` here, which covers
// mesh_ring's tool AND mesh_rooms.ts's participants (openRoomAndInvite
// resolves its whole array here before anything is published, since
// rooms.ts's openRoom bakes participants verbatim into the room_opened
// envelope -- an unresolved petname must never reach the wire). Neither
// mesh_trust_agent nor mesh_untrust_agent go through placeRing (they
// write straight to policy.ts's allowlist), so they each call this
// directly on their own node_id param.

import { z } from "zod";
import { petname } from "./petname.js";
import { listAllNodeIds, pruneStale } from "./roster.js";

const HEX64 = /^[0-9a-fA-F]{64}$/;
/** Matches mesh_agents.ts's own staleness window -- a petname should not resolve against a roster entry mesh_agents itself would already consider gone. */
const STALE_AFTER_SECONDS = 15 * 60;

/** Loose on purpose: a raw 64-hex node_id or a petname string. Real validation happens in
 * resolveNodeId() below, so a bad value gets a clear, actionable message instead of a generic
 * Zod schema-mismatch error. */
export const nodeIdOrPetnameSchema = z.string().min(1);

export type ResolveNodeIdResult = { ok: true; node_id: string; resolved_via: "node_id" | "petname" } | { ok: false; error: string };

/**
 * `input` as-is (lowercased) if it's already a 64-hex node_id. Otherwise, tries it as a petname
 * against every currently-known roster entry: exactly one match resolves; zero or more than one
 * is a clear, actionable error, never a silent guess -- petnames aren't unique (~1-in-64,000
 * collision rate, see petname.ts's own doc).
 */
export function resolveNodeId(input: string): ResolveNodeIdResult {
  const trimmed = input.trim();
  if (HEX64.test(trimmed)) return { ok: true, node_id: trimmed.toLowerCase(), resolved_via: "node_id" };

  pruneStale(STALE_AFTER_SECONDS);
  const target = trimmed.toLowerCase();
  const candidates = listAllNodeIds().filter((id) => petname(id) === target);
  if (candidates.length === 0) {
    return {
      ok: false,
      error: `no roster entry with petname "${trimmed}" -- you may not have seen this agent recently, or its roster entry expired (see mesh_agents). Use its raw node_id instead if you have it.`,
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      error: `petname "${trimmed}" matches ${candidates.length} different agents (${candidates.join(", ")}) -- petnames are not guaranteed unique. Use one of their raw node_ids instead.`,
    };
  }
  return { ok: true, node_id: candidates[0]!, resolved_via: "petname" };
}
