// The mesh client every tool actually talks through: call, publish,
// watch, the three DHT find-* ops (plus discoverProcedureRealm, the
// find-then-filter citizenship.ts's realm lookup needs), content
// put/get, the bare identity() read, ownership-proof signing, and
// call-then-direct-dial. Talks to @macula-io/ts's Session/Identity
// directly -- no subprocess, no --json envelope, no daemon for any of
// this (this module is what the original macula-cli-shelling-out
// src/macula_cli.ts was replaced by, tool by tool, through 2026-09;
// that file is gone -- see mesh_config.ts for what of it survives:
// pure station/identity config with no subprocess involved).
//
// Deliberately NOT a like-for-like port of every capability the old
// subprocess client had: mesh_call's own `direct` option is still NOT wired to
// Session.callDirect()/resolveDirect() -- those exist on Session (since
// the direct-dial cutover below landed) and ARE used internally by
// callThenDirect() further down, but routing mesh_call's caller-facing
// `direct: true` flag through them is a separate, not-yet-done cutover
// (see mesh_call.ts's assertDirectNotRequested / call() below). realm
// WAS in this "not yet" list too, until the 0.12.0 vendor refresh added
// CallOptions.realm/PublishOptions.realm/SubscribeOptions.realm to
// Session.call/publish/subscribe -- call(), publish() and watch() below
// now thread a caller-supplied realm straight through. call() itself
// still throws a clear MaculaCliError (reused, not a new error type, so
// reply.ts's describeCliError keeps working unchanged) for `direct`,
// rather than silently ignoring it.
//
// Connects fresh per one-shot call, same "connect, do the thing, exit"
// semantics macula-cli's own one-shot subcommands had -- deliberately
// NOT a persistent shared Session for these (unlike serve.ts, where a
// persistent Session is architecturally required, not a latency
// nicety). A held connection-pool is a real, deferred future
// optimization, not attempted here to keep this cutover's behavior a
// close, easy-to-reason-about match for what macula-cli's own
// subprocess-per-call model already did.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Identity, MaculaCallError as TsCallError, Session, type JsonValue } from "@macula-io/ts";
import { MaculaCliError, defaultStations, stationArgs } from "./mesh_config.js";
import { proofMessage } from "./ownership_proof.js";

const DEFAULT_PORT = 4433;

/** Loads a persisted 32-byte seed at `path`, or mints and persists a fresh one -- the
 * same load-or-generate policy macula-cli's own internal/identitystore applies, just
 * done here now since this path no longer goes through a macula-cli subprocess. */
export function loadOrGenerateIdentity(path: string): Identity {
  if (existsSync(path)) {
    const seed = readFileSync(path);
    if (seed.length !== 32) {
      throw new MaculaCliError(`identity seed at ${path} is ${seed.length} bytes, expected 32 -- refusing to use it`);
    }
    return Identity.fromSeedBytes(new Uint8Array(seed));
  }
  const id = Identity.generate();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, Buffer.from(id.privateSeedBytes), { mode: 0o600 });
  chmodSync(path, 0o600);
  return id;
}

function parseHostPort(hostport: string): { host: string; port: number } {
  const idx = hostport.lastIndexOf(":");
  if (idx === -1) return { host: hostport, port: DEFAULT_PORT };
  const port = Number(hostport.slice(idx + 1));
  if (Number.isNaN(port)) return { host: hostport, port: DEFAULT_PORT };
  return { host: hostport.slice(0, idx), port };
}

/** Tries each configured station in order (the same fallback list/order
 * stationArgs()/defaultStations() already establish for the macula-cli
 * path), first successful handshake wins. Mirrors macula-cli's own
 * `-seed`-fallback behavior for an explicit host, there is nothing to
 * fall back to -- exactly like macula-cli's own stationArgs(). */
export async function connectWithFallback(identity: Identity, host?: string): Promise<Session> {
  const targets = host ? [host] : defaultStations();
  let lastErr: unknown;
  for (const target of targets) {
    const { host: h, port } = parseHostPort(target);
    try {
      return await Session.connect(h, port, identity);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Maps any error a Session/Identity operation can throw onto MaculaCliError
 * (reused, not a new error type) so reply.ts's describeCliError works the
 * same for every tool, macula-ts-backed or not. Exported for serve.ts,
 * which does its own try/catch shape (it needs to keep the persistent
 * Session/registrations state consistent on failure) rather than going
 * through withSession(). */
export function toCliError(e: unknown): MaculaCliError {
  if (e instanceof TsCallError) return new MaculaCliError(e.message, e.code, e.bolt4Name, e.retryable);
  if (e instanceof MaculaCliError) return e;
  if (e instanceof Error) return new MaculaCliError(e.message);
  return new MaculaCliError(String(e));
}

/** Connects fresh with `identityPath`'s identity, runs `fn`, always closes and disposes
 * afterward -- the one-shot "connect, do the thing, exit" shape every function below shares. */
export async function withSession<T>(
  host: string | undefined,
  identityPath: string,
  fn: (session: Session, identity: Identity) => Promise<T>,
): Promise<T> {
  const identity = loadOrGenerateIdentity(identityPath);
  let session: Session | undefined;
  try {
    session = await connectWithFallback(identity, host);
    return await fn(session, identity);
  } catch (e) {
    throw toCliError(e);
  } finally {
    if (session) await session.close(identity).catch(() => {});
    identity.dispose();
  }
}

function assertDirectNotRequested(direct: boolean | undefined, tool: string): void {
  if (direct) {
    throw new MaculaCliError(
      `${tool}: direct-dial was requested, but @macula-io/ts does not implement direct-dial (directdial.Call/` +
        "Resolve) yet -- not supported by this server's in-process implementation. UCAN-gated capabilities, " +
        "which require direct-dial, cannot be reached this way yet.",
    );
  }
}

/** Reads a UCAN token from `path` (MACULA_MCP_UCAN, same file-path convention
 * mesh_config.ts's ucanPath() already established). Deliberately just an
 * existence/non-empty sanity check -- NOT an identity-pairing check. An
 * earlier draft of this feature (an assertUcanUsableWithIdentity that once
 * lived alongside the now-deleted subprocess client, never wired up here)
 * required MACULA_MCP_IDENTITY
 * to point at the token's own <audience> on the premise that presenting a UCAN
 * from any other identity "would never verify" -- a Fable review of this exact
 * codebase traced the real verify chain (Erlang's authorize_policy +
 * macula_ucan_nif:verify/2, identical across every SDK port) and found it
 * checks ONLY the token's signature and expiry against its own issuer, never
 * the caller's identity against `aud`. That check both rejected configurations
 * that work fine on the wire and implied a security property the mesh doesn't
 * enforce -- @macula-io/ts's own Session.callWithUcan is deliberately built
 * without it (see its own module doc), and this function follows the same
 * discipline: confirm the file is there and has something in it, attach
 * whatever token it holds, nothing more. */
function readUcanToken(path: string): string {
  if (!existsSync(path)) {
    throw new MaculaCliError(
      `MACULA_MCP_UCAN is set to "${path}" but that file doesn't exist -- provision the token first ` +
        "(macula-cli ucan mint ...) before making a call that needs it.",
    );
  }
  const token = readFileSync(path, "utf8").trim();
  if (!token) {
    throw new MaculaCliError(`MACULA_MCP_UCAN's file ("${path}") is empty -- provision a real token there.`);
  }
  return token;
}

function toJsonValue(v: unknown): JsonValue {
  if (v === null || typeof v === "string" || typeof v === "number") return v;
  if (Array.isArray(v)) return v.map(toJsonValue);
  if (typeof v === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined) continue;
      if (typeof val === "boolean") {
        throw new MaculaCliError(
          `arg "${k}" is a boolean -- macula's wire CBOR has no boolean type; encode true/false as 1/0 yourself`,
        );
      }
      out[k] = toJsonValue(val);
    }
    return out;
  }
  throw new MaculaCliError(`arg value of type ${typeof v} has no CBOR wire representation`);
}

// ---- call -------------------------------------------------------------

export interface TsCallResult {
  procedure: string;
  payload: unknown;
  duration_ms: number;
}

export async function call(args: {
  host?: string;
  procedure: string;
  callArgs?: Record<string, unknown>;
  timeoutMs?: number;
  realm?: string;
  direct?: boolean;
  identityPath: string;
  /** MACULA_MCP_UCAN's file path, if set (see mesh_config.ts's ucanPath()) --
   * when present, attaches the token there to this call via
   * Session.callWithUcan instead of Session.call. Harmless to set against a
   * procedure that isn't UCAN-gated (macula-go ignores an unneeded token on
   * the wire). */
  ucanPath?: string;
}): Promise<TsCallResult> {
  assertDirectNotRequested(args.direct, "mesh_call");
  const start = Date.now();
  return withSession(args.host, args.identityPath, async (session) => {
    const payload = args.ucanPath
      ? await session.callWithUcan(args.procedure, toJsonValue(args.callArgs ?? {}), readUcanToken(args.ucanPath), {
          deadlineMs: args.timeoutMs,
          realm: args.realm,
        })
      : await session.call(args.procedure, toJsonValue(args.callArgs ?? {}), {
          deadlineMs: args.timeoutMs,
          realm: args.realm,
        });
    return { procedure: args.procedure, payload, duration_ms: Date.now() - start };
  });
}

// ---- ownership-proof signing ---------------------------------------------

export interface TsIdentitySignResult {
  node_id: string;
  timestamp: number;
  signature: string;
}

/**
 * An ownership proof for `procedure`, signed by the identity at
 * `identityPath`: {node_id, timestamp, procedure} exactly as
 * ownership_proof.ts's proofMessage lays the bytes out -- the SAME
 * helper its own verifyOwnershipProof() uses, so a proof signed here
 * verifies identically wherever it lands (hecate-citizens,
 * hecate-mail, another macula-mcp's ring_service.ts) and this is not a
 * second, independently-drifting reimplementation of that byte layout.
 * Matches the old macula-cli `identity sign --procedure <string>` output
 * shape this once replaced (see citizenship.ts/ring_service.ts/
 * mesh_ring.ts/mesh_call.ts, every one of which signs through this
 * function now rather than a subprocess call).
 *
 * Pure local Ed25519 signing via Identity.sign() -- no network, unlike
 * every function above; only the identity file is touched, and unlike
 * the macula-cli subprocess this replaces, there is no process to spawn
 * at all. Sign right before the call, never ahead (see
 * MAX_PROOF_SKEW_MS in ownership_proof.ts).
 */
export function signOwnershipProof(identityPath: string, procedure: string): TsIdentitySignResult {
  const identity = loadOrGenerateIdentity(identityPath);
  try {
    const node_id = Buffer.from(identity.nodeId).toString("hex");
    const timestamp = Date.now();
    const signature = Buffer.from(identity.sign(proofMessage(node_id, timestamp, procedure))).toString("hex");
    return { node_id, timestamp, signature };
  } finally {
    identity.dispose();
  }
}

// ---- call, then direct-dial on failure -----------------------------------

/**
 * The same connect-do-the-thing-exit shape as call() above, but tries an
 * ordinary session.call() first and, only on failure, retries the
 * identical call as session.callDirect() before giving up -- matching
 * citizenship.ts's/ring_service.ts's/mesh_ring.ts's existing plain-then-
 * direct fallback semantics. An ordinary (gossip-routed) call depends on
 * inter-station gossip having already carried a route from `host` to
 * whoever serves `procedure`; during a fleet rollout, or against a peer
 * this station hasn't gossiped with yet, that route is exactly what's
 * missing for a minute or two (temporary_relay_failure), while the
 * target's own direct-dial DHT record is already there -- see
 * citizenship.ts's callThenDirect doc for where this was first observed
 * live. Both attempts share ONE connection/identity (session.callDirect()
 * only touches this Session to query the DHT; the one-hop dial itself is
 * a separate connection macula-go opens, pins, and closes internally --
 * see @macula-io/ts's directdial.ts), so a genuinely dead connection
 * fails both attempts for the same underlying reason rather than masking
 * it. On a double failure, both errors are combined into one message
 * (`${plain}; direct-dial retry: ${direct}`), the same shape the old
 * macula-cli-backed two-subprocess version gave.
 */
export async function callThenDirect(args: {
  host?: string;
  procedure: string;
  callArgs?: Record<string, unknown>;
  timeoutMs?: number;
  realm?: string;
  identityPath: string;
}): Promise<TsCallResult> {
  const start = Date.now();
  return withSession(args.host, args.identityPath, async (session) => {
    const payload = toJsonValue(args.callArgs ?? {});
    const opts = { deadlineMs: args.timeoutMs, realm: args.realm };
    try {
      const result = await session.call(args.procedure, payload, opts);
      return { procedure: args.procedure, payload: result, duration_ms: Date.now() - start };
    } catch (plain) {
      try {
        const result = await session.callDirect(args.procedure, payload, opts);
        return { procedure: args.procedure, payload: result, duration_ms: Date.now() - start };
      } catch (direct) {
        const p = plain instanceof Error ? plain.message : String(plain);
        const d = direct instanceof Error ? direct.message : String(direct);
        throw new Error(`${p}; direct-dial retry: ${d}`);
      }
    }
  });
}

// ---- publish ------------------------------------------------------------

export interface TsPublishResult {
  topic: string;
  duration_ms: number;
}

export async function publish(args: {
  host?: string;
  topic: string;
  fact: Record<string, unknown>;
  realm?: string;
  identityPath: string;
}): Promise<TsPublishResult> {
  const start = Date.now();
  return withSession(args.host, args.identityPath, async (session) => {
    await session.publish(args.topic, toJsonValue(args.fact), { realm: args.realm });
    return { topic: args.topic, duration_ms: Date.now() - start };
  });
}

// ---- watch ----------------------------------------------------------------

export interface TsWatchEvent {
  topic: string;
  publisher: string;
  seq: number;
  payload: unknown;
}

export async function watch(args: {
  host?: string;
  topic: string;
  durationSeconds: number;
  count?: number;
  realm?: string;
  identityPath: string;
}): Promise<TsWatchEvent[]> {
  return withSession(args.host, args.identityPath, async (session) => {
    const events: TsWatchEvent[] = [];
    let stop: (() => Promise<void>) | undefined;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), Math.max(1, Math.round(args.durationSeconds * 1000)));
      session
        .subscribe(
          args.topic,
          (evt) => {
            events.push({
              topic: args.topic,
              publisher: Buffer.from(evt.publisher).toString("hex"),
              seq: evt.seq,
              payload: evt.payload,
            });
            if (args.count && events.length >= args.count) {
              clearTimeout(timer);
              resolve();
            }
          },
          { onClosed: () => resolve(), realm: args.realm },
        )
        .then((s) => {
          stop = s;
        })
        .catch(() => resolve());
    });
    if (stop) await stop();
    return events;
  });
}

// ---- DHT --------------------------------------------------------------

function hexToKey32(hex: string): Uint8Array {
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) throw new MaculaCliError(`key_hex must be exactly 32 bytes (64 hex chars), got ${buf.length}`);
  return new Uint8Array(buf);
}

export interface TsDhtRecord {
  type: number;
  key: string;
  version: string;
  created_at_ms: number;
  expires_at_ms: number;
  payload: unknown;
  procedure_advertisement?: {
    procedure_uri: string;
    realm: string;
    procedure: string;
    advertiser_node: unknown;
    serving_station: unknown;
  };
}

function decodeRecord(r: import("@macula-io/ts").DhtRecord): TsDhtRecord {
  const out: TsDhtRecord = {
    type: r.type,
    key: r.key,
    version: r.version,
    created_at_ms: r.createdAt,
    expires_at_ms: r.expiresAt,
    payload: r.payload,
    // Unlike macula-cli's own DHT tools, @macula-io/ts does not verify a record's
    // signature or expiry on the caller's behalf -- there is no `verified` field
    // to report here (a real, honest gap vs. the macula-cli-backed implementation,
    // see README.md/CHANGELOG.md). A caller that needs to trust `payload` must
    // check the signature itself.
  };
  const payload = r.payload;
  if (r.type === 0x06 && payload && typeof payload === "object" && !Array.isArray(payload)) {
    const uri = (payload as Record<string, unknown>)["procedure_uri"];
    if (typeof uri === "string") {
      const slash = uri.indexOf("/");
      if (slash !== -1) {
        out.procedure_advertisement = {
          procedure_uri: uri,
          realm: uri.slice(0, slash),
          procedure: uri.slice(slash + 1),
          advertiser_node: stripHexPrefix((payload as Record<string, unknown>)["advertiser_node"]),
          serving_station: stripHexPrefix((payload as Record<string, unknown>)["serving_station"]),
        };
      }
    }
  }
  return out;
}

function stripHexPrefix(v: unknown): unknown {
  return typeof v === "string" && v.startsWith("0x") ? v.slice(2) : v;
}

export async function findRecord(args: { host?: string; keyHex: string; identityPath: string }): Promise<{
  host: string;
  found: boolean;
  record?: TsDhtRecord;
}> {
  const { host } = stationArgs(args.host);
  return withSession(args.host, args.identityPath, async (session) => {
    const rec = await session.findRecord(hexToKey32(args.keyHex));
    return { host, found: rec !== null, record: rec ? decodeRecord(rec) : undefined };
  });
}

export async function findRecords(args: { host?: string; keyHex: string; identityPath: string }): Promise<{
  host: string;
  count: number;
  records: TsDhtRecord[];
}> {
  const { host } = stationArgs(args.host);
  return withSession(args.host, args.identityPath, async (session) => {
    const recs = await session.findRecords(hexToKey32(args.keyHex));
    const records = recs.map(decodeRecord);
    return { host, count: records.length, records };
  });
}

const RECORD_TYPE_NAMES: Record<string, number> = {
  procedure_advertisement: 0x06,
  content_announcement: 0x11,
  station_endpoint: 0x12,
};

export async function findRecordsByType(args: {
  host?: string;
  recordType: string;
  identityPath: string;
}): Promise<{ host: string; type: number; count: number; records: TsDhtRecord[] }> {
  const { host } = stationArgs(args.host);
  const type = RECORD_TYPE_NAMES[args.recordType] ?? Number(args.recordType);
  if (!Number.isInteger(type) || type < 0 || type > 255) {
    throw new MaculaCliError(`record_type "${args.recordType}" is not a known type name or a 0-255 number`);
  }
  return withSession(args.host, args.identityPath, async (session) => {
    const recs = await session.findRecordsByType(type);
    const records = recs.map(decodeRecord);
    return { host, type, count: records.length, records };
  });
}

/**
 * The realm `procedure` is currently advertised under, from the DHT
 * visible at `host` -- the discover-then-call step citizenship.ts's
 * register() needs, since hecate_citizens.register_presence (like every
 * hecate service) is never served under the all-zero realm and there is
 * no other way to learn its realm than from its own advertisement. Same
 * composition mesh_stations.ts/mesh_memory.ts already do inline for
 * their own single call site; factored out here because citizenship.ts's
 * register() is called on every renewal (every DEFAULT_RENEW_SECONDS,
 * not just once), so it is worth a shared, testable function rather than
 * a third copy of the same find-then-filter.
 */
export async function discoverProcedureRealm(args: { host?: string; procedure: string; identityPath: string }): Promise<string> {
  const discovered = await findRecordsByType({ host: args.host, recordType: "procedure_advertisement", identityPath: args.identityPath });
  const match = discovered.records.find((r) => r.procedure_advertisement?.procedure === args.procedure);
  const realm = match?.procedure_advertisement?.realm;
  if (!realm) {
    throw new MaculaCliError(
      `${args.procedure} is not currently advertised on the mesh (checked ${discovered.count} procedure_advertisement ` +
        `record(s) visible from ${discovered.host})`,
    );
  }
  return realm;
}

// ---- content ------------------------------------------------------------

export async function artifactPut(args: {
  host?: string;
  contentBase64: string;
  identityPath: string;
}): Promise<{ mcid_hex: string; size_bytes: number }> {
  return withSession(args.host, args.identityPath, async (session) => {
    const data = Buffer.from(args.contentBase64, "base64");
    const { mcid } = await session.putContent(new Uint8Array(data));
    return { mcid_hex: mcid, size_bytes: data.length };
  });
}

export async function artifactGet(args: {
  host?: string;
  mcidHex: string;
  identityPath: string;
}): Promise<{ content: string; size_bytes: number }> {
  return withSession(args.host, args.identityPath, async (session) => {
    const bytes = await session.getContent(args.mcidHex);
    return { content: Buffer.from(bytes).toString("base64"), size_bytes: bytes.length };
  });
}

// ---- identity (read-only) ------------------------------------------------

export interface TsIdentityResult {
  node_id: string;
  path: string;
  generated: boolean;
}

export function tsIdentity(path: string): TsIdentityResult {
  const existed = existsSync(path);
  const id = loadOrGenerateIdentity(path);
  try {
    return { node_id: Buffer.from(id.nodeId).toString("hex"), path, generated: !existed };
  } finally {
    id.dispose();
  }
}
