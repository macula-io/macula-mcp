// Probe for an already-running hecate-daemon.
//
// The installer's "primary" path in MVP: if the user already runs the
// full Hecate stack (which most early adopters do — devs, beta users,
// existing realm members), the installer only needs to register the
// MCP entry pointing at the local socket. No daemon download, no
// service launch, no cert acquisition (the running daemon already
// has its identity).
//
// Fresh-install of a Burrito-built daemon is a separate ship; see
// macula-mcp/plans/PLAN_MACULA_MCP_INSTALLER.md Phase 0.

import { daemon, DaemonUnavailable, socketPath } from "../daemon.js";

export interface DaemonProbe {
  running: boolean;
  socket: string;
  identity?: {
    node_id: string | null;
    mri: string | null;
    realm: string | null;
    membership: string;
  };
  reason?: string;
}

export async function probe(): Promise<DaemonProbe> {
  const sock = socketPath();
  try {
    const id = await daemon.identity();
    return {
      running: true,
      socket: sock,
      identity: {
        node_id: id.node_id,
        mri: id.mri,
        realm: id.realm,
        membership: id.membership,
      },
    };
  } catch (e) {
    const reason =
      e instanceof DaemonUnavailable
        ? e.message
        : e instanceof Error
          ? e.message
          : String(e);
    return { running: false, socket: sock, reason };
  }
}
