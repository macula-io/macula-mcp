// Tool: mesh_join_realm -- bind this agent's identity to a person's
// account in the io.macula realm through the portal's join session.
// See realm.ts for the flow and why it is two-step.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as realm from "./realm.js";
import { defaultIdentityPath } from "./mesh_config.js";
import { tsIdentity } from "./macula_ts_client.js";
import { errorContent } from "./reply.js";
import { connectedViaLabel, ensurePresence } from "./presence.js";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function pinHint(identityPath: string): string | undefined {
  return process.env.MACULA_MCP_IDENTITY
    ? undefined
    : `This identity is scoped to the current harness session. To keep it, and this membership, across sessions: ` +
        `set MACULA_MCP_IDENTITY=${identityPath} in the client's MCP server environment.`;
}

function pendingContent(began: realm.BeginResult, identityPath: string): Content[] {
  const hint = pinHint(identityPath);
  const text = {
    status: "pending",
    what_to_do:
      "Show the person this link or the QR code. They open it (any device), sign in at the portal, and confirm " +
      "that this agent may join their account. Then call mesh_join_realm again with wait_seconds (up to 600) to " +
      "pick up the result -- it also lands on its own in mesh://identity once confirmed.",
    join_url: began.join_url,
    session_id: began.session_id,
    expires_at: began.expires_at,
    node_id: began.node_id,
    reused_pending_session: began.reused,
    ...(hint ? { identity_note: hint } : {}),
  };
  return [
    { type: "text", text: JSON.stringify(text, null, 2) },
    { type: "text", text: `Scan to join:\n${began.qr_terminal}\n${began.join_url}` },
    { type: "image", data: began.qr_png_base64, mimeType: "image/png" },
  ];
}

export function registerMeshJoinRealm(server: McpServer): void {
  server.tool(
    "mesh_join_realm",
    "Join the io.macula realm as this agent: bind this server's identity (its node_id / citizen_did) to a " +
      "person's account through the portal. Returns a link and a QR code the person opens or scans, signs in, " +
      "and confirms; the portal then issues an org identity, a realm certificate, a portal token, and a " +
      "membership UCAN (io.macula as issuer, this identity as audience) for this identity, stored under " +
      "~/.config/macula-mcp/realm/. Two-step by nature: the first call returns the link (and keeps polling in " +
      "the background); a later call with wait_seconds picks up the outcome, which also shows in " +
      "mesh://identity. Already joined: reports the membership. The UCAN is what a realm-gated capability " +
      "checks -- older portals that haven't shipped it yet still complete the join, just without one.",
    {
      wait_seconds: z
        .number()
        .int()
        .min(0)
        .max(600)
        .optional()
        .describe(
          "After creating (or reusing) the session, wait this long for the person to confirm before returning. " +
            "0 (default) returns the link immediately. A session lives 10 minutes.",
        ),
    },
    async ({ wait_seconds }) => {
      ensurePresence(server);
      try {
        const id = tsIdentity(defaultIdentityPath());
        const already = realm.status(id.node_id);
        if (already.joined) {
          return { content: [{ type: "text", text: JSON.stringify({ status: "joined", ...already }, null, 2) }] };
        }
        const began = await realm.begin({ connectedVia: connectedViaLabel(server) });
        if (!wait_seconds) {
          return { content: pendingContent(began, id.path) };
        }
        const after = await realm.waitForOutcome(id.node_id, wait_seconds);
        if (after.joined) {
          return { content: [{ type: "text", text: JSON.stringify({ status: "joined", ...after }, null, 2) }] };
        }
        if (after.pending) {
          return { content: pendingContent(began, id.path) };
        }
        return errorContent(`mesh_join_realm: not joined -- ${after.error ?? "the session ended without a confirmation"}`);
      } catch (e) {
        return errorContent(`mesh_join_realm failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
