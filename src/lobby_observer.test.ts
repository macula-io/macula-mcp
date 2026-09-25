import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@macula-io/ts";
import { closeTranscript, recentFacts } from "./lobby_transcript.js";
import { buildEnvelope, newRoomTopic } from "./envelope.js";

// Boundary mock: the client layer the observer subscribes through.
vi.mock("./macula_ts_client.js", () => ({
  selfNodeId: vi.fn(),
  subscribe: vi.fn(),
}));

import { selfNodeId, subscribe } from "./macula_ts_client.js";
import * as lobbyObserver from "./lobby_observer.js";

const NODE_ID = "a".repeat(64);
const ME = "c".repeat(64);
const PUBLISHER = "b".repeat(64);

interface FakeSub {
  topic: string;
  onEvent: (e: Event) => void;
  stop: ReturnType<typeof vi.fn>;
}
let subs: FakeSub[];

function event(payload: unknown): Event {
  return { publisher: PUBLISHER, realm: "00".repeat(32), topic: "t", seq: 1, publishedAt: 0, payload: payload as never, deliveredVia: "ee".repeat(32) };
}

function subscribedTo(topic: string): FakeSub {
  const s = subs.find((x) => x.topic === topic);
  if (!s) throw new Error(`no subscription to ${topic}`);
  return s;
}

beforeEach(() => {
  process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB = ":memory:";
  subs = [];
  vi.mocked(selfNodeId).mockResolvedValue(NODE_ID);
  vi.mocked(subscribe).mockImplementation(async (args) => {
    const stop = vi.fn().mockResolvedValue(undefined);
    subs.push({ topic: args.topic, onEvent: args.onEvent, stop });
    return { stop, closed: new Promise(() => {}) } as never;
  });
});

afterEach(async () => {
  if (lobbyObserver.isActive()) await lobbyObserver.stop();
  vi.resetAllMocks();
  closeTranscript();
  delete process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB;
});

describe("start()", () => {
  it("subscribes to central and reports this node", async () => {
    const result = await lobbyObserver.start({});
    expect(result).toMatchObject({ node_id: NODE_ID, lobby_topic: "agents.lobby", already_active: false });
    expect(subs.map((s) => s.topic)).toEqual(["agents.lobby"]);
  });

  it("is idempotent: a second call only raises max_rooms, never lowers it, and subscribes nothing more", async () => {
    await lobbyObserver.start({ maxRooms: 5 });
    expect((await lobbyObserver.start({ maxRooms: 9 })).max_rooms).toBe(9);
    expect((await lobbyObserver.start({ maxRooms: 2 })).max_rooms).toBe(9);
    expect(subs).toHaveLength(1);
  });

  it("rejects and stays inactive when central cannot be subscribed", async () => {
    vi.mocked(subscribe).mockRejectedValueOnce(new Error("station unreachable"));
    await expect(lobbyObserver.start({})).rejects.toThrow(/station unreachable/);
    expect(lobbyObserver.isActive()).toBe(false);
  });

  it("records central events with their verified publisher", async () => {
    await lobbyObserver.start({});
    subscribedTo("agents.lobby").onEvent(event(buildEnvelope({ room_topic: "agents.lobby", from: ME, kind: "remark_made", text: "hi everyone" })));
    const { facts } = recentFacts({ topic: "agents.lobby", limit: 10 });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ sender: ME, text: "hi everyone", publisher: PUBLISHER });
  });
});

describe("public room discovery", () => {
  it("taps a room announced on central and records its facts", async () => {
    await lobbyObserver.start({});
    const room = newRoomTopic();
    subscribedTo("agents.lobby").onEvent(event(buildEnvelope({ room_topic: room, from: ME, kind: "room_opened", text: "", purpose: "review" })));
    expect(lobbyObserver.isTapped(room)).toBe(true);
    await vi.waitFor(() => subscribedTo(room));
    subscribedTo(room).onEvent(event(buildEnvelope({ room_topic: room, from: ME, kind: "remark_made", text: "in the room" })));
    expect(recentFacts({ topic: room, limit: 10 }).facts[0]).toMatchObject({ text: "in the room", publisher: PUBLISHER });
  });

  it("does not tap a room twice, and drops public rooms over max_rooms", async () => {
    await lobbyObserver.start({ maxRooms: 1 });
    const [first, second] = [newRoomTopic(), newRoomTopic()];
    const central = subscribedTo("agents.lobby").onEvent;
    central(event(buildEnvelope({ room_topic: first, from: ME, kind: "room_opened", text: "" })));
    central(event(buildEnvelope({ room_topic: first, from: ME, kind: "room_opened", text: "" })));
    central(event(buildEnvelope({ room_topic: second, from: ME, kind: "room_opened", text: "" })));
    expect(lobbyObserver.isTapped(first)).toBe(true);
    expect(lobbyObserver.isTapped(second)).toBe(false);
    expect(lobbyObserver.status().dropped_for_cap).toBe(1);
    await vi.waitFor(() => expect(subs).toHaveLength(2));
  });

  it("exempts a room this agent joins on purpose from the cap", async () => {
    await lobbyObserver.start({ maxRooms: 1 });
    const [publicRoom, joinedRoom] = [newRoomTopic(), newRoomTopic()];
    subscribedTo("agents.lobby").onEvent(event(buildEnvelope({ room_topic: publicRoom, from: ME, kind: "room_opened", text: "" })));
    await lobbyObserver.tapRoom(joinedRoom, { joined: 1 });
    expect(lobbyObserver.isTapped(publicRoom)).toBe(true);
    expect(lobbyObserver.isTapped(joinedRoom)).toBe(true);
    expect(lobbyObserver.joinedRooms()).toEqual([joinedRoom]);
  });
});

describe("tapRoom() / untapRoom()", () => {
  it("refuses to tap while the observer is not active", async () => {
    await expect(lobbyObserver.tapRoom(newRoomTopic(), { joined: 1 })).rejects.toThrow(/not active/);
  });

  it("resolves only once the room is subscribed, so a publish right after cannot outrun the tap", async () => {
    await lobbyObserver.start({});
    const room = newRoomTopic();
    let release: () => void = () => {};
    vi.mocked(subscribe).mockImplementationOnce(async (args) => {
      await new Promise<void>((r) => (release = r));
      const stop = vi.fn().mockResolvedValue(undefined);
      subs.push({ topic: args.topic, onEvent: args.onEvent, stop });
      return { stop, closed: new Promise(() => {}) } as never;
    });
    let tapped = false;
    const p = lobbyObserver.tapRoom(room, { joined: 1 }).then(() => (tapped = true));
    await Promise.resolve();
    expect(tapped).toBe(false);
    release();
    await p;
    expect(subscribedTo(room)).toBeDefined();
  });

  it("tapping a tapped room upgrades joined 0 -> 1 without subscribing again", async () => {
    await lobbyObserver.start({});
    const room = newRoomTopic();
    await lobbyObserver.tapRoom(room, { joined: 0 });
    await lobbyObserver.tapRoom(room, { joined: 1 });
    expect(subs.filter((s) => s.topic === room)).toHaveLength(1);
    expect(lobbyObserver.joinedRooms()).toEqual([room]);
  });

  it("untapRoom ends the subscription and isTapped says so at once", async () => {
    await lobbyObserver.start({});
    const room = newRoomTopic();
    await lobbyObserver.tapRoom(room, { joined: 1 });
    lobbyObserver.untapRoom(room);
    expect(lobbyObserver.isTapped(room)).toBe(false);
    await vi.waitFor(() => expect(subscribedTo(room).stop).toHaveBeenCalledTimes(1));
  });

  it("untapRoom during a subscribe still in flight ends that subscription once it lands", async () => {
    await lobbyObserver.start({});
    const room = newRoomTopic();
    let release: () => void = () => {};
    vi.mocked(subscribe).mockImplementationOnce(async (args) => {
      await new Promise<void>((r) => (release = r));
      const stop = vi.fn().mockResolvedValue(undefined);
      subs.push({ topic: args.topic, onEvent: args.onEvent, stop });
      return { stop, closed: new Promise(() => {}) } as never;
    });
    const p = lobbyObserver.tapRoom(room, { joined: 1 });
    lobbyObserver.untapRoom(room);
    release();
    await p;
    await vi.waitFor(() => expect(subscribedTo(room).stop).toHaveBeenCalledTimes(1));
    expect(lobbyObserver.isTapped(room)).toBe(false);
  });

  it("untapRoom is a no-op for a room that is not tapped", async () => {
    await lobbyObserver.start({});
    expect(() => lobbyObserver.untapRoom(newRoomTopic())).not.toThrow();
  });
});

describe("stop()", () => {
  it("ends central and every room subscription", async () => {
    await lobbyObserver.start({});
    await lobbyObserver.tapRoom(newRoomTopic(), { joined: 1 });
    await lobbyObserver.tapRoom(newRoomTopic(), { joined: 0 });
    expect(await lobbyObserver.stop()).toEqual({ was_active: true, rooms_stopped: 2 });
    for (const s of subs) expect(s.stop).toHaveBeenCalledTimes(1);
    expect(lobbyObserver.isActive()).toBe(false);
  });

  it("is a no-op when never started", async () => {
    expect(await lobbyObserver.stop()).toEqual({ was_active: false, rooms_stopped: 0 });
  });
});
