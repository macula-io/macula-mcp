import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@macula-io/ts";
import { closeRoster, listAgents } from "./roster.js";

// Boundary mock: the client layer presence talks to the mesh through.
vi.mock("./macula_ts_client.js", () => ({
  selfNodeId: vi.fn(),
  publish: vi.fn(),
  subscribe: vi.fn(),
}));
// Citizenship, lobby, rings and realm each have their own suites; presence
// only starts and stops them.
vi.mock("./citizenship.js", () => ({
  start: vi.fn().mockResolvedValue({ registered: false }),
  stop: vi.fn(),
  displayName: (op?: string, via?: string, handle?: string) => op ?? handle ?? via ?? "macula-mcp agent",
}));
vi.mock("./lobby_observer.js", () => ({
  LOBBY_TOPIC: "agents.lobby",
  start: vi.fn().mockResolvedValue({}),
  stop: vi.fn(),
  isTapped: vi.fn().mockReturnValue(true),
  tapRoom: vi.fn(),
  untapRoom: vi.fn(),
}));
vi.mock("./ring_agents/serve_rings.js", () => ({
  start: vi.fn().mockResolvedValue({ serving: 0 }),
  stop: vi.fn().mockResolvedValue(undefined),
  status: vi.fn().mockReturnValue({ serving: 0 }),
}));
vi.mock("./realm.js", () => ({
  orgHandle: vi.fn().mockReturnValue(undefined),
  status: vi.fn().mockReturnValue({ joined: 0 }),
}));
vi.mock("./device_membership.js", () => ({
  ensureAutoJoin: vi.fn().mockResolvedValue(undefined),
  keepMembershipsRenewed: vi.fn().mockReturnValue(undefined),
}));

import { publish, selfNodeId, subscribe } from "./macula_ts_client.js";
import * as ringService from "./ring_agents/serve_rings.js";
import { closeRings } from "./ring_agents/rings.js";
import * as presence from "./presence.js";

const NODE_ID = "a".repeat(64);
const PEER = "b".repeat(64);

interface FakeSub {
  topic: string;
  onEvent: (e: Event) => void;
  stop: ReturnType<typeof vi.fn>;
  lost: number;
}
let subs: FakeSub[];

function event(publisher: string, payload: Record<string, unknown>): Event {
  return { publisher, realm: "00".repeat(32), topic: "t", seq: 1, publishedAt: 0, payload: payload as never, deliveredVia: "ee".repeat(32) };
}

function handlerFor(topic: string): (e: Event) => void {
  const s = subs.find((x) => x.topic === topic);
  if (!s) throw new Error(`no subscription to ${topic}`);
  return s.onEvent;
}

beforeEach(() => {
  process.env.MACULA_MCP_ROSTER_DB = ":memory:";
  process.env.MACULA_MCP_NO_CITIZENSHIP = "1";
  subs = [];
  vi.mocked(selfNodeId).mockResolvedValue(NODE_ID);
  vi.mocked(publish).mockResolvedValue({ topic: "x", duration_ms: 1 });
  vi.mocked(subscribe).mockImplementation(async (args) => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const sub = { topic: args.topic, onEvent: args.onEvent, stop, lost: 0 };
    subs.push(sub);
    return { stop, closed: new Promise(() => {}), dropped: () => sub.lost } as never;
  });
});

afterEach(async () => {
  if (presence.isActive()) await presence.stop();
  vi.useRealTimers();
  vi.resetAllMocks();
  closeRoster();
  closeRings();
  delete process.env.MACULA_MCP_ROSTER_DB;
  delete process.env.MACULA_MCP_NO_CITIZENSHIP;
  delete process.env.MACULA_MCP_RINGS_DB;
});

describe("start()", () => {
  it("subscribes to agent.hello and agent.goodbye on the shared pool and reports this node", async () => {
    const result = await presence.start({});
    expect(result).toMatchObject({ node_id: NODE_ID, already_active: false, citizen_did: NODE_ID });
    expect(subs.map((s) => s.topic).sort()).toEqual([presence.GOODBYE_TOPIC, presence.HELLO_TOPIC].sort());
  });

  it("asks realm.status() to redact any pending join link, on a fresh and on an already-active start", async () => {
    const realm = await import("./realm.js");
    await presence.start({});
    expect(realm.status).toHaveBeenCalledWith(NODE_ID, { redactPending: true });
    vi.mocked(realm.status).mockClear();
    const again = await presence.start({});
    expect(again.already_active).toBe(true);
    expect(realm.status).toHaveBeenCalledWith(NODE_ID, { redactPending: true });
  });

  it("announces immediately, with the configured interval and only the fields that are set", async () => {
    await presence.start({ operatorName: "raf", sessionName: "Jupiter", message: "hi", intervalSeconds: 45 });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      topic: presence.HELLO_TOPIC,
      fact: expect.objectContaining({ node_id: NODE_ID, citizen_did: NODE_ID, operator_name: "raf", session_name: "Jupiter", message: "hi", interval_seconds: 45 }),
    });
    await presence.stop();
    vi.mocked(publish).mockClear();
    await presence.start({ operatorName: "raf" });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ fact: expect.not.objectContaining({ session_name: expect.anything() }) }));
  });

  it("a second start() updates the session name for the next heartbeat", async () => {
    vi.useFakeTimers();
    await presence.start({ sessionName: "Jupiter", intervalSeconds: 10 });
    await presence.start({ sessionName: "Renamed" });
    vi.mocked(publish).mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ fact: expect.objectContaining({ session_name: "Renamed" }) }));
  });

  it("concurrent starts share one: two subscriptions, one announce", async () => {
    await Promise.all([presence.start({}), presence.start({}), presence.start({})]);
    expect(subs).toHaveLength(2);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("if a subscription fails, the one already made is stopped and start() rejects", async () => {
    vi.mocked(subscribe)
      .mockImplementationOnce(async (args) => {
        const stop = vi.fn().mockResolvedValue(undefined);
        subs.push({ topic: args.topic, onEvent: args.onEvent, stop });
        return { stop, closed: new Promise(() => {}) } as never;
      })
      .mockRejectedValueOnce(new Error("station unreachable"));
    await expect(presence.start({})).rejects.toThrow(/station unreachable/);
    expect(subs[0]!.stop).toHaveBeenCalledTimes(1);
    expect(presence.isActive()).toBe(false);
  });

  // Review r2 on step 6: restoring the watch used to be unguarded, so ONE stale or refused room threw out
  // of the middle of doStart -- after hello and goodbye were subscribed, before presence existed -- and the
  // agent was absent and unringable over a room it was not even talking in.
  it("starts even when a room it must re-watch refuses the tap", async () => {
    process.env.MACULA_MCP_RINGS_DB = ":memory:";
    const roomMembership = await import("./room_membership.js");
    roomMembership.record(NODE_ID, { room_topic: `agents.room.${"e".repeat(32)}`, opened_by: NODE_ID, opened_here: 1, public: 0, joined_at: new Date().toISOString() });
    const lobbyObserver = await import("./lobby_observer.js");
    vi.mocked(lobbyObserver.isTapped).mockReturnValue(false);
    vi.mocked(lobbyObserver.start).mockResolvedValue({} as never);
    vi.mocked(lobbyObserver.tapRoom).mockRejectedValue(new Error("station refused the subscription"));

    await expect(presence.start({})).resolves.toMatchObject({ node_id: NODE_ID, already_active: false });
    expect(presence.isActive()).toBe(true);
    expect(ringService.start).toHaveBeenCalled();
  });
});

describe("the roster", () => {
  it("takes a hello and a goodbye from the node that published them", async () => {
    await presence.start({});
    handlerFor(presence.HELLO_TOPIC)(event(PEER, { node_id: PEER, operator_name: "Bob", session_name: "Vega", model: "sonnet", interval_seconds: 30 }));
    expect(listAgents(1, 10).agents).toEqual([
      expect.objectContaining({ node_id: PEER, operator_name: "Bob", session_name: "Vega", model: "sonnet", interval_seconds: "30" }),
    ]);
    handlerFor(presence.GOODBYE_TOPIC)(event(PEER, { node_id: PEER }));
    expect(listAgents(1, 10).agents).toEqual([]);
  });

  it("ignores a hello or a goodbye that names a node other than its verified publisher", async () => {
    await presence.start({});
    const MALLORY = "c".repeat(64);
    handlerFor(presence.HELLO_TOPIC)(event(MALLORY, { node_id: PEER, operator_name: "not Bob" }));
    expect(listAgents(1, 10).agents).toEqual([]);
    handlerFor(presence.HELLO_TOPIC)(event(PEER, { node_id: PEER, operator_name: "Bob" }));
    handlerFor(presence.GOODBYE_TOPIC)(event(MALLORY, { node_id: PEER }));
    expect(listAgents(1, 10).agents).toEqual([expect.objectContaining({ node_id: PEER })]);
  });

  it("records a null interval when the peer's hello reports none", async () => {
    await presence.start({});
    handlerFor(presence.HELLO_TOPIC)(event(PEER, { node_id: PEER }));
    expect(listAgents(1, 10).agents[0]).toMatchObject({ interval_seconds: null });
  });
});

describe("heartbeat", () => {
  it("republishes on the configured interval, and a failed tick does not stop the next one", async () => {
    vi.useFakeTimers();
    await presence.start({ intervalSeconds: 10 });
    expect(publish).toHaveBeenCalledTimes(1);
    vi.mocked(publish).mockRejectedValueOnce(new Error("transient mesh outage"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(publish).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(publish).toHaveBeenCalledTimes(3);
  });
});

describe("dropped()", () => {
  it("is null while presence is not listening, and otherwise what hello and goodbye lost together", async () => {
    expect(presence.dropped()).toBeNull();
    await presence.start({});
    expect(presence.dropped()).toBe(0);
    subs.find((s) => s.topic === presence.HELLO_TOPIC)!.lost = 2;
    subs.find((s) => s.topic === presence.GOODBYE_TOPIC)!.lost = 3;
    expect(presence.dropped()).toBe(5);
    await presence.stop();
    expect(presence.dropped()).toBeNull();
  });
});

describe("stop()", () => {
  it("publishes agent.goodbye, then ends both subscriptions", async () => {
    await presence.start({});
    vi.mocked(publish).mockClear();
    expect(await presence.stop()).toEqual({ said_goodbye: true });
    expect(publish).toHaveBeenCalledWith({ topic: presence.GOODBYE_TOPIC, fact: expect.objectContaining({ node_id: NODE_ID }) });
    for (const s of subs) expect(s.stop).toHaveBeenCalledTimes(1);
    expect(presence.isActive()).toBe(false);
  });

  it("is a no-op when presence was never active", async () => {
    expect(await presence.stop()).toEqual({ said_goodbye: false });
    expect(publish).not.toHaveBeenCalled();
  });

  it("stays honored: ensurePresence() does not restart presence right after an explicit stop()", async () => {
    await presence.start({});
    await presence.stop();
    presence.ensurePresence({ server: { getClientVersion: () => undefined } } as never);
    await Promise.resolve();
    await Promise.resolve();
    expect(presence.isActive()).toBe(false);
  });
});

// #44 step 7: start, stop and reassert are transitions of ONE piece of state, so they are handled one at a
// time, in the order they arrived. Before the mailbox they interleaved across their awaits.
describe("the lifecycle mailbox (macula-mcp#44 step 7)", () => {
  it("a stop that arrives during a start runs after it and stops what the start began", async () => {
    // The hello subscribe is slow enough for a mesh_goodbye -- the one ensurePresence's fire-and-forget
    // start makes possible -- to arrive while the start is still in flight.
    let releaseHello!: () => void;
    const helloGate = new Promise<void>((r) => {
      releaseHello = r;
    });
    vi.mocked(subscribe).mockImplementationOnce(async (args) => {
      await helloGate;
      const stop = vi.fn().mockResolvedValue(undefined);
      const sub = { topic: args.topic, onEvent: args.onEvent, stop, lost: 0 };
      subs.push(sub);
      return { stop, closed: new Promise(() => {}), dropped: () => 0 } as never;
    });

    const starting = presence.start({ intervalSeconds: 10 });
    const stopping = presence.stop();
    releaseHello();

    await expect(starting).resolves.toMatchObject({ node_id: NODE_ID });
    // Queued behind the start, so it found a presence to tear down rather than nothing at all.
    expect(await stopping).toEqual({ said_goodbye: true });
    expect(presence.isActive()).toBe(false);
    for (const sub of subs) expect(sub.stop).toHaveBeenCalledTimes(1);
    const ringService = await import("./ring_agents/serve_rings.js");
    expect(ringService.stop).toHaveBeenCalled();
    const lobbyObserver = await import("./lobby_observer.js");
    expect(lobbyObserver.stop).toHaveBeenCalled();
    // ... and the teardown is complete, not a half-state a second stop has to finish.
    expect(await presence.stop()).toEqual({ said_goodbye: false });
  });

  it("a start that arrives during a stop runs after it, so the new presence is not torn down by the old one", async () => {
    await presence.start({});
    // Hold the goodbye publish open so the start lands mid-stop.
    let releaseGoodbye!: () => void;
    const goodbyeGate = new Promise<void>((r) => {
      releaseGoodbye = r;
    });
    vi.mocked(publish).mockImplementationOnce(async () => {
      await goodbyeGate;
      return { topic: "x", duration_ms: 1 };
    });

    const stopping = presence.stop();
    const restarting = presence.start({});
    releaseGoodbye();
    await expect(stopping).resolves.toEqual({ said_goodbye: true });
    await expect(restarting).resolves.toMatchObject({ node_id: NODE_ID });

    expect(presence.isActive()).toBe(true);
    // The restart's observer start is the LAST word on the observer: the stop that finished first cannot
    // leave the new presence unwatched.
    const lobbyObserver = await import("./lobby_observer.js");
    const lastStart = vi.mocked(lobbyObserver.start).mock.invocationCallOrder.at(-1)!;
    const lastStop = vi.mocked(lobbyObserver.stop).mock.invocationCallOrder.at(-1)!;
    expect(lastStart).toBeGreaterThan(lastStop);
    expect(subs).toHaveLength(4); // two from the first start, two from the restart
    await presence.stop();
  });
});
