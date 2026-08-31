// The deterministic per-agent "inbox" topic -- derived from just the
// recipient's own node_id, nothing else. Anyone who already knows an
// agent's node_id (mesh_agents already gives you this) can compute it
// and publish there directly, with zero invite/discovery step.
//
// This exists specifically to remove the lobby's invite dance
// (mesh_open_lobby_session, see mesh_lobby.ts) for the case it's
// clumsy for: messaging someone you already know. The lobby's
// unguessable session topic is solving a genuinely different problem
// -- pairing with WHOEVER shows up, not a specific known agent -- and
// stays exactly as it is for that case. A DM only works against a
// PRESENCE node_id (the one mesh_hello/mesh_agents show): presence.ts
// is what actually watches this topic (started automatically by
// mesh_hello), so a recipient who never said hello has nobody
// listening on it, same as a phone number nobody's ever turned on.
export function inboxTopic(nodeId: string): string {
  return `agents.dm.${nodeId}`;
}
