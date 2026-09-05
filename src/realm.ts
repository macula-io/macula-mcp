// Realm membership: binding this agent's identity to a human's account in
// the io.macula realm, through macula-realm's own join-session flow.
//
// Citizenship (citizenship.ts) puts the agent in the mesh-wide directory
// under its own key -- nobody vouches for it. Joining the realm is the
// human binding on top: macula-realm (realm.macula.io -- its own separate
// app/domain since the 2026-08-30 macula-realm/macula-portal split; this
// flow moved with it, and lived on the bare macula.io domain before that)
// issues a ten-minute join session for the agent's public key, the person
// opens the session's URL (a link, or the same URL as a QR code), signs in
// with Hanko, sees which agent on which machine is asking, and confirms.
// It then hands back the org identity (`mri:org:io.macula/<handle>`), a
// refresh token for its own API, and a realm-CA-signed certificate for
// this key. That is RFC 8628's device-authorization shape, live at
// realm.macula.io (`POST/GET /api/v1/join/sessions`); this module is its
// client.
//
// Two-step by nature: the link has to reach the person BEFORE anything
// can be confirmed, so mesh_join_realm returns the link and QR at once
// and this module keeps polling in the background; the outcome lands in
// mesh://identity on its own, and a second mesh_join_realm call (with
// wait_seconds) picks it up in-conversation.
//
// Proof of possession: the session is created with a signature over
// {node_id, timestamp, "macula_realm.join_session"} from the same
// identity, built with ownership_proof.ts's proofMessage() (the exact
// byte layout hecate-citizens'/hecate-mail's *_ownership_proof verifiers
// require: node_id 32 raw bytes ++ timestamp 8 bytes big-endian ++
// procedure raw UTF-8, no delimiters) and signed in-process with
// @macula-io/ts's Identity.sign() -- no macula-cli subprocess -- so
// nobody can create a session for a key they do not hold and talk a
// person into confirming it. The procedure string is part of the signed
// bytes, not just a label: it must match macula-realm's own
// join_session_controller.ex/joining.ex @join_procedure exactly, or a
// perfectly valid signature verifies against the wrong message and is
// rejected.
//
// Credentials live under ~/.config/macula-mcp/realm/<node_id>.json
// (0600), keyed by the identity they belong to: a session-scoped identity
// keeps its membership for as long as that identity exists; pin
// MACULA_MCP_IDENTITY to keep both across harness sessions.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, arch, homedir, platform } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";
import { defaultIdentityPath } from "./mesh_config.js";
import { loadOrGenerateIdentity } from "./macula_ts_client.js";
import { proofMessage } from "./ownership_proof.js";
import { serverVersion } from "./version.js";

export const JOIN_PROOF_PROCEDURE = "macula_realm.join_session";
export const DEFAULT_REALM_URL = "https://realm.macula.io";
export const POLL_INTERVAL_MS = 4_000;

// A new, separate var rather than repurposing the old MACULA_MCP_PORTAL_URL:
// portal and realm are genuinely separate services/domains now, and
// silently changing what an existing var's value affects would break
// anyone already relying on its old meaning without their config changing
// at all.
export function realmUrl(): string {
  return (process.env.MACULA_MCP_REALM_URL ?? DEFAULT_REALM_URL).replace(/\/+$/, "");
}

export function realmDir(): string {
  return process.env.MACULA_MCP_REALM_DIR ?? join(homedir(), ".config", "macula-mcp", "realm");
}

export function credentialPath(nodeId: string): string {
  return join(realmDir(), `${nodeId}.json`);
}

/**
 * "device": DeviceKeyOwnershipProof-only, silent, no human involved --
 * device_membership.ts's auto-join. "citizen": Hanko-bound human, via
 * this module's own realm join-session flow below. A citizen-tier
 * credential is strictly stronger; device_membership.ts's
 * ensureAutoJoin() never overwrites one with a device-tier credential.
 */
export type RealmTier = "device" | "citizen";

export interface RealmCredential {
  node_id: string;
  portal: string;
  org_identity: string;
  account?: string;
  cert_pem?: string;
  refresh_token: string;
  joined_at: string;
  /** This device's own already-proof-of-possession-verified public key, hex -- stands in for a real citizen DID until macula-passport exists to hold one. Undefined against a realm that hasn't shipped UCAN minting yet. */
  citizen_did?: string;
  /** Membership UCAN (io.macula as issuer, citizen_did as audience) -- see citizen_did's own doc for why it names a device key today. Undefined against an older/unconfigured realm. */
  ucan?: string;
  /** Defaults to "citizen" on load when absent: every credential written before this field existed came exclusively from the full Hanko join flow below. */
  tier?: RealmTier;
}

export function loadCredential(nodeId: string): RealmCredential | undefined {
  const path = credentialPath(nodeId);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RealmCredential;
    if (typeof parsed.org_identity !== "string" || typeof parsed.refresh_token !== "string") return undefined;
    return { ...parsed, tier: parsed.tier ?? "citizen" };
  } catch {
    return undefined;
  }
}

/** Writes the credential 0600 in a 0700 directory and returns its path. */
export function storeCredential(cred: RealmCredential): string {
  mkdirSync(realmDir(), { recursive: true, mode: 0o700 });
  const path = credentialPath(cred.node_id);
  writeFileSync(path, JSON.stringify(cred, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** `mri:org:io.macula/rgfaber` -> `rgfaber`; undefined when not joined. Pure. */
export function handleOf(orgIdentity: string | undefined): string | undefined {
  if (!orgIdentity) return undefined;
  const last = orgIdentity.split("/").pop();
  return last && last.length > 0 ? last : undefined;
}

export function orgHandle(nodeId: string | undefined): string | undefined {
  return nodeId ? handleOf(loadCredential(nodeId)?.org_identity) : undefined;
}

/** The agent MRI the realm shows the person; the same convention hecate-daemon used, with this server's own name. Pure. */
export function agentMri(nodeId: string): string {
  return `mri:agent:io.macula/anonymous/macula-mcp-${nodeId.slice(0, 8)}`;
}

/** The join-session request body. Pure. */
export function joinRequest(input: {
  nodeId: string;
  proof: { timestamp: number; signature: string };
  connectedVia?: string;
}): Record<string, unknown> {
  return {
    public_key: Buffer.from(input.nodeId, "hex").toString("base64"),
    agent_mri: agentMri(input.nodeId),
    agent_info: {
      hostname: hostname(),
      os: `${platform()}/${arch()}`,
      version: `macula-mcp ${serverVersion()}`,
      ...(input.connectedVia ? { client: input.connectedVia } : {}),
    },
    proof: { timestamp: input.proof.timestamp, signature: input.proof.signature },
  };
}

export interface CreatedSession {
  session_id: string;
  join_url: string;
  expires_at: string;
}

/** Shape the realm's 201 into a session, or throw with the realm's own error text. Pure. */
export function parseCreated(httpStatus: number, body: unknown): CreatedSession {
  const b = (body ?? {}) as Record<string, unknown>;
  if (httpStatus === 201 && typeof b.session_id === "string" && typeof b.join_url === "string") {
    return { session_id: b.session_id, join_url: b.join_url, expires_at: String(b.expires_at ?? "") };
  }
  const detail = typeof b.error === "string" ? b.error : JSON.stringify(body);
  throw new Error(`realm refused to create a join session (HTTP ${httpStatus}): ${detail}`);
}

export type SessionStatus =
  | { status: "pending"; expires_at: string }
  | {
      status: "confirmed";
      refresh_token: string;
      org_identity: string;
      cert_pem?: string;
      oauth_account?: string;
      oauth_provider?: string;
      citizen_did?: string;
      ucan?: string;
    }
  | { status: "expired" }
  | { status: "error"; message: string };

/** Shape a poll reply. Pure. */
export function parseSessionStatus(httpStatus: number, body: unknown): SessionStatus {
  const b = (body ?? {}) as Record<string, unknown>;
  if (httpStatus === 410 || b.error === "session_expired") return { status: "expired" };
  if (httpStatus === 200 && b.status === "pending") return { status: "pending", expires_at: String(b.expires_at ?? "") };
  if (httpStatus === 200 && b.status === "confirmed" && typeof b.org_identity === "string" && typeof b.refresh_token === "string") {
    return {
      status: "confirmed",
      refresh_token: b.refresh_token,
      org_identity: b.org_identity,
      cert_pem: typeof b.cert_pem === "string" ? b.cert_pem : undefined,
      oauth_account: typeof b.oauth_account === "string" ? b.oauth_account : undefined,
      oauth_provider: typeof b.oauth_provider === "string" ? b.oauth_provider : undefined,
      citizen_did: typeof b.citizen_did === "string" ? b.citizen_did : undefined,
      ucan: typeof b.ucan === "string" ? b.ucan : undefined,
    };
  }
  const detail = typeof b.error === "string" ? b.error : JSON.stringify(body);
  return { status: "error", message: `realm answered HTTP ${httpStatus}: ${detail}` };
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<{ status: number; json: () => Promise<unknown> }>;

export async function createSession(body: Record<string, unknown>, fetchImpl: FetchLike = fetch): Promise<CreatedSession> {
  const res = await fetchImpl(`${realmUrl()}/api/v1/join/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  return parseCreated(res.status, await res.json().catch(() => ({})));
}

export async function pollSession(sessionId: string, fetchImpl: FetchLike = fetch): Promise<SessionStatus> {
  const res = await fetchImpl(`${realmUrl()}/api/v1/join/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { accept: "application/json" },
  });
  return parseSessionStatus(res.status, await res.json().catch(() => ({})));
}

/**
 * The QR as plain text: half-block glyphs, no ANSI escapes, a two-module
 * quiet zone. qrcode's own terminal renderer colours with ANSI, which an
 * MCP client that is not a terminal shows as literal escape sequences.
 * Light modules are drawn as full blocks and dark ones as spaces, which
 * reads correctly on the dark backgrounds most terminals and chat clients
 * use; scanners accept the inverted case on a light one.
 */
export function qrTerminal(url: string): Promise<string> {
  const qr = QRCode.create(url, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const quiet = 2;
  const dark = (row: number, col: number): boolean => {
    const r = row - quiet;
    const c = col - quiet;
    if (r < 0 || c < 0 || r >= size || c >= size) return false;
    return qr.modules.get(r, c) === 1;
  };
  const width = size + quiet * 2;
  const height = size + quiet * 2;
  const lines: string[] = [];
  for (let row = 0; row < height; row += 2) {
    let line = "";
    for (let col = 0; col < width; col++) {
      const top = dark(row, col);
      const bottom = row + 1 < height ? dark(row + 1, col) : false;
      // light = block, dark = space (see the doc comment above)
      line += !top && !bottom ? "\u2588" : !top && bottom ? "\u2580" : top && !bottom ? "\u2584" : " ";
    }
    lines.push(line);
  }
  return Promise.resolve(lines.join("\n"));
}

export async function qrPngBase64(url: string): Promise<string> {
  const buf = await QRCode.toBuffer(url, { type: "png", width: 320, errorCorrectionLevel: "M", margin: 2 });
  return buf.toString("base64");
}

// ---- state: one pending session at a time, for the default identity ----

interface Pending {
  node_id: string;
  session_id: string;
  join_url: string;
  expires_at: string;
  timer?: NodeJS.Timeout;
  polling: boolean;
}

let pending: Pending | undefined;
let lastError: string | undefined;

export interface RealmStatus {
  portal: string;
  joined: boolean;
  org_identity?: string;
  handle?: string;
  account?: string;
  joined_at?: string;
  credential_path?: string;
  /** This device's own public key, hex -- see RealmCredential.citizen_did's own doc. */
  citizen_did?: string;
  /** Whether a membership UCAN was issued -- never the token itself here, that's a bearer credential and stays in the credential file only. */
  has_ucan?: boolean;
  /** "device" (silent, DeviceKeyOwnershipProof-only auto-join) or "citizen" (Hanko-bound human) -- see RealmCredential.tier. Undefined when not joined at all. */
  tier?: RealmTier;
  pending?: { session_id: string; join_url: string; expires_at: string };
  error?: string;
}

export function status(nodeId: string | undefined): RealmStatus {
  const base: RealmStatus = { portal: realmUrl(), joined: false };
  if (!nodeId) return base;
  const cred = loadCredential(nodeId);
  if (cred) {
    return {
      ...base,
      joined: true,
      org_identity: cred.org_identity,
      handle: handleOf(cred.org_identity),
      account: cred.account,
      joined_at: cred.joined_at,
      credential_path: credentialPath(nodeId),
      citizen_did: cred.citizen_did,
      has_ucan: Boolean(cred.ucan),
      tier: cred.tier,
    };
  }
  return {
    ...base,
    ...(pending && pending.node_id === nodeId
      ? { pending: { session_id: pending.session_id, join_url: pending.join_url, expires_at: pending.expires_at } }
      : {}),
    ...(lastError ? { error: lastError } : {}),
  };
}

function expired(iso: string): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= Date.now();
}

async function pollOnce(fetchImpl: FetchLike): Promise<void> {
  if (!pending || pending.polling) return;
  const p = pending;
  p.polling = true;
  try {
    const outcome = await pollSession(p.session_id, fetchImpl);
    if (outcome.status === "confirmed") {
      storeCredential({
        node_id: p.node_id,
        portal: realmUrl(),
        org_identity: outcome.org_identity,
        account: outcome.oauth_account,
        cert_pem: outcome.cert_pem,
        refresh_token: outcome.refresh_token,
        joined_at: new Date().toISOString(),
        citizen_did: outcome.citizen_did,
        ucan: outcome.ucan,
        tier: "citizen",
      });
      lastError = undefined;
      clearPending();
    } else if (outcome.status === "expired") {
      lastError = "the join session expired before it was confirmed; call mesh_join_realm again for a fresh link";
      clearPending();
    } else if (outcome.status === "error") {
      lastError = outcome.message;
    } else if (expired(outcome.expires_at)) {
      lastError = "the join session expired before it was confirmed; call mesh_join_realm again for a fresh link";
      clearPending();
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
  } finally {
    if (pending === p) p.polling = false;
  }
}

function clearPending(): void {
  if (pending?.timer) clearInterval(pending.timer);
  pending = undefined;
}

export interface BeginResult extends CreatedSession {
  node_id: string;
  reused: boolean;
  qr_terminal: string;
  qr_png_base64: string;
}

/**
 * Create a join session for the default identity (or hand back the one
 * still pending), start polling it in the background, and return the
 * link plus its QR renderings. Throws when the realm refuses.
 *
 * node_id and the proof signature both come from ONE loaded Identity
 * (the default identity's seed file, loaded/minted the same way every
 * other in-process tool does it) so the id sent to the realm and the
 * key that actually signed it can never drift apart.
 */
export async function begin(input: { connectedVia?: string; fetchImpl?: FetchLike } = {}): Promise<BeginResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const id = loadOrGenerateIdentity(defaultIdentityPath());
  try {
    const nodeId = Buffer.from(id.nodeId).toString("hex");
    if (pending && pending.node_id === nodeId && !expired(pending.expires_at)) {
      return {
        node_id: nodeId,
        reused: true,
        session_id: pending.session_id,
        join_url: pending.join_url,
        expires_at: pending.expires_at,
        qr_terminal: await qrTerminal(pending.join_url),
        qr_png_base64: await qrPngBase64(pending.join_url),
      };
    }
    clearPending();
    // Sign right before the call, never ahead -- the verifying side
    // enforces a 60s skew window (ownership_proof.ts's MAX_PROOF_SKEW_MS).
    const timestamp = Date.now();
    const signature = Buffer.from(id.sign(proofMessage(nodeId, timestamp, JOIN_PROOF_PROCEDURE))).toString("hex");
    const created = await createSession(
      joinRequest({ nodeId, proof: { timestamp, signature }, connectedVia: input.connectedVia }),
      fetchImpl,
    );
    lastError = undefined;
    const timer = setInterval(() => void pollOnce(fetchImpl), POLL_INTERVAL_MS);
    timer.unref();
    pending = { node_id: nodeId, ...created, timer, polling: false };
    return {
      node_id: nodeId,
      reused: false,
      ...created,
      qr_terminal: await qrTerminal(created.join_url),
      qr_png_base64: await qrPngBase64(created.join_url),
    };
  } finally {
    id.dispose();
  }
}

/** Wait up to `seconds` for the pending session to resolve either way; returns the status afterwards. */
export async function waitForOutcome(nodeId: string, seconds: number, fetchImpl: FetchLike = fetch): Promise<RealmStatus> {
  const deadline = Date.now() + Math.max(0, seconds) * 1000;
  while (Date.now() < deadline && pending && pending.node_id === nodeId) {
    await pollOnce(fetchImpl);
    if (!pending) break;
    await new Promise((r) => setTimeout(r, Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))));
  }
  return status(nodeId);
}

/** Forget the pending session (nothing to cancel on the realm side; it expires on its own). */
export function abandon(): void {
  clearPending();
}
