// In-process replacement for the subset of macula_cli.ts's subprocess
// calls this server no longer needs a macula-cli binary for: call,
// publish, watch, the three DHT find-* ops, content put/get, and the
// bare identity() read. Talks to @macula-io/ts's Session/Identity
// directly -- no subprocess, no --json envelope, no daemon for these
// specific operations.
//
// Deliberately NOT a like-for-like port of every macula_cli.ts
// capability: @macula-io/ts does not yet expose realm (any non-default
// realm), direct-dial, or ownership-proof signing (identitySign() stays
// on macula_cli.ts's subprocess path for exactly that last one -- see
// mesh_call.ts). Every function below throws a clear MaculaCliError
// (reused, not a new error type, so reply.ts's describeCliError keeps
// working unchanged) for a capability it can't yet honor, rather than
// silently ignoring the parameter.
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
import { MaculaCliError, defaultStations, stationArgs } from "./macula_cli.js";

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

function assertRealmSupported(realm: string | undefined, tool: string): void {
  if (realm) {
    throw new MaculaCliError(
      `${tool}: a non-default realm was requested, but @macula-io/ts does not yet expose realm on its ` +
        "public call/publish/subscribe/DHT API (all-zero realm only) -- not supported by this server's " +
        "in-process implementation yet.",
    );
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
 * macula_cli.ts's ucanPath() already established). Deliberately just an
 * existence/non-empty sanity check -- NOT an identity-pairing check. An
 * earlier draft of this feature (macula_cli.ts's assertUcanUsableWithIdentity,
 * still uncommitted in this tree, not touched here) required MACULA_MCP_IDENTITY
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
  /** MACULA_MCP_UCAN's file path, if set (see macula_cli.ts's ucanPath()) --
   * when present, attaches the token there to this call via
   * Session.callWithUcan instead of Session.call. Harmless to set against a
   * procedure that isn't UCAN-gated (macula-go ignores an unneeded token on
   * the wire, same as macula-cli's own -ucan flag always did). */
  ucanPath?: string;
}): Promise<TsCallResult> {
  assertRealmSupported(args.realm, "mesh_call");
  assertDirectNotRequested(args.direct, "mesh_call");
  const start = Date.now();
  return withSession(args.host, args.identityPath, async (session) => {
    const payload = args.ucanPath
      ? await session.callWithUcan(args.procedure, toJsonValue(args.callArgs ?? {}), readUcanToken(args.ucanPath), {
          deadlineMs: args.timeoutMs,
        })
      : await session.call(args.procedure, toJsonValue(args.callArgs ?? {}), { deadlineMs: args.timeoutMs });
    return { procedure: args.procedure, payload, duration_ms: Date.now() - start };
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
  assertRealmSupported(args.realm, "mesh_publish");
  const start = Date.now();
  return withSession(args.host, args.identityPath, async (session) => {
    await session.publish(args.topic, toJsonValue(args.fact));
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
  assertRealmSupported(args.realm, "mesh_watch");
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
          { onClosed: () => resolve() },
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
