// Probe for an installed macula-cli binary.
//
// The installer's primary check: macula-mcp shells out to macula-cli for
// every mesh operation (src/macula_cli.ts), so there's nothing to
// register in an MCP client's config that will actually work without it
// on PATH first. `macula-cli identity` is purely local -- no network, no
// station -- so it's a clean "is this binary present and functional"
// probe, not a mesh connectivity check.

import { identity, MaculaCliUnavailable } from "../macula_cli.js";

export interface CliProbe {
  available: boolean;
  nodeId?: string;
  reason?: string;
}

export async function probe(): Promise<CliProbe> {
  try {
    const id = await identity();
    return { available: true, nodeId: id.node_id };
  } catch (e) {
    const reason =
      e instanceof MaculaCliUnavailable
        ? e.message
        : e instanceof Error
          ? e.message
          : String(e);
    return { available: false, reason };
  }
}
