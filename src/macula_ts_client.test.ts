// The client layer against a fake @macula-io/ts: Pool.connect and
// NodeKey.loadOrCreate are the two boundaries that would touch the network
// or the key file; everything this module does on top of them (one pool
// shared by every caller, the io.macula default realm, errors as
// MeshError, DHT records decoded) is exercised for real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { poolConnect, loadOrCreate } = vi.hoisted(() => ({ poolConnect: vi.fn(), loadOrCreate: vi.fn() }));

vi.mock("@macula-io/ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@macula-io/ts")>();
  return { ...actual, Pool: { connect: poolConnect }, NodeKey: { loadOrCreate } };
});

import { ContentUnavailableError, MaculaError, NotSharedError, ProviderError, RelayError, RecordType } from "@macula-io/ts";
import {
  call,
  ownProcedure,
  serve,
  shareContent,
  getContent,
  decodeRecord,
  discoverProcedureRealm,
  subscribe,
  findRecordsByType,
  publish,
  resetForTests,
  selfNodeId,
  watch,
} from "./macula_ts_client.js";
import { droppedEvents, onLoss } from "./dropped_events.js";
import { DEFAULT_SEEDS, IO_MACULA_REALM_ID, IO_MACULA_REALM_KEY, MeshError } from "./mesh_config.js";

const SELF = "00".repeat(31) + "01";

function fakePool() {
  return {
    call: vi.fn(async () => ({ ok: 1 })),
    publish: vi.fn(async () => {}),
    subscribe: vi.fn(async () => ({ stop: vi.fn(async () => {}), closed: new Promise(() => {}), dropped: () => 0 })),
    findRecordsByType: vi.fn(async () => ({ records: [], dropped: 0 })),
    serve: vi.fn(async () => ({ stop: vi.fn() })),
    shareContent: vi.fn(async () => "0255" + "ab".repeat(48)),
    getContent: vi.fn(async () => new Uint8Array([1, 2, 3])),
    close: vi.fn(async () => {}),
  };
}

let pool: ReturnType<typeof fakePool>;

beforeEach(() => {
  pool = fakePool();
  poolConnect.mockReset().mockResolvedValue(pool);
  loadOrCreate.mockReset().mockResolvedValue({ nodeIdHex: () => SELF });
});

afterEach(async () => {
  await resetForTests();
});

describe("the shared pool", () => {
  it("is connected once, under the one key, to every seed with io.macula trusted, however many callers race", async () => {
    await Promise.all([call({ procedure: "mcl-echo/echo" }), publish({ topic: "t.said_v1", fact: {} }), selfNodeId()]);
    expect(poolConnect).toHaveBeenCalledTimes(1);
    expect(loadOrCreate).toHaveBeenCalledTimes(1);
    const [key, seeds, opts] = poolConnect.mock.calls[0]!;
    expect(key.nodeIdHex()).toBe(SELF);
    expect(seeds).toEqual(DEFAULT_SEEDS);
    expect(opts.realmTrust).toEqual([{ realm: IO_MACULA_REALM_ID, key: IO_MACULA_REALM_KEY }]);
    expect(loadOrCreate.mock.calls[0]![1]).toBe("pq_hybrid");
  });

  it("is connected again after a failed connect, not stuck with the rejection", async () => {
    poolConnect.mockRejectedValueOnce(new Error("no station answered"));
    await expect(call({ procedure: "mcl-echo/echo" })).rejects.toThrow(/no station answered/);
    await expect(call({ procedure: "mcl-echo/echo" })).resolves.toMatchObject({ payload: { ok: 1 } });
    expect(poolConnect).toHaveBeenCalledTimes(2);
  });
});

describe("call", () => {
  it("defaults to io.macula, passes the realm given, and reports the result with its duration", async () => {
    const res = await call({ procedure: "mcl-echo/echo", callArgs: { text: "hi" } });
    expect(res.payload).toEqual({ ok: 1 });
    expect(pool.call).toHaveBeenCalledWith(IO_MACULA_REALM_ID, "mcl-echo/echo", { text: "hi" }, expect.any(Object));
    await call({ procedure: "x/y", realm: "AB".repeat(32), timeoutMs: 900, bytes: "tagged" });
    expect(pool.call).toHaveBeenLastCalledWith("ab".repeat(32), "x/y", {}, { timeoutMs: 900, bytes: "tagged" });
  });

  it("refuses a boolean argument by name before anything reaches the wire", async () => {
    await expect(call({ procedure: "x/y", callArgs: { urgent: true } })).rejects.toThrow(/"urgent" is a boolean/);
    expect(pool.call).not.toHaveBeenCalled();
  });

  it("brings a provider's error back as a MeshError with its code", async () => {
    pool.call.mockRejectedValueOnce(new ProviderError("handler_error", "no such mailbox"));
    const e = await call({ procedure: "x/y" }).catch((err) => err);
    expect(e).toBeInstanceOf(MeshError);
    expect(e).toMatchObject({ code: "handler_error", from: "provider" });
    expect(e.message).toMatch(/no such mailbox/);
  });

  it("brings a station's relay error back as a MeshError with its code", async () => {
    pool.call.mockRejectedValueOnce(new RelayError("unknown_next_peer"));
    await expect(call({ procedure: "x/y" })).rejects.toMatchObject({ code: "unknown_next_peer", from: "station" });
  });

  it("sends, with proveOwnership, the payload as the node key's ownershipProof made it, and only then", async () => {
    const proven = { text: "hi", asserted_by: { identity: SELF, proof: { v: 2 } } };
    const ownershipProof = vi.fn(async () => proven);
    loadOrCreate.mockResolvedValue({ nodeIdHex: () => SELF, ownershipProof });
    await call({ procedure: "mcl-graph/learn_link", callArgs: { text: "hi" }, realm: "AB".repeat(32), proveOwnership: true });
    expect(ownershipProof).toHaveBeenCalledWith("ab".repeat(32), "mcl-graph/learn_link", { text: "hi" });
    expect(pool.call).toHaveBeenLastCalledWith("ab".repeat(32), "mcl-graph/learn_link", proven, expect.any(Object));
    await call({ procedure: "mcl-echo/echo", callArgs: { text: "hi" } });
    expect(ownershipProof).toHaveBeenCalledTimes(1);
    await call({ procedure: "x/y", proveOwnership: true });
    expect(ownershipProof).toHaveBeenLastCalledWith(IO_MACULA_REALM_ID, "x/y", {});
    await call({ procedure: "mcl-echo/echo", callArgs: { text: "hi" } });
    expect(pool.call).toHaveBeenLastCalledWith(IO_MACULA_REALM_ID, "mcl-echo/echo", { text: "hi" }, expect.any(Object));
  });

  it("brings an ownership proof's refusal back as a MeshError with its kind, and calls nothing", async () => {
    const ownershipProof = vi.fn(async () => {
      throw new MaculaError("invalid_argument", "an ownership-proven payload carries \"caller\", which a station replaces; leave it out");
    });
    loadOrCreate.mockResolvedValue({ nodeIdHex: () => SELF, ownershipProof });
    const e = await call({ procedure: "x/y", callArgs: { caller: "me" }, proveOwnership: true }).catch((err) => err);
    expect(e).toBeInstanceOf(MeshError);
    expect(e).toMatchObject({ code: "invalid_argument" });
    expect(e.message).toMatch(/caller/);
    expect(pool.call).not.toHaveBeenCalled();
  });
});

describe("publish and watch", () => {
  it("publishes in io.macula unless told otherwise", async () => {
    await publish({ topic: "agents.lobby", fact: { kind: "remark_made" } });
    expect(pool.publish).toHaveBeenCalledWith(IO_MACULA_REALM_ID, "agents.lobby", { kind: "remark_made" });
  });

  it("returns what arrived once count events are in, and ends its subscription", async () => {
    const stop = vi.fn(async () => {});
    pool.subscribe.mockImplementation(async (_realm: string, _topic: string, onEvent: (e: unknown) => void) => {
      setTimeout(() => {
        for (const seq of [1, 2, 3]) onEvent({ publisher: "aa".repeat(32), topic: "t.x", seq, payload: { n: seq } });
      }, 5);
      return { stop, closed: new Promise(() => {}), dropped: () => 0 };
    });
    const { events, dropped } = await watch({ topic: "t.x", durationSeconds: 5, count: 2 });
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events[0]).toEqual({ topic: "t.x", publisher: "aa".repeat(32), seq: 1, payload: { n: 1 } });
    expect(dropped).toBe(0);
    expect(stop).toHaveBeenCalled();
  });

  it("reports what the watch's subscription dropped, read before it stops", async () => {
    let lost = 0;
    const stop = vi.fn(async () => {
      lost = -1; // a read after stop would see this
    });
    pool.subscribe.mockImplementation(async (_realm: string, _topic: string, onEvent: (e: unknown) => void) => {
      setTimeout(() => {
        lost = 7;
        onEvent({ publisher: "aa".repeat(32), topic: "t.x", seq: 1, payload: 1 });
      }, 5);
      return { stop, closed: new Promise(() => {}), dropped: () => lost };
    });
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { events, dropped } = await watch({ topic: "t.x", durationSeconds: 5, count: 1 });
    expect(events).toHaveLength(1);
    expect(dropped).toBe(7);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/t\.x.*lost 7 event\(s\).*7 in all/);
    warn.mockRestore();
  });
});

describe("dropped events", () => {
  it("are warned about on stderr when a delivery or a read finds the count grew, once per growth", async () => {
    let lost = 0;
    let deliver: (e: unknown) => void = () => {};
    pool.subscribe.mockImplementation(async (_realm: string, _topic: string, onEvent: (e: unknown) => void) => {
      deliver = onEvent;
      return { stop: vi.fn(async () => {}), closed: new Promise(() => {}), dropped: () => lost };
    });
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const heard: unknown[] = [];
    const sub = await subscribe({ topic: "agents.lobby", onEvent: (e) => heard.push(e) });
    deliver({ seq: 1 });
    expect(warn).not.toHaveBeenCalled();
    lost = 3;
    deliver({ seq: 5 });
    expect(heard).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/agents\.lobby.*lost 3 event\(s\).*3 in all/);
    expect(droppedEvents("agents.lobby", sub)).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    lost = 4;
    expect(droppedEvents("agents.lobby", sub)).toBe(4);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]![0]).toMatch(/lost 1 event\(s\).*4 in all/);
    // A loss hook hears each growth once, whoever notices it: a delivery or a read.
    const heardLosses: number[] = [];
    onLoss(sub, (n) => heardLosses.push(n));
    lost = 6;
    deliver({ seq: 9 });
    expect(droppedEvents("agents.lobby", sub)).toBe(6);
    lost = 7;
    expect(droppedEvents("agents.lobby", sub)).toBe(7);
    expect(heardLosses).toEqual([2, 1]);
    warn.mockRestore();
  });
});

describe("DHT records", () => {
  const ad = {
    type: RecordType.ProcedureAdvertisement,
    keyId: "cc".repeat(32),
    createdAt: 1,
    expiresAt: 2,
    payload: {
      realm_id: "0x" + IO_MACULA_REALM_ID,
      procedure: "mcl-citizens/register_presence",
      advertiser_node: "0x" + "dd".repeat(32),
      serving_station: "0x" + "ee".repeat(32),
    },
    wire: { $bytes: "AA==" },
  };

  it("decode a procedure advertisement's realm, procedure and nodes as plain hex", () => {
    expect(decodeRecord(ad).procedure_advertisement).toEqual({
      realm: IO_MACULA_REALM_ID,
      procedure: "mcl-citizens/register_presence",
      advertiser_node: "dd".repeat(32),
      serving_station: "ee".repeat(32),
    });
  });

  it("find by a type name, and report how many records did not verify", async () => {
    pool.findRecordsByType.mockResolvedValueOnce({ records: [ad], dropped: 2 });
    const res = await findRecordsByType({ recordType: "procedure_advertisement" });
    expect(pool.findRecordsByType).toHaveBeenCalledWith(RecordType.ProcedureAdvertisement);
    expect(res).toMatchObject({ type: 6, count: 1, dropped: 2 });
  });

  it("refuse an unknown type name", async () => {
    await expect(findRecordsByType({ recordType: "nonsense" })).rejects.toThrow(MeshError);
  });

  it("discover the realm a procedure is advertised in, or say it is advertised nowhere", async () => {
    pool.findRecordsByType.mockResolvedValue({ records: [ad], dropped: 0 });
    await expect(discoverProcedureRealm("mcl-citizens/register_presence")).resolves.toBe(IO_MACULA_REALM_ID);
    await expect(discoverProcedureRealm("mcl-nothing/at_all")).rejects.toThrow(/mcl-nothing\/at_all is not advertised/);
  });
});

describe("realm proof v2", () => {
  it("is the node key's deviceRequestProof for the realm, procedure, request and rule given", async () => {
    const proof = { v: 2, timestamp: 1, nonce: "00".repeat(16), signature: "ab" };
    const deviceRequestProof = vi.fn(async () => proof);
    loadOrCreate.mockResolvedValue({ nodeIdHex: () => SELF, publicKey: () => new Uint8Array([1, 2, 3]), deviceRequestProof });
    const { carriedPublicKey, proveDeviceRequest } = await import("./macula_ts_client.js");
    const request = { public_key: "AQID", ttl_seconds: 60 };
    await expect(proveDeviceRequest(IO_MACULA_REALM_ID, "macula_realm.membership_ucan", request, "mesh")).resolves.toEqual(proof);
    expect(deviceRequestProof).toHaveBeenCalledWith(IO_MACULA_REALM_ID, "macula_realm.membership_ucan", request, "mesh");
    await expect(carriedPublicKey()).resolves.toBe("AQID");
  });
});

describe("serving in this node's own namespace", () => {
  it("names ~<node_id>/<name>, and serves it in io.macula with the handler given", async () => {
    expect(await ownProcedure("ring")).toBe(`~${SELF}/ring`);
    const handler = vi.fn();
    await serve({ procedure: `~${SELF}/ring`, handler });
    expect(pool.serve).toHaveBeenCalledWith(IO_MACULA_REALM_ID, `~${SELF}/ring`, handler, { bytes: undefined });
  });

  it("refuses a name that is not one segment", async () => {
    await expect(ownProcedure("a/b")).rejects.toThrow(MeshError);
    await expect(ownProcedure("")).rejects.toThrow(MeshError);
  });
});

describe("content", () => {
  it("shares bytes in io.macula and fetches a content id, both by the pool", async () => {
    expect(await shareContent({ data: new Uint8Array([9]), name: "a.txt" })).toBe("0255" + "ab".repeat(48));
    expect(pool.shareContent).toHaveBeenCalledWith(IO_MACULA_REALM_ID, new Uint8Array([9]), "a.txt");
    expect(await getContent({ mcidHex: "0255" + "ab".repeat(48) })).toEqual(new Uint8Array([1, 2, 3]));
    expect(pool.getContent).toHaveBeenCalledWith(IO_MACULA_REALM_ID, "0255" + "ab".repeat(48), {});
  });

  it("brings content nobody shares, and content no sharer gave, back as MeshErrors with their codes", async () => {
    pool.getContent.mockRejectedValueOnce(new NotSharedError());
    await expect(getContent({ mcidHex: "0255" + "ab".repeat(48) })).rejects.toMatchObject({ code: "not_shared" });
    pool.getContent.mockRejectedValueOnce(new ContentUnavailableError("sharer 00ab: timeout"));
    await expect(getContent({ mcidHex: "0255" + "ab".repeat(48) })).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("00ab") });
  });
});
