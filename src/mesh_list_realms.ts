// Tool: mesh_list_realms -- every realm this identity currently holds a
// confirmed membership for. Read-only counterpart to the CLI-only
// mesh-mcp-realm join (bin/realm.ts) -- see that file's own doc comment
// for why joining stays out of the MCP tool surface entirely while
// listing does not: this tool takes no realm-name input at all (nothing
// for a steered model to influence), never returns a pending session's
// link (realm.listCredentials only ever reads confirmed, on-disk
// credentials -- there is nothing pending for it to find), and never
// returns a bearer credential (refresh_token/cert_pem stay in the local
// file only, same posture as mesh_identity.ts's has_ucan boolean).
//
// Deliberately NOT on the default tool allowlist even so (see
// internal/agent/allowlist.go's own reasoning in lazymesh, and match it
// here): realm names are a fingerprint of who this operator is affiliated
// with, and a steered model relaying that out to a mesh peer costs the
// operator privacy even though nothing here is a bearer credential or a
// state change.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defaultIdentityPath } from "./mesh_config.js";
import { tsIdentity } from "./macula_ts_client.js";
import { jsonContent } from "./reply.js";
import { listCredentials, type RealmMembership } from "./realm.js";
import { toolDescription } from "./tool_description.js";

/** The model-visible shape of one membership -- deliberately excludes refresh_token/cert_pem (bearer credentials, stay local-file-only) and everything else RealmMembership carries beyond what's listed here. Exported and pure so the redaction itself is directly testable without standing up the whole MCP tool. */
export function realmSummary(m: RealmMembership): {
  realm: string;
  org_identity: string;
  handle: string | undefined;
  account: string | undefined;
  joined_at: string;
  tier: string | undefined;
  has_ucan: boolean;
} {
  return {
    realm: m.realm,
    org_identity: m.org_identity,
    handle: m.org_identity.split("/").pop(),
    account: m.account,
    joined_at: m.joined_at,
    tier: m.tier,
    has_ucan: Boolean(m.ucan),
  };
}

const LIST_REALMS_DESCRIPTION_FULL =
  "Every realm this identity currently holds a confirmed membership for -- realm name, org identity/handle, " +
  "when joined, and which tier (device auto-join or full Hanko citizen join). Never lists a pending join " +
  "(nothing to leak -- see mesh_join_realm/mesh://identity's own redaction) and never returns a bearer " +
  "credential (refresh_token/cert_pem stay local-file-only). Joining a NEW realm is deliberately not a tool " +
  "at all -- run macula-mcp-realm join <name> directly, a human action, never something this conversation " +
  "can trigger on its own.";

const LIST_REALMS_DESCRIPTION_TERSE =
  "Realms this identity is confirmed a member of (name, org identity, joined_at, tier). No pending " +
  "sessions, no bearer credentials. Joining is a separate CLI command, not a tool.";

export function registerMeshListRealms(server: McpServer): void {
  server.tool("mesh_list_realms", toolDescription(LIST_REALMS_DESCRIPTION_FULL, LIST_REALMS_DESCRIPTION_TERSE), {}, async () => {
    const { node_id: nodeId } = tsIdentity(defaultIdentityPath());
    const memberships = listCredentials(nodeId).map(realmSummary);
    return jsonContent({ realms: memberships });
  });
}
