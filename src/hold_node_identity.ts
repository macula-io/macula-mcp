// Placeholder so the red test loads; the hold is written in the next commit (macula-mcp#80).
export type IdentityHeld = { heldBy: number | undefined };
export type IdentityHold = { release(): Promise<void> };
export async function holdNodeIdentity(_nodeIdHex: string): Promise<IdentityHold | IdentityHeld> {
  return { release: async () => {} };
}
export function identityAddress(nodeIdHex: string): string {
  return nodeIdHex;
}
