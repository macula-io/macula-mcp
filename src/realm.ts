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
// Proof: the session is created with this node's key as carried and a realm
// proof v2 (macula-realm#29) over the whole body as sent, device_info
// included, for io.macula and "macula_realm.join_session", with a fresh
// nonce (macula_ts_client.ts's proveDeviceRequest, over macula-go's
// devicerequest). macula-realm's DeviceRequestProof checks it and derives the
// node_id from the key, so nobody can create a session for a key they do not
// hold, or change what the person confirming it reads.
//
// Credentials live under ~/.config/macula-mcp/realm/<node_id>/<realm>.json
// (0600), keyed by the identity they belong to: a session-scoped identity
// keeps its membership for as long as that identity exists; name the
// agent (MACULA_MCP_AGENT) or pin MACULA_MCP_IDENTITY to keep both across
// harness sessions.
import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname, arch, homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import QRCode from "qrcode";
import type { JsonValue } from "@macula-io/ts";
import { carriedPublicKey, JOIN_SESSION_PROCEDURE, proveDeviceRequest, selfNodeId } from "./macula_ts_client.js";
import { realmIdOf } from "./mesh_config.js";
import { appendNodeEvent, NODE_EVENT } from "./node_events.js";
import { acquireLock, releaseLock } from "./realm_lock.js";
import { ringsDb } from "./rings.js";
import { serverVersion } from "./version.js";

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

/**
 * DEFAULT_REALM_NAME is what every call site in this file meant, always,
 * before multi-realm join existed: "io.macula", the one realm
 * mesh_join_realm/device_membership.ts have ever bound an identity to.
 * Every function below defaults its own realmName param to this, so
 * every existing caller (unaware multi-realm join exists at all) keeps
 * working unchanged -- only the new CLI join path (bin/realm.ts) ever
 * passes something else.
 */
export const DEFAULT_REALM_NAME = "io.macula";

/**
 * <realmDir>/<node_id>/<realm>.json -- one credential per (identity,
 * realm), not per identity alone. Realm names are already guaranteed
 * filesystem-safe by realm_name.ts's own grammar (lowercase ASCII
 * letters/digits/hyphens/single dots only -- no `/`, no `..` as a path
 * traversal sequence) before anything ever reaches here, so no separate
 * path-safety check is needed at this layer.
 */
export function credentialPath(nodeId: string, realmName: string = DEFAULT_REALM_NAME): string {
  return join(realmDir(), nodeId, `${realmName}.json`);
}

function readCredentialFile(path: string): RealmCredential | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RealmCredential;
    if (typeof parsed.org_identity !== "string" || typeof parsed.refresh_token !== "string") return undefined;
    if (parsed.tier !== "device" && parsed.tier !== "citizen") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * "device": device-proof-only (realm proof v2), silent, no human involved --
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
  tier: RealmTier;
}

export function loadCredential(nodeId: string, realmName: string = DEFAULT_REALM_NAME): RealmCredential | undefined {
  const path = credentialPath(nodeId, realmName);
  return existsSync(path) ? readCredentialFile(path) : undefined;
}

/**
 * Whether writing this credential establishes a membership: none was stored, or a different person or a
 * stronger tier replaces what was. A renewal rewrites the same membership with a fresh UCAN every ten
 * minutes (device_membership.ts) and is not a join.
 */
function isNewMembership(before: RealmCredential | undefined, cred: RealmCredential): boolean {
  return before === undefined || before.org_identity !== cred.org_identity || before.tier !== cred.tier;
}

/**
 * Records a membership the realm confirmed in this node's event log (macula-mcp#42), so an agent learns
 * about the join in order with everything else that happened to it, instead of finding a file on disk.
 * Called from storeCredential, the one place a membership is written: the server's own join flow, the
 * silent device join, and macula-mcp-realm in a second process all land here.
 *
 * Best effort, deliberately: the credential file is the membership and this entry is the notification, and
 * a machine whose log file cannot be opened (full disk, read-only home) must still finish a join the realm
 * already confirmed. The failure is reported, never swallowed.
 */
function recordJoinConfirmed(cred: RealmCredential, realmName: string): void {
  try {
    appendNodeEvent(ringsDb(), { self: cred.node_id, kind: NODE_EVENT.joinConfirmed, realm: realmName, org_identity: cred.org_identity, tier: cred.tier });
  } catch (e) {
    console.error(`node event log: join_confirmed for ${realmName} was not recorded: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------------------------------
// The membership owner: the one writer of a credential file.
//
// A node's membership in a realm is one fact, and until macula-mcp#44 four code paths wrote it with four
// different ideas of what was already there: this file's own join flow, device_membership.ts's silent
// auto-join and its renewal, and macula-mcp-realm, a SEPARATE process the human runs. Each read the file,
// decided, and wrote -- with an await in between in most cases -- so the writer that finished last won,
// and the rule "a citizen credential is never replaced by a device one" held only in the paths that
// happened to re-read at the right moment.
//
// So every write goes through storeMembership, which takes a lock file next to the credential (the CLI is
// another OS process, so an in-process mutex is not enough -- realm_lock.ts owns that lock and the one-winner
// reclaim of one a crashed holder left), re-reads the file under that lock, applies the caller's POLICY to
// what is on disk now, and writes through a temp file and a rename. Nothing else writes a credential: the
// three exported functions below are the three policies, not three writers.
function lockPath(nodeId: string, realmName: string): string {
  return join(realmDir(), nodeId, `${realmName}.lock`);
}

/** Writes the credential 0600 through a temp file and a rename, so no reader ever sees half a file. */
function writeCredentialFile(path: string, cred: RealmCredential): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(cred, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // it never landed, or the rename took it
    }
    throw e;
  }
}

/** How strong a credential's tier is, so a weaker one can never replace a stronger (macula-mcp#43). */
const tierRank = (tier: RealmTier): number => (tier === "citizen" ? 2 : 1);

/**
 * What a store does with a credential, given what the file holds NOW (read under the lock):
 * - replace: a fresh join for this (node, realm) replaces what was there.
 * - unless-weaker: keep a stronger one already in place (the silent device join).
 * - renewal: keep a credential that landed during the renewing call's await and outranks the one it
 *   renewed, but otherwise store the new token even at a lower tier (see storeRenewal).
 */
type StorePolicy = { kind: "replace" } | { kind: "unless-weaker" } | { kind: "renewal"; renewedFrom: RealmTier };

function keepsWhatIsStored(policy: StorePolicy, held: RealmCredential | undefined, cred: RealmCredential, realmName: string): boolean {
  if (held === undefined) return false;
  if (policy.kind === "unless-weaker") return tierRank(held.tier) > tierRank(cred.tier);
  if (policy.kind !== "renewal") return false;
  if (tierRank(held.tier) <= tierRank(policy.renewedFrom)) return false;
  console.error(`realm: a ${held.tier} credential for ${cred.node_id} in ${realmName} landed while its ${policy.renewedFrom} membership renewed; kept it`);
  return true;
}

/** Re-reads, decides and writes under the credential lock; returns the path, or undefined when it kept. */
function storeMembership(cred: RealmCredential, realmName: string, policy: { kind: "replace" }): string;
function storeMembership(cred: RealmCredential, realmName: string, policy: StorePolicy): string | undefined;
function storeMembership(cred: RealmCredential, realmName: string, policy: StorePolicy): string | undefined {
  const path = credentialPath(cred.node_id, realmName);
  const lock = lockPath(cred.node_id, realmName);
  const fd = acquireLock(lock);
  try {
    const held = readCredentialFile(path);
    if (keepsWhatIsStored(policy, held, cred, realmName)) return undefined;
    writeCredentialFile(path, cred);
    // Inside the lock: the event is appended by the same writer that made the file true, so two
    // processes cannot both read "no membership" and both announce one.
    if (isNewMembership(held, cred)) recordJoinConfirmed(cred, realmName);
    return path;
  } finally {
    releaseLock(lock, fd);
  }
}

/**
 * Writes the credential 0600 in a 0700 directory and returns its path.
 *
 * Under the credential lock, from a re-read taken there (macula-mcp#44): the file this replaces is whatever
 * another process stored a moment ago, not what this process saw before it started.
 *
 * A credential that establishes a membership is also appended to this node's event log, after the file
 * lands (recordJoinConfirmed) -- the membership is never announced before it exists.
 */
export function storeCredential(cred: RealmCredential, realmName: string = DEFAULT_REALM_NAME): string {
  return storeMembership(cred, realmName, { kind: "replace" });
}

/**
 * Stores a credential unless this realm already holds a stronger one for this
 * node, and returns its path, or undefined when it kept what was there.
 *
 * The read and the decision happen HERE, at the write, under the lock (macula-mcp#43, macula-mcp#44).
 * Both callers used to decide before an await -- auto-join before it joined, renewal before the realm
 * answered -- so a citizen credential that landed in that window was replaced by the device-tier one the
 * call had already started, which is the one rule this store must never break.
 */
export function storeCredentialUnlessWeaker(cred: RealmCredential, realmName: string = DEFAULT_REALM_NAME): string | undefined {
  return storeMembership(cred, realmName, { kind: "unless-weaker" });
}

/**
 * Stores a RENEWAL of `held`, and returns its path, or undefined when a stronger credential landed while
 * the realm was answering.
 *
 * A renewal cannot be guarded on its own new token (macula-mcp#43 review): the realm sets the tier from
 * the member's record -- realm_ucan_issuer.ex's membership_capability(member.assurance) -- so when an
 * operator lowers a member's assurance, the device-tier token IS the truth for that membership. Treated
 * as a downgrade it was thrown away for good: the citizen UCAN then expired while every renewal fetched a
 * device token and discarded it, and the node lost a membership the realm still grants.
 *
 * What must not be overwritten is a credential that landed during THIS renewal's await and is stronger
 * than the one it read: a person confirming a citizen membership mid-renewal. Auto-join keeps the
 * stricter rule (storeCredentialUnlessWeaker): it joins a realm the node does not hold yet, so anything
 * already there outranks what it is about to mint.
 */
export function storeRenewal(held: RealmMembership, renewed: RealmCredential): string | undefined {
  return storeMembership(renewed, held.realm, { kind: "renewal", renewedFrom: held.tier });
}

export interface RealmMembership extends RealmCredential {
  realm: string;
}

/**
 * Every realm nodeId currently holds a stored credential for -- confirmed
 * memberships only, never a pending one (a pending join lives only in
 * whichever process created it, mesh_join_realm's own module state or
 * bin/realm.ts's own subprocess-local state; neither is ever written to
 * disk, so there is nothing pending for this function to find or leak).
 * Backs mesh_list_realms.
 */
export function listCredentials(nodeId: string): RealmMembership[] {
  const dir = join(realmDir(), nodeId);
  const out: RealmMembership[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const cred = readCredentialFile(join(dir, entry));
    if (cred) out.push({ ...cred, realm: entry.slice(0, -".json".length) });
  }
  return out;
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

/** The agent MRI the realm shows the person, carrying this server's own name. Pure. */
export function agentMri(nodeId: string): string {
  return `mri:agent:io.macula/anonymous/macula-mcp-${nodeId.slice(0, 8)}`;
}

/** The join-session request body the proof signs, before its proof. Pure. */
export function joinRequest(input: {
  nodeId: string;
  publicKey: string;
  connectedVia?: string;
}): { [field: string]: JsonValue } {
  return {
    public_key: input.publicKey,
    agent_mri: agentMri(input.nodeId),
    // device_info, not agent_info: found live 2026-09-08 (Orion,
    // realm-admission side) -- macula-realm's JoinSessionController reads
    // params["device_info"] (join_session_controller.ex, defaulting to
    // %{} when absent), so every join session created under the old key
    // name had empty device info server-side. Not a crash -- the join
    // still worked -- but it quietly defeated the point of Orion's new
    // explicit-confirm review step, which shows this to the human
    // deciding whether to approve the join and falls back to "your
    // device" with nothing here to show instead.
    device_info: {
      hostname: hostname(),
      os: `${platform()}/${arch()}`,
      version: `macula-mcp ${serverVersion()}`,
      ...(input.connectedVia ? { client: input.connectedVia } : {}),
    },
  };
}

/** body with its realm proof v2, signed now for realmName's join session: the body is signed as it is sent. */
export async function signedJoinRequest(body: { [field: string]: JsonValue }, realmName: string = DEFAULT_REALM_NAME):
  Promise<{ [field: string]: JsonValue }> {
  const proof = await proveDeviceRequest(realmIdOf(realmName), JOIN_SESSION_PROCEDURE, body, "http");
  return { ...body, proof: { ...proof } };
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

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** A reply that says the join session is gone. */
function isExpiredReply(httpStatus: number, b: Record<string, unknown>): boolean {
  return httpStatus === 410 || b.error === "session_expired";
}

/**
 * A 200 carrying everything a confirmed membership needs: the org identity, plus a credential in
 * either shape -- a refresh token (what the realm issued until 2026-09-04) or a membership UCAN (what
 * a citizen confirmation carries since; JoinSessionController's moduledoc). Demanding the refresh
 * token alone made every ucan-only confirmation read as a generic error, so the join never finalized
 * (macula-mcp#40).
 */
function isConfirmedBody(b: Record<string, unknown>): boolean {
  return (
    b.status === "confirmed" &&
    typeof b.org_identity === "string" &&
    (typeof b.refresh_token === "string" || typeof b.ucan === "string")
  );
}

function confirmedStatus(b: Record<string, unknown>): SessionStatus {
  return {
    status: "confirmed",
    // Empty rather than missing for a ucan-only confirmation: the stored credential keeps the field
    // readCredentialFile requires, as the device tier already does (macula-mcp#40).
    refresh_token: typeof b.refresh_token === "string" ? b.refresh_token : "",
    org_identity: b.org_identity as string,
    cert_pem: stringOrUndefined(b.cert_pem),
    oauth_account: stringOrUndefined(b.oauth_account),
    oauth_provider: stringOrUndefined(b.oauth_provider),
    citizen_did: stringOrUndefined(b.citizen_did),
    ucan: stringOrUndefined(b.ucan),
  };
}

/** Shape a poll reply. Pure. */
export function parseSessionStatus(httpStatus: number, body: unknown): SessionStatus {
  const b = (body ?? {}) as Record<string, unknown>;
  if (isExpiredReply(httpStatus, b)) return { status: "expired" };
  if (httpStatus === 200 && b.status === "pending") return { status: "pending", expires_at: String(b.expires_at ?? "") };
  if (httpStatus === 200 && isConfirmedBody(b)) return confirmedStatus(b);
  const detail = typeof b.error === "string" ? b.error : JSON.stringify(body);
  return { status: "error", message: `realm answered HTTP ${httpStatus}: ${detail}` };
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<{ status: number; json: () => Promise<unknown> }>;

/**
 * A realm call that never answers must not hold the membership owner's mailbox (macula-mcp#44): while a
 * poll is in flight, a begin behind it waits, so the wait is bounded here rather than left to the
 * operating system's own TCP timeouts.
 */
const REALM_HTTP_TIMEOUT_MS = 15_000;

/** baseURL defaults to realmUrl() (today's single-realm env-var-or-default) -- bin/realm.ts's multi-realm CLI is the only caller that ever passes something else (realm_name.ts's realmBaseURL, resolved from a typed realm name), never the MCP-tool path. */
export async function createSession(body: Record<string, unknown>, fetchImpl: FetchLike = fetch, baseURL: string = realmUrl()): Promise<CreatedSession> {
  const res = await fetchImpl(`${baseURL}/api/v1/join/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REALM_HTTP_TIMEOUT_MS),
  });
  return parseCreated(res.status, await res.json().catch(() => ({})));
}

/** baseURL: see createSession's own doc. */
export async function pollSession(sessionId: string, fetchImpl: FetchLike = fetch, baseURL: string = realmUrl()): Promise<SessionStatus> {
  const res = await fetchImpl(`${baseURL}/api/v1/join/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REALM_HTTP_TIMEOUT_MS),
  });
  return parseSessionStatus(res.status, await res.json().catch(() => ({})));
}

/** One half-block glyph: light modules are blocks, dark ones spaces (see qrTerminal's doc). */
function halfBlockGlyph(top: boolean, bottom: boolean): string {
  if (!top && !bottom) return "\u2588";
  if (!top && bottom) return "\u2580";
  if (top && !bottom) return "\u2584";
  return " ";
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
      line += halfBlockGlyph(top, bottom);
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
  /** The realm this session was opened against: the confirmation is stored under it, never a default. */
  realm: string;
  timer?: NodeJS.Timeout;
}

let pending: Pending | undefined;
let lastError: string | undefined;

/**
 * The pending session's mailbox (macula-mcp#44): begin, the background poll, a wait and an abandon are
 * transitions of ONE piece of state, so they are handled one at a time, in the order they arrived.
 *
 * Two concurrent begins used to each open a session -- the second replaced the first's pending state
 * without clearing its interval timer, so that timer polled a session nobody would ever hear about, and a
 * person confirming the FIRST link got nothing. And a poll that had answered after its session was
 * abandoned applied to whatever was current, so a late "expired" cleared a fresh session.
 */
let mailbox: Promise<unknown> = Promise.resolve();

function serialized<T>(op: () => T | Promise<T>): Promise<T> {
  const run = mailbox.then(op, op);
  mailbox = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

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
  /** Whether a membership UCAN was issued -- never the token itself here, that's a credential and stays in the credential file only. */
  has_ucan?: boolean;
  /** "device" (silent, device-proof-only auto-join) or "citizen" (Hanko-bound human) -- see RealmCredential.tier. Undefined when not joined at all. */
  tier?: RealmTier;
  /**
   * session_id/join_url are omitted (see status()'s own redactPending
   * param) whenever this RealmStatus reaches somewhere other than the
   * operator's own direct mesh_join_realm call -- a real live join_url
   * is a bearer link: whoever opens it first and confirms with their own
   * Hanko account gets the membership. expires_at alone is never
   * sensitive on its own.
   */
  pending?: { session_id?: string; join_url?: string; expires_at: string };
  error?: string;
}

/**
 * redactPending (found live 2026-09-08, macula-io/macula-mcp, a real
 * live info-leak affecting every existing deployment, not a
 * design-stage concern): mesh://identity (mesh_identity.ts) and
 * mesh_hello's own result (via presence.ts's StartResult) both embed
 * this exact RealmStatus, and neither sits behind any tool allowlist in
 * any macula-mcp client -- so a pending join's session_id/join_url,
 * meant only for the human who is about to scan/click it, was
 * reachable by anything that merely checked its own identity or said
 * hello while a join was in flight. Whoever gets that link first and
 * confirms with THEIR OWN account gets the membership; the human's own
 * typed-realm-name care (or, before that existed, simply calling
 * mesh_join_realm themselves) never mattered once a second, unrelated
 * read could hand the same link to a steered model.
 *
 * mesh_join_realm's own direct call (mesh_join_realm.ts) passes
 * redactPending=false (the default) deliberately: that IS the
 * legitimate channel, the one the human explicitly asked for by
 * calling this tool, and it needs the real link to be useful at all.
 * Only status reached through some OTHER, incidental read is redacted.
 */
export function status(nodeId: string | undefined, opts: { redactPending?: boolean; realm?: string } = {}): RealmStatus {
  if (!nodeId) return { portal: realmUrl(), joined: false };
  const realmName = opts.realm ?? DEFAULT_REALM_NAME;
  const cred = loadCredential(nodeId, realmName);
  if (cred) return { portal: realmUrl(), joined: true, ...joinedFields(nodeId, realmName, cred) };
  const session = pendingFor(nodeId, realmName);
  return { portal: realmUrl(), joined: false, ...pendingFields(session, opts.redactPending === true), ...(lastError ? { error: lastError } : {}) };
}

function joinedFields(nodeId: string, realmName: string, cred: RealmCredential): Omit<RealmStatus, "portal" | "joined"> {
  return {
    org_identity: cred.org_identity,
    handle: handleOf(cred.org_identity),
    account: cred.account,
    joined_at: cred.joined_at,
    credential_path: credentialPath(nodeId, realmName),
    citizen_did: cred.citizen_did,
    has_ucan: Boolean(cred.ucan),
    tier: cred.tier,
  };
}

/** The in-flight session for exactly this (node, realm), if there is one. */
function pendingFor(nodeId: string, realmName: string): Pending | undefined {
  if (pending === undefined || pending.node_id !== nodeId || pending.realm !== realmName) return undefined;
  return pending;
}

function pendingFields(p: Pending | undefined, redact: boolean): Pick<RealmStatus, "pending"> {
  if (p === undefined) return {};
  return { pending: redact ? { expires_at: p.expires_at } : { session_id: p.session_id, join_url: p.join_url, expires_at: p.expires_at } };
}

function expired(iso: string): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= Date.now();
}

/**
 * Records a confirmed join and clears the pending session.
 *
 * The credential goes to the realm the SESSION was opened against (p.realm), never to a default: a
 * confirmation for net.beam-campus stored as io.macula is a membership of a realm this node never joined.
 *
 * Throws when the store could not take the credential lock, and deliberately does NOT clear the session
 * then: the person HAS confirmed at the realm, so the poll is left running and the next one retries the
 * write, instead of losing a membership that exists on the other side.
 */
function confirmedJoin(p: Pending, outcome: Extract<SessionStatus, { status: "confirmed" }>): void {
  storeCredential(
    {
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
    },
    p.realm,
  );
  lastError = undefined;
  clearPending();
}

/** Applies one poll reply to the pending session's state. */
function applyPollOutcome(p: Pending, outcome: SessionStatus): void {
  if (outcome.status === "confirmed") {
    confirmedJoin(p, outcome);
    return;
  }
  if (outcome.status === "expired") {
    lastError = "the join session expired before it was confirmed; call mesh_join_realm again for a fresh link";
    clearPending();
    return;
  }
  if (outcome.status === "error") {
    lastError = outcome.message;
    return;
  }
  if (expired(outcome.expires_at)) {
    lastError = "the join session expired before it was confirmed; call mesh_join_realm again for a fresh link";
    clearPending();
  }
}

/**
 * One poll of the pending session, applied only if that session is still the current one.
 *
 * Called from the mailbox (serialized), so two polls never overlap and no `polling` flag is needed. The
 * identity check is what a flag could never do: a poll that answers after its session was abandoned or
 * replaced is DROPPED, where it used to apply its verdict to whatever session happened to be current.
 */
async function pollPending(fetchImpl: FetchLike): Promise<void> {
  const p = pending;
  if (!p) return;
  let outcome: SessionStatus;
  try {
    outcome = await pollSession(p.session_id, fetchImpl);
  } catch (e) {
    if (pending === p) lastError = e instanceof Error ? e.message : String(e);
    return;
  }
  if (pending !== p) return;
  try {
    applyPollOutcome(p, outcome);
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
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
 * Create a join session for this node (or hand back the one still
 * pending), start polling it in the background, and return the link plus
 * its QR renderings. Throws when the realm refuses.
 *
 * Through the mailbox: two begins that arrive together open ONE session (the second finds the first's and
 * reuses it). `realm` is the realm the session is opened against and the confirmation will be stored
 * under; it defaults to io.macula, which is what the MCP tool path has always joined. This process holds
 * one pending session at a time -- the multi-realm CLI (bin/realm.ts) keeps its own, in its own process.
 */
export async function begin(input: { connectedVia?: string; realm?: string; fetchImpl?: FetchLike } = {}): Promise<BeginResult> {
  return serialized(() => openJoinSession(input));
}

async function openJoinSession(input: { connectedVia?: string; realm?: string; fetchImpl?: FetchLike }): Promise<BeginResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const realmName = input.realm ?? DEFAULT_REALM_NAME;
  const nodeId = await selfNodeId();
  if (pending && pending.node_id === nodeId && pending.realm === realmName && !expired(pending.expires_at)) {
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
  // Proven right before the call, never ahead: the realm allows 60 s of skew.
  const body = joinRequest({ nodeId, publicKey: await carriedPublicKey(), connectedVia: input.connectedVia });
  const created = await createSession(await signedJoinRequest(body, realmName), fetchImpl);
  lastError = undefined;
  const timer = setInterval(() => void serialized(() => pollPending(fetchImpl)), POLL_INTERVAL_MS);
  timer.unref();
  pending = { node_id: nodeId, realm: realmName, ...created, timer };
  return {
    node_id: nodeId,
    reused: false,
    ...created,
    qr_terminal: await qrTerminal(created.join_url),
    qr_png_base64: await qrPngBase64(created.join_url),
  };
}

/**
 * Wait up to `seconds` for the pending session to resolve either way; returns that realm's status
 * afterwards. Each poll is its own turn in the mailbox, not one long hold on it, so a wait never starves a
 * begin.
 */
export async function waitForOutcome(nodeId: string, seconds: number, fetchImpl: FetchLike = fetch): Promise<RealmStatus> {
  const deadline = Date.now() + Math.max(0, seconds) * 1000;
  const realmName = pending?.realm ?? DEFAULT_REALM_NAME;
  while (Date.now() < deadline && pending && pending.node_id === nodeId) {
    await serialized(() => pollPending(fetchImpl));
    if (!pending) break;
    await new Promise((r) => setTimeout(r, Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))));
  }
  return status(nodeId, { realm: realmName });
}

/**
 * Forget the pending session (nothing to cancel on the realm side; it expires on its own).
 *
 * Not queued on the mailbox, deliberately: a person asking to stop must not wait behind a poll in flight.
 * The poll that is already out carries its own session identity and drops whatever it brings back, so this
 * cannot race the session that takes its place.
 */
export function abandon(): void {
  clearPending();
}
