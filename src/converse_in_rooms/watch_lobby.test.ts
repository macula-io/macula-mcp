import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@macula-io/ts";
import { closeTranscript, lostOn, recentFacts } from "./lobby_transcript.js";
import { buildEnvelope, newRoomTopic } from "../envelope.js";

// Boundary mock: the client layer the observer subscribes through.
vi.mock("../connect_to_mesh.js", () => ({
  selfNodeId: vi.fn(),
  subscribe: vi.fn(),
}));

import { selfNodeId, subscribe } from "../connect_to_mesh.js";
import * as lobbyObserver from "./watch_lobby.js";

const NODE_ID = "a".repeat(64);
const ME = "c".repeat(64);
const PUBLISHER = "b".repeat(64);

interface FakeSub {
  topic: string;
  onEvent: (e: Event) => void;
  stop: ReturnType<typeof vi.fn>;
  lost: number;
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
    const sub: FakeSub = { topic: args.topic, onEvent: args.onEvent, stop, lost: 0 };
    subs.push(sub);
    return { stop, closed: new Promise(() => {}), dropped: () => sub.lost } as never;
  });
});

afterEach(async () => {
  if (lobbyObserver.isActive()) await lobbyObserver.stop();
  vi.resetAllMocks();
  closeTranscript();
  delete process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB;
});

describe("dropped()", () => {
  it("is every loss recorded on the topic's transcript, and outlives the subscription that saw it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const room = newRoomTopic();
    expect(lobbyObserver.dropped(room)).toBe(0);
    await lobbyObserver.start({});
    await lobbyObserver.tapRoom(room);
    subscribedTo(room).lost = 6;
    subscribedTo("agents.lobby").lost = 2;
    expect(lobbyObserver.dropped(room)).toBe(6);
    expect(lobbyObserver.dropped("agents.lobby")).toBe(2);
    // A re-tap is a fresh subscription counting from 0: the transcript's holes stay counted.
    lobbyObserver.untapRoom(room);
    expect(lobbyObserver.dropped(room)).toBe(6);
    await lobbyObserver.tapRoom(room);
    const fresh = subs.filter((s) => s.topic === room).at(-1)!;
    expect(lobbyObserver.dropped(room)).toBe(6);
    fresh.lost = 1;
    expect(lobbyObserver.dropped(room)).toBe(7);
    await lobbyObserver.stop();
    expect(lobbyObserver.dropped("agents.lobby")).toBe(2);
    expect(lostOn(room)).toBe(7);
  });

  it("takes a last look before ending a subscription, so a loss nobody noticed yet is kept", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const room = newRoomTopic();
    await lobbyObserver.start({});
    await lobbyObserver.tapRoom(room);
    subscribedTo(room).lost = 5;
    subscribedTo("agents.lobby").lost = 2;
    lobbyObserver.untapRoom(room);
    await vi.waitFor(() => expect(subscribedTo(room).stop).toHaveBeenCalled());
    expect(lostOn(room)).toBe(5);
    await lobbyObserver.stop();
    expect(lostOn("agents.lobby")).toBe(2);
  });

  it("records a loss whoever notices it, a reader or the next delivery", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { droppedEvents } = await import("../dropped_events.js");
    await lobbyObserver.start({});
    subscribedTo("agents.lobby").lost = 4;
    // What connect_to_mesh.subscribe does after each delivery.
    const central = await (vi.mocked(subscribe).mock.results[0]!.value as ReturnType<typeof subscribe>);
    droppedEvents("agents.lobby", central);
    expect(lostOn("agents.lobby")).toBe(4);
  });
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
    // tapRoom is what rooms.ts asks for when this agent opens or joins a room; the cap counts only the taps
    // this observer opened for a public room it overheard (macula-mcp#44 step 6).
    await lobbyObserver.tapRoom(joinedRoom);
    expect(lobbyObserver.isTapped(publicRoom)).toBe(true);
    expect(lobbyObserver.isTapped(joinedRoom)).toBe(true);
  });
});

describe("tapRoom() / untapRoom()", () => {
  it("refuses to tap while the observer is not active", async () => {
    await expect(lobbyObserver.tapRoom(newRoomTopic())).rejects.toThrow(/not active/);
  });

  it("resolves only once the room is subscribed, so a publish right after cannot outrun the tap", async () => {
    await lobbyObserver.start({});
    const room = newRoomTopic();
    let release: () => void = () => {};
    vi.mocked(subscribe).mockImplementationOnce(async (args) => {
      await new Promise<void>((r) => (release = r));
      const stop = vi.fn().mockResolvedValue(undefined);
      subs.push({ topic: args.topic, onEvent: args.onEvent, stop, lost: 0 });
      return { stop, closed: new Promise(() => {}), dropped: () => 0 } as never;
    });
    let tapped = false;
    const p = lobbyObserver.tapRoom(room).then(() => (tapped = true));
    await Promise.resolve();
    expect(tapped).toBe(false);
    release();
    await p;
    expect(subscribedTo(room)).toBeDefined();
  });

  it("tapping a room already tapped does not subscribe to it again", async () => {
    await lobbyObserver.start({});
    const room = newRoomTopic();
    await lobbyObserver.tapRoom(room);
    await lobbyObserver.tapRoom(room);
    expect(subs.filter((s) => s.topic === room)).toHaveLength(1);
    expect(lobbyObserver.isTapped(room)).toBe(true);
  });

  it("untapRoom ends the subscription and isTapped says so at once", async () => {
    await lobbyObserver.start({});
    const room = newRoomTopic();
    await lobbyObserver.tapRoom(room);
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
      subs.push({ topic: args.topic, onEvent: args.onEvent, stop, lost: 0 });
      return { stop, closed: new Promise(() => {}), dropped: () => 0 } as never;
    });
    const p = lobbyObserver.tapRoom(room);
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
    await lobbyObserver.tapRoom(newRoomTopic());
    await lobbyObserver.tapRoom(newRoomTopic(), { joined: 0 });
    expect(await lobbyObserver.stop()).toEqual({ was_active: true, rooms_stopped: 2 });
    for (const s of subs) expect(s.stop).toHaveBeenCalledTimes(1);
    expect(lobbyObserver.isActive()).toBe(false);
  });

  it("is a no-op when never started", async () => {
    expect(await lobbyObserver.stop()).toEqual({ was_active: false, rooms_stopped: 0 });
  });
});
