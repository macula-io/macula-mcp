import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity, PubsubEvent, Session } from "@macula-io/ts";
import { closeTranscript, recentFacts } from "./lobby_transcript.js";
import { buildEnvelope, newRoomTopic } from "./envelope.js";

// Boundary mock, same pattern as presence.test.ts: replace the module
// lobby_observer.ts talks to the mesh THROUGH, not @macula-io/ts itself.
vi.mock("./macula_ts_client.js", () => ({
  connectWithFallback: vi.fn(),
  loadOrGenerateIdentity: vi.fn(),
  toCliError: vi.fn((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
  tsIdentity: vi.fn(),
}));

import { connectWithFallback, loadOrGenerateIdentity, tsIdentity } from "./macula_ts_client.js";
import * as lobbyObserver from "./lobby_observer.js";

const NODE_ID = "a".repeat(64);
const ME = "c".repeat(64);
const DEFAULT_IDENTITY_PATH = "test-default-identity";
const OBSERVE_IDENTITY_PATH = "test-observe-identity";

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

let identitySeq = 0;
function fakeIdentity(): Identity {
  identitySeq += 1;
  return { seq: identitySeq, dispose: vi.fn() } as unknown as Identity;
}

const PUBLISHER = new Uint8Array(Buffer.from("b".repeat(64), "hex"));
function fakeEvent(payload: unknown): PubsubEvent {
  return { payload, publisher: PUBLISHER, seq: 1 };
}

let createdSessions: FakeSession[];
let createdIdentities: ReturnType<typeof fakeIdentity>[];

/** Default connectWithFallback: a fresh fake session on every call, recorded in order. Individual tests override specific calls with mockImplementationOnce/mockRejectedValueOnce to simulate a connect failure. */
function queueDefaultConnects(): void {
  vi.mocked(connectWithFallback).mockImplementation(async () => {
    const s = makeFakeSession();
    createdSessions.push(s);
    return s.session;
  });
}

beforeEach(() => {
  process.env.MACULA_MCP_IDENTITY = DEFAULT_IDENTITY_PATH;
  process.env.MACULA_MCP_OBSERVE_IDENTITY = OBSERVE_IDENTITY_PATH;
  process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB = ":memory:";

  createdSessions = [];
  createdIdentities = [];
  vi.mocked(loadOrGenerateIdentity).mockImplementation(() => {
    const id = fakeIdentity();
    createdIdentities.push(id);
    return id;
  });
  vi.mocked(tsIdentity).mockReturnValue({ node_id: NODE_ID, path: DEFAULT_IDENTITY_PATH, generated: false });
  queueDefaultConnects();
});

afterEach(async () => {
  if (lobbyObserver.isActive()) await lobbyObserver.stop();
  vi.useRealTimers();
  vi.resetAllMocks();
  closeTranscript();
  delete process.env.MACULA_MCP_IDENTITY;
  delete process.env.MACULA_MCP_OBSERVE_IDENTITY;
  delete process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB;
});

describe("start()", () => {
  it("opens one Session under the observe identity, subscribed to agents.lobby", async () => {
    const result = await lobbyObserver.start({});

    expect(result).toMatchObject({ node_id: NODE_ID, lobby_topic: "agents.lobby", already_active: false });
    expect(vi.mocked(loadOrGenerateIdentity).mock.calls.map((c) => c[0])).toEqual([OBSERVE_IDENTITY_PATH]);
    expect(createdSessions).toHaveLength(1);
    expect(createdSessions[0]!.subscribeCalls).toHaveLength(1);
    expect(createdSessions[0]!.subscribeCalls[0]!.topic).toBe("agents.lobby");
  });

  it("is idempotent: a second call just raises max_rooms, without opening a second central Session", async () => {
    await lobbyObserver.start({ maxRooms: 5 });
    const result = await lobbyObserver.start({ maxRooms: 30 });

    expect(result).toMatchObject({ already_active: true, max_rooms: 30 });
    expect(createdSessions).toHaveLength(1);
  });

  it("if the central Session's first connect fails, start() rejects and the observer stays inactive", async () => {
    vi.mocked(connectWithFallback).mockImplementationOnce(async () => {
      throw new Error("station unreachable");
    });

    await expect(lobbyObserver.start({})).rejects.toThrow(/station unreachable/);
    expect(lobbyObserver.isActive()).toBe(false);
    expect(createdIdentities[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it("central events are recorded into the transcript, with the station-attested publisher", async () => {
    await lobbyObserver.start({});
    const handler = createdSessions[0]!.subscribeCalls[0]!.handler;
    const env = buildEnvelope({ room_topic: "agents.lobby", from: ME, kind: "remark_made", text: "hi everyone" });

    handler(fakeEvent(env));

    const { facts } = recentFacts({ topic: "agents.lobby", limit: 10 });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ topic: "agents.lobby", sender: ME, text: "hi everyone", publisher: "b".repeat(64) });
  });
});

describe("public room discovery", () => {
  it("a room_opened envelope on central taps that room automatically, recording its own facts with publisher attribution", async () => {
    await lobbyObserver.start({});
    const centralHandler = createdSessions[0]!.subscribeCalls[0]!.handler;
    const roomTopic = newRoomTopic();
    const opened = buildEnvelope({ room_topic: roomTopic, from: ME, kind: "room_opened", text: "", purpose: "review" });

    centralHandler(fakeEvent(opened));
    expect(lobbyObserver.isTapped(roomTopic)).toBe(true); // tapRoomLeg registers the tap synchronously, before its connect even starts
    await vi.waitFor(() => expect(createdSessions).toHaveLength(2)); // central + the new room tap
    const roomSession = createdSessions[1]!;
    expect(roomSession.subscribeCalls[0]!.topic).toBe(roomTopic);

    const roomHandler = roomSession.subscribeCalls[0]!.handler;
    const said = buildEnvelope({ room_topic: roomTopic, from: ME, kind: "remark_made", text: "in the room" });
    roomHandler(fakeEvent(said));

    const { facts } = recentFacts({ topic: roomTopic, limit: 10 });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ text: "in the room", publisher: "b".repeat(64) });
  });

  it("does not re-tap a room already tapped, and drops further public rooms once max_rooms is hit", async () => {
    await lobbyObserver.start({ maxRooms: 1 });
    const centralHandler = createdSessions[0]!.subscribeCalls[0]!.handler;
    const first = newRoomTopic();
    const second = newRoomTopic();

    centralHandler(fakeEvent(buildEnvelope({ room_topic: first, from: ME, kind: "room_opened", text: "" })));
    centralHandler(fakeEvent(buildEnvelope({ room_topic: first, from: ME, kind: "room_opened", text: "" }))); // duplicate, ignored
    centralHandler(fakeEvent(buildEnvelope({ room_topic: second, from: ME, kind: "room_opened", text: "" }))); // over cap, dropped

    expect(lobbyObserver.isTapped(first)).toBe(true);
    expect(lobbyObserver.isTapped(second)).toBe(false);
    expect(lobbyObserver.status().dropped_for_cap).toBe(1);
    await vi.waitFor(() => expect(createdSessions).toHaveLength(2)); // central + first room only
  });

  it("a room this agent deliberately joins (joined: 1) is exempt from the cap", async () => {
    await lobbyObserver.start({ maxRooms: 1 });
    const centralHandler = createdSessions[0]!.subscribeCalls[0]!.handler;
    const publicRoom = newRoomTopic();
    const joinedRoom = newRoomTopic();

    centralHandler(fakeEvent(buildEnvelope({ room_topic: publicRoom, from: ME, kind: "room_opened", text: "" })));
    lobbyObserver.tapRoom(joinedRoom, { joined: 1 });

    expect(lobbyObserver.isTapped(publicRoom)).toBe(true);
    expect(lobbyObserver.isTapped(joinedRoom)).toBe(true);
    expect(lobbyObserver.status().dropped_for_cap).toBe(0);
    expect(lobbyObserver.joinedRooms()).toEqual([joinedRoom]);
  });
});

describe("tapRoom() / untapRoom()", () => {
  it("throws if the observer isn't active", async () => {
    await expect(lobbyObserver.tapRoom(newRoomTopic(), { joined: 1 })).rejects.toThrow(/not active/);
  });

  it("tapping the same room twice just upgrades joined 0 -> 1 without a second Session", async () => {
    await lobbyObserver.start({});
    const roomTopic = newRoomTopic();
    lobbyObserver.tapRoom(roomTopic, { joined: 0 });
    lobbyObserver.tapRoom(roomTopic, { joined: 1 });
    expect(lobbyObserver.joinedRooms()).toEqual([roomTopic]);

    await vi.waitFor(() => expect(createdSessions).toHaveLength(2)); // central + one room tap, not two
  });

  it("untapRoom stops the Session and disposes its identity; isTapped reflects it immediately", async () => {
    await lobbyObserver.start({});
    const roomTopic = newRoomTopic();
    lobbyObserver.tapRoom(roomTopic, { joined: 1 });
    await vi.waitFor(() => expect(createdSessions).toHaveLength(2));
    const roomSession = createdSessions[1]!;
    const roomIdentity = createdIdentities[1]!;

    lobbyObserver.untapRoom(roomTopic);
    expect(lobbyObserver.isTapped(roomTopic)).toBe(false); // removed synchronously

    await vi.waitFor(() => expect(roomIdentity.dispose).toHaveBeenCalledTimes(1));
    expect(roomSession.stopFn).toHaveBeenCalledTimes(1);
    expect(roomSession.closeFn).toHaveBeenCalledTimes(1);
  });

  it("untapRoom on a tap whose connect is still in flight closes the fresh session once it lands, instead of subscribing on it", async () => {
    await lobbyObserver.start({}); // consumes the default connect for the central leg first
    let resolveConnect!: (s: Session) => void;
    vi.mocked(connectWithFallback).mockImplementationOnce(
      () =>
        new Promise<Session>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const roomTopic = newRoomTopic();
    lobbyObserver.tapRoom(roomTopic, { joined: 1 }); // this leg's connect is now the pending one

    lobbyObserver.untapRoom(roomTopic); // closing while still connecting
    const pending = makeFakeSession();
    resolveConnect(pending.session);

    await vi.waitFor(() => expect(pending.closeFn).toHaveBeenCalledTimes(1));
    expect(pending.session.subscribe).not.toHaveBeenCalled();
  });

  it("untapRoom is a no-op for a room that isn't tapped", async () => {
    await lobbyObserver.start({});
    expect(() => lobbyObserver.untapRoom(newRoomTopic())).not.toThrow();
  });
});

describe("reconnect", () => {
  it("the central leg's onClosed reconnects with backoff and keeps recording events on the fresh session", async () => {
    vi.useFakeTimers();
    await lobbyObserver.start({});
    const first = createdSessions[0]!;
    const onClosed = first.subscribeCalls[0]!.onClosed;
    expect(onClosed).toBeTypeOf("function");

    vi.mocked(connectWithFallback).mockImplementationOnce(async () => {
      throw new Error("still unreachable");
    });
    onClosed!(new Error("connection reset"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connectWithFallback).toHaveBeenCalledTimes(2); // initial connect + this failed retry

    // Second attempt (2s backoff, doubled) succeeds against a brand new session.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(connectWithFallback).toHaveBeenCalledTimes(3);
    expect(createdSessions).toHaveLength(2); // initial central (dead) + reconnected central
    const reconnected = createdSessions[1]!;
    expect(reconnected.subscribeCalls[0]!.topic).toBe("agents.lobby");

    const env = buildEnvelope({ room_topic: "agents.lobby", from: ME, kind: "remark_made", text: "still here" });
    reconnected.subscribeCalls[0]!.handler(fakeEvent(env));
    const { facts } = recentFacts({ topic: "agents.lobby", limit: 10 });
    expect(facts.map((f) => f.text)).toContain("still here");
  });

  it("a room tap's onClosed reconnects independently, without touching the central leg or other taps", async () => {
    vi.useFakeTimers();
    await lobbyObserver.start({});
    const roomTopic = newRoomTopic();
    lobbyObserver.tapRoom(roomTopic, { joined: 1 });
    await vi.advanceTimersByTimeAsync(0);
    const roomSession = createdSessions[1]!;
    const onClosed = roomSession.subscribeCalls[0]!.onClosed!;

    onClosed(new Error("station kicked this connection"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(createdSessions).toHaveLength(3); // central, dead room session, reconnected room session
    expect(lobbyObserver.isTapped(roomTopic)).toBe(true); // stayed tapped throughout -- self-healing, no external re-tap needed
    const reconnectedRoom = createdSessions[2]!;
    expect(reconnectedRoom.subscribeCalls[0]!.topic).toBe(roomTopic);
  });

  it("does not reconnect once untapRoom() has begun tearing a room leg down", async () => {
    await lobbyObserver.start({});
    const roomTopic = newRoomTopic();
    lobbyObserver.tapRoom(roomTopic, { joined: 1 });
    await vi.waitFor(() => expect(createdSessions).toHaveLength(2));
    const roomSession = createdSessions[1]!;
    const onClosed = roomSession.subscribeCalls[0]!.onClosed!;

    lobbyObserver.untapRoom(roomTopic);
    createdSessions.length = 0;
    vi.mocked(connectWithFallback).mockClear();
    onClosed(new Error("connection reset, but this tap already left"));
    await Promise.resolve();

    expect(connectWithFallback).not.toHaveBeenCalled();
    expect(createdSessions).toHaveLength(0);
  });
});

describe("stop()", () => {
  it("closes the central Session and every room tap, disposing every identity", async () => {
    await lobbyObserver.start({});
    const roomTopic = newRoomTopic();
    lobbyObserver.tapRoom(roomTopic, { joined: 1 });
    await vi.waitFor(() => expect(createdSessions).toHaveLength(2));
    const [central, room] = createdSessions;

    const result = await lobbyObserver.stop();

    expect(result).toEqual({ was_active: true, rooms_stopped: 1 });
    expect(central!.stopFn).toHaveBeenCalledTimes(1);
    expect(central!.closeFn).toHaveBeenCalledTimes(1);
    expect(room!.stopFn).toHaveBeenCalledTimes(1);
    expect(room!.closeFn).toHaveBeenCalledTimes(1);
    for (const id of createdIdentities) expect(id.dispose).toHaveBeenCalledTimes(1);
    expect(lobbyObserver.isActive()).toBe(false);
  });

  it("is a no-op when never started", async () => {
    expect(await lobbyObserver.stop()).toEqual({ was_active: false, rooms_stopped: 0 });
  });
});
