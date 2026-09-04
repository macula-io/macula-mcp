import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity, PubsubEvent, Session } from "@macula-io/ts";
import { closeRoster, listAgents } from "./roster.js";

// Boundary mock, same pattern as ring_service.test.ts's ./serve.js mock
// and mesh_call.test.ts's own convention: replace
// the module presence.ts talks to the mesh THROUGH, not the mesh
// client library itself -- presence.ts never imports @macula-io/ts's
// Session/Identity classes directly except as types.
vi.mock("./macula_ts_client.js", () => ({
  connectWithFallback: vi.fn(),
  loadOrGenerateIdentity: vi.fn(),
  publish: vi.fn(),
  toCliError: vi.fn((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
  tsIdentity: vi.fn(),
}));
// Presence's OWN reconnect/heartbeat/subscription-wiring is this
// suite's subject -- citizenship/lobby/ring/realm are each already
// covered by their own test files, so stub them the same trivial way
// ring_service.test.ts stubs ./serve.js/./rooms.js.
vi.mock("./citizenship.js", () => ({
  start: vi.fn().mockResolvedValue({ registered: false }),
  stop: vi.fn(),
  displayName: (op?: string, via?: string, handle?: string) => op ?? handle ?? via ?? "macula-mcp agent",
}));
vi.mock("./lobby_observer.js", () => ({
  LOBBY_TOPIC: "agents.lobby",
  start: vi.fn().mockResolvedValue({}),
  stop: vi.fn(),
}));
vi.mock("./ring_service.js", () => ({
  start: vi.fn().mockResolvedValue({ serving: 0 }),
  stop: vi.fn().mockResolvedValue(undefined),
  status: vi.fn().mockReturnValue({ serving: 0 }),
}));
vi.mock("./realm.js", () => ({
  orgHandle: vi.fn().mockReturnValue(undefined),
  status: vi.fn().mockReturnValue({ joined: 0 }),
}));

import { connectWithFallback, loadOrGenerateIdentity, publish, tsIdentity } from "./macula_ts_client.js";
import * as presence from "./presence.js";

const NODE_ID = "a".repeat(64);
const DEFAULT_IDENTITY_PATH = "test-default-identity";
const PRESENCE_IDENTITY_PATH = "test-presence-identity";
const PRESENCE_GOODBYE_IDENTITY_PATH = "test-presence-goodbye-identity";

interface FakeSession {
  session: Session;
  subscribeCalls: { topic: string; handler: (evt: PubsubEvent) => void; onClosed?: (e: Error) => void }[];
  stopFn: ReturnType<typeof vi.fn>;
  closeFn: ReturnType<typeof vi.fn>;
}

function makeFakeSession(): FakeSession {
  const subscribeCalls: FakeSession["subscribeCalls"] = [];
  const stopFn = vi.fn().mockResolvedValue(undefined);
  const closeFn = vi.fn().mockResolvedValue(undefined);
  const session = {
    subscribe: vi.fn(async (topic: string, handler: (evt: PubsubEvent) => void, opts?: { onClosed?: (e: Error) => void }) => {
      subscribeCalls.push({ topic, handler, onClosed: opts?.onClosed });
      return stopFn;
    }),
    close: closeFn,
  } as unknown as Session;
  return { session, subscribeCalls, stopFn, closeFn };
}

function fakeIdentity(path: string) {
  return { path, dispose: vi.fn() } as unknown as Identity;
}

function fakeEvent(payload: Record<string, unknown>): PubsubEvent {
  return { payload, publisher: new Uint8Array(32), seq: 1 };
}

let createdSessions: FakeSession[];

/** Default connectWithFallback: a fresh fake session on every call, recorded in order (hello, goodbye, then every reconnect after). Individual tests override specific calls with mockImplementationOnce/mockRejectedValueOnce to simulate a connect failure. */
function queueDefaultConnects(): void {
  vi.mocked(connectWithFallback).mockImplementation(async () => {
    const s = makeFakeSession();
    createdSessions.push(s);
    return s.session;
  });
}

beforeEach(() => {
  process.env.MACULA_MCP_IDENTITY = DEFAULT_IDENTITY_PATH;
  process.env.MACULA_MCP_PRESENCE_IDENTITY = PRESENCE_IDENTITY_PATH;
  process.env.MACULA_MCP_PRESENCE_GOODBYE_IDENTITY = PRESENCE_GOODBYE_IDENTITY_PATH;
  process.env.MACULA_MCP_ROSTER_DB = ":memory:";
  process.env.MACULA_MCP_NO_CITIZENSHIP = "1";

  createdSessions = [];
  vi.mocked(loadOrGenerateIdentity).mockImplementation((path: string) => fakeIdentity(path));
  vi.mocked(tsIdentity).mockReturnValue({ node_id: NODE_ID, path: DEFAULT_IDENTITY_PATH, generated: false });
  vi.mocked(publish).mockResolvedValue({ topic: "x", duration_ms: 1 });
  queueDefaultConnects();
});

afterEach(async () => {
  if (presence.isActive()) await presence.stop();
  vi.useRealTimers();
  vi.resetAllMocks();
  closeRoster();
  delete process.env.MACULA_MCP_IDENTITY;
  delete process.env.MACULA_MCP_PRESENCE_IDENTITY;
  delete process.env.MACULA_MCP_PRESENCE_GOODBYE_IDENTITY;
  delete process.env.MACULA_MCP_ROSTER_DB;
  delete process.env.MACULA_MCP_NO_CITIZENSHIP;
});

describe("start()", () => {
  it("opens two Sessions under two DIFFERENT identities, subscribed to agent.hello and agent.goodbye", async () => {
    const result = await presence.start({});

    expect(result).toMatchObject({ node_id: NODE_ID, already_active: false, citizen_did: NODE_ID });
    expect(vi.mocked(loadOrGenerateIdentity).mock.calls.map((c) => c[0])).toEqual([
      PRESENCE_IDENTITY_PATH,
      PRESENCE_GOODBYE_IDENTITY_PATH,
    ]);
    expect(createdSessions).toHaveLength(2);
    expect(createdSessions[0]!.subscribeCalls).toHaveLength(1);
    expect(createdSessions[0]!.subscribeCalls[0]!.topic).toBe(presence.HELLO_TOPIC);
    expect(createdSessions[1]!.subscribeCalls).toHaveLength(1);
    expect(createdSessions[1]!.subscribeCalls[0]!.topic).toBe(presence.GOODBYE_TOPIC);
  });

  it("announces immediately: publish() is called once before start() resolves, under the DEFAULT identity (not either subscribe leg's)", async () => {
    await presence.start({ operatorName: "raf", message: "hi" });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: presence.HELLO_TOPIC,
        identityPath: DEFAULT_IDENTITY_PATH,
        fact: expect.objectContaining({ node_id: NODE_ID, citizen_did: NODE_ID, operator_name: "raf", message: "hi" }),
      }),
    );
  });

  it("the hello subscription's handler upserts the roster; the goodbye subscription's handler removes from it", async () => {
    await presence.start({});
    const helloHandler = createdSessions[0]!.subscribeCalls[0]!.handler;
    const goodbyeHandler = createdSessions[1]!.subscribeCalls[0]!.handler;
    const PEER = "b".repeat(64);

    helloHandler(fakeEvent({ node_id: PEER, operator_name: "Bob", model: "sonnet" }));
    expect(listAgents(1, 10).agents).toEqual([expect.objectContaining({ node_id: PEER, operator_name: "Bob", model: "sonnet" })]);

    goodbyeHandler(fakeEvent({ node_id: PEER }));
    expect(listAgents(1, 10).agents).toEqual([]);
  });

  it("if the goodbye leg's first connect fails, the hello leg it already opened is closed and its identity disposed, and start() rejects", async () => {
    vi.mocked(connectWithFallback)
      .mockImplementationOnce(async () => {
        const s = makeFakeSession();
        createdSessions.push(s);
        return s.session;
      })
      .mockImplementationOnce(async () => {
        throw new Error("station unreachable");
      });

    await expect(presence.start({})).rejects.toThrow(/station unreachable/);

    expect(createdSessions).toHaveLength(1);
    const hello = createdSessions[0]!;
    expect(hello.stopFn).toHaveBeenCalledTimes(1);
    expect(hello.closeFn).toHaveBeenCalledTimes(1);
    const helloIdentity = vi.mocked(loadOrGenerateIdentity).mock.results[0]!.value as ReturnType<typeof fakeIdentity>;
    expect(helloIdentity.dispose).toHaveBeenCalledTimes(1);
    expect(presence.isActive()).toBe(false);
  });
});

describe("heartbeat", () => {
  it("republishes on the configured interval, and a failed tick does not stop the next one", async () => {
    vi.useFakeTimers();
    await presence.start({ intervalSeconds: 10 });
    expect(publish).toHaveBeenCalledTimes(1); // the immediate announce

    vi.mocked(publish).mockRejectedValueOnce(new Error("transient mesh outage"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(publish).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(publish).toHaveBeenCalledTimes(3); // recovered on the very next tick, nothing crashed
  });
});

describe("reconnect", () => {
  it("a subscribe leg's onClosed reconnects with backoff and resumes delivering events on the fresh session", async () => {
    vi.useFakeTimers();
    await presence.start({});
    const hello = createdSessions[0]!;
    const onClosed = hello.subscribeCalls[0]!.onClosed;
    expect(onClosed).toBeTypeOf("function");

    // First reconnect attempt (after the 1s base backoff) itself fails --
    // proves this isn't a fail-once-then-give-up loop.
    vi.mocked(connectWithFallback).mockImplementationOnce(async () => {
      throw new Error("still unreachable");
    });
    onClosed!(new Error("connection reset"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connectWithFallback).toHaveBeenCalledTimes(3); // 2 initial legs + this failed retry

    // Second attempt (2s backoff, doubled) succeeds against a brand new session.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(connectWithFallback).toHaveBeenCalledTimes(4);
    expect(createdSessions).toHaveLength(3); // hello (dead), goodbye, reconnected hello
    const reconnected = createdSessions[2]!;
    expect(reconnected.subscribeCalls).toHaveLength(1);
    expect(reconnected.subscribeCalls[0]!.topic).toBe(presence.HELLO_TOPIC);

    // And the reconnected leg is genuinely live: an event on ITS handler still reaches the roster.
    const PEER = "c".repeat(64);
    reconnected.subscribeCalls[0]!.handler(fakeEvent({ node_id: PEER }));
    expect(listAgents(1, 10).agents).toEqual([expect.objectContaining({ node_id: PEER })]);
  });

  it("does not reconnect once stop() has begun tearing the leg down", async () => {
    await presence.start({});
    const hello = createdSessions[0]!;
    const onClosed = hello.subscribeCalls[0]!.onClosed!;
    await presence.stop();

    createdSessions.length = 0;
    vi.mocked(connectWithFallback).mockClear();
    onClosed(new Error("connection reset, but presence already left"));
    await Promise.resolve();
    expect(connectWithFallback).not.toHaveBeenCalled();
    expect(createdSessions).toHaveLength(0);
  });
});

describe("stop()", () => {
  it("publishes agent.goodbye under the default identity, then closes both sessions and disposes both identities", async () => {
    await presence.start({});
    vi.mocked(publish).mockClear();
    const [hello, goodbye] = createdSessions;

    const result = await presence.stop();

    expect(result).toEqual({ said_goodbye: true });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: presence.GOODBYE_TOPIC, identityPath: DEFAULT_IDENTITY_PATH, fact: expect.objectContaining({ node_id: NODE_ID }) }),
    );
    expect(hello!.stopFn).toHaveBeenCalledTimes(1);
    expect(hello!.closeFn).toHaveBeenCalledTimes(1);
    expect(goodbye!.stopFn).toHaveBeenCalledTimes(1);
    expect(goodbye!.closeFn).toHaveBeenCalledTimes(1);
    for (const r of vi.mocked(loadOrGenerateIdentity).mock.results) {
      expect((r.value as ReturnType<typeof fakeIdentity>).dispose).toHaveBeenCalledTimes(1);
    }
    expect(presence.isActive()).toBe(false);
  });

  it("is a no-op when presence was never active", async () => {
    expect(await presence.stop()).toEqual({ said_goodbye: false });
    expect(publish).not.toHaveBeenCalled();
  });

  it("stays honored: ensurePresence() does not silently restart presence right after an explicit stop()", async () => {
    await presence.start({});
    await presence.stop();
    expect(presence.isActive()).toBe(false);
    // ensurePresence() is fire-and-forget by design (see its own doc) --
    // give its background start a tick to have kicked off if it were
    // going to, then confirm it genuinely didn't.
    presence.ensurePresence({ server: { getClientVersion: () => undefined } } as never);
    await Promise.resolve();
    await Promise.resolve();
    expect(presence.isActive()).toBe(false);
  });
});
