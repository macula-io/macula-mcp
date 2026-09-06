import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resetWaitingHintsForTests, waitingHint } from "./mesh_read_inbox.js";

const ME = "a".repeat(64);
const THEM = "b".repeat(64);
const ROOM = `agents.room.${"1".repeat(32)}`;

beforeEach(() => {
  resetWaitingHintsForTests();
});

describe("waitingHint", () => {
  it("says nothing the first time this room is read, even if I am the last speaker (that's just a normal check)", () => {
    expect(waitingHint(ROOM, { message_id: "e".repeat(32), from: ME }, ME)).toBeUndefined();
  });

  it("says nothing at all when the last speaker is someone else", () => {
    expect(waitingHint(ROOM, { message_id: "e".repeat(32), from: THEM }, ME)).toBeUndefined();
  });

  it("says nothing when the room has no messages, or `me` is unknown (presence not active)", () => {
    expect(waitingHint(ROOM, undefined, ME)).toBeUndefined();
    expect(waitingHint(ROOM, { message_id: "e".repeat(32), from: ME }, undefined)).toBeUndefined();
  });

  it("fires exactly once when a SECOND read of the same room still shows the same standing message from me", () => {
    const msg = { message_id: "e".repeat(32), from: ME };
    expect(waitingHint(ROOM, msg, ME)).toBeUndefined(); // first read: establishes the episode
    expect(waitingHint(ROOM, msg, ME)).toEqual(expect.stringContaining("mesh_wait_room"));
    expect(waitingHint(ROOM, msg, ME)).toBeUndefined(); // third read: already nudged for this exact standing message
  });

  it("starts a fresh, quiet episode once I send another message myself", () => {
    const first = { message_id: "e".repeat(32), from: ME };
    waitingHint(ROOM, first, ME);
    waitingHint(ROOM, first, ME); // hinted once
    const second = { message_id: "f".repeat(32), from: ME };
    expect(waitingHint(ROOM, second, ME)).toBeUndefined(); // new episode, quiet again
    expect(waitingHint(ROOM, second, ME)).toEqual(expect.stringContaining("mesh_wait_room")); // then nudges again on the repeat
  });

  it("clears the episode once someone else replies, so a LATER wait by me starts fresh rather than staying silenced", () => {
    const mine = { message_id: "e".repeat(32), from: ME };
    waitingHint(ROOM, mine, ME);
    waitingHint(ROOM, mine, ME); // hinted
    waitingHint(ROOM, { message_id: "f".repeat(32), from: THEM }, ME); // they replied -- episode over
    const mineAgain = { message_id: "g".repeat(32), from: ME };
    expect(waitingHint(ROOM, mineAgain, ME)).toBeUndefined(); // fresh episode
    expect(waitingHint(ROOM, mineAgain, ME)).toEqual(expect.stringContaining("mesh_wait_room"));
  });

  it("tracks each room topic independently", () => {
    const room2 = `agents.room.${"2".repeat(32)}`;
    const msg = { message_id: "e".repeat(32), from: ME };
    waitingHint(ROOM, msg, ME);
    expect(waitingHint(ROOM, msg, ME)).toBeDefined();
    expect(waitingHint(room2, msg, ME)).toBeUndefined(); // a different room's episode hasn't started yet
  });

  it("points at mesh://etiquette and both the blocking and scheduler alternatives, not just one", () => {
    const msg = { message_id: "e".repeat(32), from: ME };
    waitingHint(ROOM, msg, ME);
    const hint = waitingHint(ROOM, msg, ME);
    expect(hint).toContain("mesh_wait_room");
    expect(hint).toContain("scheduler");
    expect(hint).toContain("mesh://etiquette");
  });
});

// Regression coverage for the cold-start race found live 2026-09-06 by 94
// while testing lazymesh: ensurePresence(server) is fire-and-forget (see
// presence.ts's own doc), so on a FRESH identity's very first tool call,
// presence.currentNodeId() reads as undefined because doStart()'s several
// awaits haven't landed yet -- and `room_topic || !me ? undefined : {...}`
// then omits the whole `rings` key, not an empty object. A caller that
// treats a missing key as "zero pending" (reasonable, matches empty-object
// semantics) fails silently instead of erroring -- exactly what happened
// to lazymesh's own popup feature, which never saw an incoming ring during
// its first several checks after a fresh identity spawn.
const toolMocks = vi.hoisted(() => ({
  ensurePresence: vi.fn(),
  currentNodeId: vi.fn(),
  tsIdentity: vi.fn(),
  listRooms: vi.fn(),
  recentFacts: vi.fn(),
  pendingIncoming: vi.fn(),
  listRings: vi.fn(),
}));
vi.mock("./presence.js", () => ({ ensurePresence: toolMocks.ensurePresence, currentNodeId: toolMocks.currentNodeId }));
vi.mock("./macula_ts_client.js", () => ({ tsIdentity: toolMocks.tsIdentity }));
vi.mock("./rooms.js", () => ({ listRooms: toolMocks.listRooms }));
vi.mock("./lobby_transcript.js", () => ({ recentFacts: toolMocks.recentFacts }));
vi.mock("./rings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./rings.js")>();
  return { ...actual, pendingIncoming: toolMocks.pendingIncoming, listRings: toolMocks.listRings };
});

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

/** Captures server.tool()'s registered handler instead of a real McpServer -- mesh_stations.test.ts's own pattern. */
function fakeServer(): { server: McpServer; getHandler: () => Handler } {
  let handler: Handler = async () => {
    throw new Error("mesh_read_inbox was never registered");
  };
  const server = {
    tool: (_name: string, _desc: string, _schema: unknown, fn: Handler) => {
      handler = fn;
    },
  } as unknown as McpServer;
  return { server, getHandler: () => handler };
}

describe("mesh_read_inbox tool: the `me` cold-start race", () => {
  beforeEach(() => {
    toolMocks.currentNodeId.mockReturnValue(undefined); // presence not active yet -- the race's exact starting condition
    toolMocks.tsIdentity.mockReturnValue({ node_id: ME, path: "test-default-identity", generated: false });
    toolMocks.listRooms.mockReturnValue({ joined: [], seen_on_central: [] });
    toolMocks.recentFacts.mockReturnValue({ total: 0, facts: [] });
    toolMocks.pendingIncoming.mockReturnValue([]);
    toolMocks.listRings.mockReturnValue([]);
  });
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("still includes the `rings` key on a fresh identity's very first call, falling back to the local identity file", async () => {
    const { registerMeshReadInbox } = await import("./mesh_read_inbox.js");
    const { server, getHandler } = fakeServer();
    registerMeshReadInbox(server);

    const res = await getHandler()({});
    const body = JSON.parse(res.content[0]!.text);

    expect(toolMocks.ensurePresence).toHaveBeenCalledWith(server);
    expect(body.rings).toBeDefined(); // the actual bug: this key was absent entirely
    expect(body.rings).toEqual({ pending: [], recent: [] });
    // Proves the fallback node id actually reached the local reads, not just that the key exists.
    expect(toolMocks.pendingIncoming).toHaveBeenCalledWith(ME);
    expect(toolMocks.listRings).toHaveBeenCalledWith(expect.objectContaining({ self: ME }));
  });

  it("still includes `rings` for a specific room_topic read too", async () => {
    toolMocks.listRooms.mockReturnValue({ joined: [{ room_topic: ROOM, opened_by: THEM, participants_seen: [] }], seen_on_central: [] });
    const { registerMeshReadInbox } = await import("./mesh_read_inbox.js");
    const { server, getHandler } = fakeServer();
    registerMeshReadInbox(server);

    const res = await getHandler()({ room_topic: ROOM });
    const body = JSON.parse(res.content[0]!.text);

    expect(body.rings).toBeUndefined(); // by design: a single-room read omits rings (see the tool's own `room_topic ||` check)
    expect(body.rooms).toHaveLength(1);
  });
});
