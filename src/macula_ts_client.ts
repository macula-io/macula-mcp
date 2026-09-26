// The mesh client every tool talks through: ONE @macula-io/ts Pool for this
// whole process, under this server's one identity key, linked to every
// configured station (each pinned by its node_id) and trusting the realms
// mesh_config.ts names. Calls reach a provider by direct dial (its signed
// advertisement from the DHT, verified against the realm's key, then the
// station it serves from); publications are signed; a subscription hears
// each verified event once however many links deliver it, and survives a
// link dropping, because the pool re-links and replays it.
//
// The pool is created lazily on first use and kept for the process's
// lifetime; closePool() ends it at shutdown. There is nothing per call to
// connect or tear down, and no second identity anywhere: one node, one key,
// one pool.

import {
  ContentUnavailableError,
  NodeKey,
  NotSharedError,
  Pool,
  ProviderError,
  RecordType,
  RelayError,
  type BytesOutput,
  type DhtRecord,
  type Event,
  type JsonValue,
  type Request,
  type Served,
  type Subscription,
} from "@macula-io/ts";
import { IO_MACULA_REALM_ID, MeshError, nodeKeyPath, realmTrust, seeds } from "./mesh_config.js";

/** The fleet's crypto profile, which macula-realm verifies key-possession proofs under too. */
export const KEY_PROFILE = "pq_hybrid";

let keyPromise: Promise<NodeKey> | undefined;
let poolPromise: Promise<Pool> | undefined;

/** This server's identity key, loaded from nodeKeyPath() or generated and saved there on first use. */
export function nodeKey(): Promise<NodeKey> {
  keyPromise ??= NodeKey.loadOrCreate(nodeKeyPath(), KEY_PROFILE).catch((e) => {
    keyPromise = undefined;
    throw new MeshError(`the identity key at ${nodeKeyPath()} could not be loaded or created: ${messageOf(e)}`);
  });
  return keyPromise;
}

/** This server's node_id as lowercase hex. */
export async function selfNodeId(): Promise<string> {
  return (await nodeKey()).nodeIdHex();
}

/**
 * The shared pool. Concurrent first callers share one in-flight connect; a
 * failed connect is forgotten so the next caller tries again rather than
 * inheriting the rejection forever.
 */
export function sharedPool(): Promise<Pool> {
  poolPromise ??= (async () => Pool.connect(await nodeKey(), seeds(), { realmTrust: realmTrust() }))().catch((e) => {
    poolPromise = undefined;
    throw toMeshError(e);
  });
  return poolPromise;
}

/** Closes the pool, if one was ever connected. */
export async function closePool(): Promise<void> {
  const p = poolPromise;
  poolPromise = undefined;
  if (p) await (await p.catch(() => undefined))?.close();
}

/** Test hook: forget the pool and the key without touching either. */
export async function resetForTests(): Promise<void> {
  poolPromise = undefined;
  keyPromise = undefined;
}

/** Any error from the mesh as a MeshError, keeping a provider's or a station's code. */
export function toMeshError(e: unknown): MeshError {
  if (e instanceof MeshError) return e;
  if (e instanceof ProviderError) return new MeshError(e.message, e.code, "provider");
  if (e instanceof RelayError) return new MeshError(e.message, e.code, "station");
  if (e instanceof NotSharedError) return new MeshError(e.message, "not_shared");
  if (e instanceof ContentUnavailableError) return new MeshError(e.message, "unavailable");
  return new MeshError(messageOf(e));
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function realmOf(realm: string | undefined): string {
  return (realm ?? IO_MACULA_REALM_ID).toLowerCase();
}

/** A tool's JSON as the wire's value, refusing what the wire cannot carry: a boolean, or anything that is not JSON. */
export function toJsonValue(v: unknown): JsonValue {
  if (v === null || typeof v === "string" || typeof v === "number") return v;
  if (Array.isArray(v)) return v.map(toJsonValue);
  if (typeof v === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined) continue;
      if (typeof val === "boolean") {
        throw new MeshError(`"${k}" is a boolean -- macula's wire has no boolean type; encode true/false as 1/0`);
      }
      out[k] = toJsonValue(val);
    }
    return out;
  }
  throw new MeshError(`a value of type ${typeof v} has no wire representation`);
}

// ---- call ---------------------------------------------------------------

export interface CallResult {
  procedure: string;
  payload: JsonValue;
  duration_ms: number;
}

/** Calls `procedure` in `realm` (io.macula by default) at any trusted provider, by direct dial. */
export async function call(args: {
  procedure: string;
  callArgs?: Record<string, unknown>;
  realm?: string;
  timeoutMs?: number;
  /** How bytes in the result come back: "hex" (default) or "tagged" ({"$bytes": base64}). */
  bytes?: BytesOutput;
}): Promise<CallResult> {
  const start = Date.now();
  const payload = toJsonValue(args.callArgs ?? {});
  const pool = await sharedPool();
  try {
    const result = await pool.call(realmOf(args.realm), args.procedure, payload, { timeoutMs: args.timeoutMs, bytes: args.bytes });
    return { procedure: args.procedure, payload: result, duration_ms: Date.now() - start };
  } catch (e) {
    throw toMeshError(e);
  }
}

// ---- publish / subscribe / watch ----------------------------------------

/** Publishes `fact` on `topic` in `realm` (io.macula by default), signed. There is no ack. */
export async function publish(args: { topic: string; fact: Record<string, unknown>; realm?: string }): Promise<{ topic: string; duration_ms: number }> {
  const start = Date.now();
  const fact = toJsonValue(args.fact);
  const pool = await sharedPool();
  try {
    await pool.publish(realmOf(args.realm), args.topic, fact);
  } catch (e) {
    throw toMeshError(e);
  }
  return { topic: args.topic, duration_ms: Date.now() - start };
}

/** Subscribes to `topic` in `realm` (io.macula by default) until the returned subscription is stopped or the pool closes. */
export async function subscribe(args: {
  topic: string;
  realm?: string;
  onEvent: (event: Event) => void;
  bytes?: BytesOutput;
}): Promise<Subscription> {
  const pool = await sharedPool();
  try {
    return await pool.subscribe(realmOf(args.realm), args.topic, args.onEvent, { bytes: args.bytes });
  } catch (e) {
    throw toMeshError(e);
  }
}

export interface WatchedEvent {
  topic: string;
  publisher: string;
  seq: number;
  payload: JsonValue;
}

/** Hears `topic` for `durationSeconds`, or until `count` events arrived, and returns them. */
export async function watch(args: {
  topic: string;
  durationSeconds: number;
  count?: number;
  realm?: string;
  bytes?: BytesOutput;
}): Promise<WatchedEvent[]> {
  const events: WatchedEvent[] = [];
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => (done = resolve));
  const sub = await subscribe({
    topic: args.topic,
    realm: args.realm,
    bytes: args.bytes,
    onEvent: (e) => {
      if (args.count && events.length >= args.count) return;
      events.push({ topic: e.topic, publisher: e.publisher, seq: e.seq, payload: e.payload });
      if (args.count && events.length >= args.count) done();
    },
  });
  const timer = setTimeout(done, Math.max(1, Math.round(args.durationSeconds * 1000)));
  try {
    await Promise.race([finished, sub.closed.then(() => undefined)]);
  } finally {
    clearTimeout(timer);
    await sub.stop().catch(() => {});
  }
  return events;
}

// ---- serving ---------------------------------------------------------------

const OWN_NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * `name` in this node's own namespace, `~<node_id>/<name>`: a procedure
 * only this node can serve, authorized by its advertisement's signature
 * alone, that any node calls with no realm key. One segment of letters,
 * digits, `_`, `.` and `-`.
 */
export async function ownProcedure(name: string): Promise<string> {
  if (!OWN_NAME.test(name)) {
    throw new MeshError(`"${name}" is not a procedure name: one segment of letters, digits, "_", "." and "-"`);
  }
  return `~${await selfNodeId()}/${name}`;
}

/**
 * Serves `procedure` in `realm` (io.macula by default) on every link of the
 * pool, which advertises, renews and re-advertises it after a redial:
 * `handler` answers each call with the caller's verified node_id, and an
 * error it throws goes back as a handler_error with its message.
 */
export async function serve(args: {
  procedure: string;
  realm?: string;
  handler: (request: Request) => JsonValue | Promise<JsonValue>;
  bytes?: BytesOutput;
}): Promise<Served> {
  const pool = await sharedPool();
  try {
    return await pool.serve(realmOf(args.realm), args.procedure, args.handler, { bytes: args.bytes });
  } catch (e) {
    throw toMeshError(e);
  }
}

// ---- content ---------------------------------------------------------------

/**
 * Shares data in `realm` (io.macula by default): this node keeps it, serves it
 * on its own ~<node_id>/content_v1 and announces it for as long as this
 * process runs, and returns its content id (MCID) as hex. Data of at most 256
 * KiB is one block; larger data a manifest over 256 KiB chunks, named name.
 */
export async function shareContent(args: { data: Uint8Array; name?: string; realm?: string }): Promise<string> {
  const pool = await sharedPool();
  try {
    return await pool.shareContent(realmOf(args.realm), args.data, args.name ?? "");
  } catch (e) {
    throw toMeshError(e);
  }
}

/**
 * The content `mcidHex` names in `realm` (io.macula by default), fetched from
 * a node that shares it and checked against the content id: no sharer is
 * trusted. Nobody sharing it is code not_shared; every sharer failing, code
 * unavailable.
 */
export async function getContent(args: { mcidHex: string; realm?: string }): Promise<Uint8Array> {
  const pool = await sharedPool();
  try {
    return await pool.getContent(realmOf(args.realm), args.mcidHex, {});
  } catch (e) {
    throw toMeshError(e);
  }
}

// ---- DHT ----------------------------------------------------------------

export interface DecodedRecord {
  type: number;
  key_id: string;
  created_at_ms: number;
  expires_at_ms: number;
  payload: JsonValue;
  procedure_advertisement?: {
    realm: string;
    procedure: string;
    advertiser_node: string;
    serving_station: string;
  };
}

const RECORD_TYPES: Record<string, number> = {
  node_record: RecordType.NodeRecord,
  procedure_advertisement: RecordType.ProcedureAdvertisement,
  tombstone: RecordType.Tombstone,
  content_announcement: RecordType.ContentAnnouncement,
  station_endpoint: RecordType.StationEndpoint,
  org_directory: RecordType.OrgDirectory,
  procedure_delegation: RecordType.ProcedureDelegation,
};

/** The record type names find-by-type accepts. */
export const RECORD_TYPE_NAMES = Object.keys(RECORD_TYPES);

function plainHex(v: unknown): string {
  return typeof v === "string" && v.startsWith("0x") ? v.slice(2) : String(v ?? "");
}

/** A verified record as the tools report it; a procedure advertisement's fields decoded as plain hex. */
export function decodeRecord(r: DhtRecord): DecodedRecord {
  const out: DecodedRecord = {
    type: r.type,
    key_id: r.keyId,
    created_at_ms: r.createdAt,
    expires_at_ms: r.expiresAt,
    payload: r.payload,
  };
  const p = r.payload;
  if (r.type === RecordType.ProcedureAdvertisement && p && typeof p === "object" && !Array.isArray(p)) {
    out.procedure_advertisement = {
      realm: plainHex(p.realm_id),
      procedure: String(p.procedure ?? ""),
      advertiser_node: plainHex(p.advertiser_node),
      serving_station: plainHex(p.serving_station),
    };
  }
  return out;
}

function key32(hex: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new MeshError("a DHT key is 32 bytes: 64 hex characters");
  return hex.toLowerCase();
}

/** The verified record under `keyHex`, or null. */
export async function findRecord(args: { keyHex: string }): Promise<DecodedRecord | null> {
  const key = key32(args.keyHex);
  const pool = await sharedPool();
  try {
    const r = await pool.findRecord(key);
    return r ? decodeRecord(r) : null;
  } catch (e) {
    throw toMeshError(e);
  }
}

/** Every verified record under `keyHex`, and how many did not verify. */
export async function findRecords(args: { keyHex: string }): Promise<{ count: number; dropped: number; records: DecodedRecord[] }> {
  const key = key32(args.keyHex);
  const pool = await sharedPool();
  try {
    const { records, dropped } = await pool.findRecords(key);
    return { count: records.length, dropped, records: records.map(decodeRecord) };
  } catch (e) {
    throw toMeshError(e);
  }
}

/** Every verified record of a type (a name from RECORD_TYPE_NAMES, or 0-255), and how many did not verify. */
export async function findRecordsByType(args: { recordType: string }): Promise<{ type: number; count: number; dropped: number; records: DecodedRecord[] }> {
  const type = RECORD_TYPES[args.recordType] ?? (/^\d+$/.test(args.recordType) ? Number(args.recordType) : NaN);
  if (!Number.isInteger(type) || type < 0 || type > 255) {
    throw new MeshError(`record_type "${args.recordType}" is not one of ${RECORD_TYPE_NAMES.join(", ")} or a number 0-255`);
  }
  const pool = await sharedPool();
  try {
    const { records, dropped } = await pool.findRecordsByType(type);
    return { type, count: records.length, dropped, records: records.map(decodeRecord) };
  } catch (e) {
    throw toMeshError(e);
  }
}

/**
 * The realm `procedure` is advertised in, from the verified advertisements
 * the stations hold: for a service whose realm the caller does not know
 * (mcl-stations, mcl-rag, mcl-citizens). Refused by name when nothing
 * advertises it.
 */
export async function discoverProcedureRealm(procedure: string): Promise<string> {
  const found = await findRecordsByType({ recordType: "procedure_advertisement" });
  const match = found.records.find((r) => r.procedure_advertisement?.procedure === procedure);
  const realm = match?.procedure_advertisement?.realm;
  if (!realm) {
    throw new MeshError(`${procedure} is not advertised on the mesh right now (${found.count} procedure advertisement(s) checked)`);
  }
  return realm;
}

// ---- key possession --------------------------------------------------------

/**
 * A proof that this server holds its identity key, as macula-realm checks
 * one (DeviceKeyOwnershipProof): the key as carried, and the key's
 * signature over carried key ++ timestamp (8 bytes, big-endian, ms) ++
 * `procedure`. Sign right before sending; the realm allows 60 s of skew.
 */
export async function proveKeyPossession(procedure: string): Promise<{ public_key: string; timestamp: number; signature: string }> {
  const key = await nodeKey();
  const carried = key.publicKey();
  const timestamp = Date.now();
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64BE(BigInt(timestamp));
  const message = Buffer.concat([Buffer.from(carried), ts, Buffer.from(procedure, "utf8")]);
  const signature = await key.sign(new Uint8Array(message));
  return { public_key: Buffer.from(carried).toString("base64"), timestamp, signature: Buffer.from(signature).toString("hex") };
}
