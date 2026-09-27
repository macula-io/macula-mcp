import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Every tool that reads a subscription feed (a room, central, presence, a
// watch) says in its reply how many events that feed lost, and what the count
// means, so an agent reads 0 as "nothing lost", not "unknown", and a timeout
// after a loss is not read as silence. The feeds and their counts are mocked:
// rooms.test.ts, lobby_observer.test.ts, presence.test.ts and
// macula_ts_client.test.ts cover where the counts come from.
const ME = "a".repeat(64);
const ROOM = `agents.room.${"1".repeat(32)}`;

const mocks = vi.hoisted(() => ({
  listRooms: vi.fn(),
  waitRoom: vi.fn(),
  say: vi.fn(),
  dropped: vi.fn(),
}));
vi.mock("./presence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./presence.js")>()),
  ensurePresence: vi.fn(),
  currentNodeId: () => ME,
}));
vi.mock("./rooms.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rooms.js")>()),
  listRooms: mocks.listRooms,
  waitRoom: mocks.waitRoom,
  say: mocks.say,
}));
vi.mock("./lobby_observer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lobby_observer.js")>()),
  dropped: mocks.dropped,
}));
vi.mock("./rings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rings.js")>()),
  pendingIncoming: () => [],
  listRings: () => [],
}));

import { registerMeshLobbyObserver } from "./mesh_lobby_observer.js";
import { registerMeshReadInbox } from "./mesh_read_inbox.js";
import { registerMeshRooms } from "./mesh_rooms.js";
import { registerMeshWaitRoom } from "./mesh_wait_room.js";

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;

function register(fn: (s: McpServer) => void) {
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
  const server = {
    tool: (name: string, description: string, _schema: unknown, cb: Handler) => {
      handlers.set(name, cb);
      descriptions.set(name, description);
    },
    resource: () => {},
    prompt: () => {},
  } as unknown as McpServer;
  fn(server);
  return { handlers, descriptions };
}

async function reply(fn: (s: McpServer) => void, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await register(fn).handlers.get(tool)!(args);
  expect(res.isError).toBeFalsy();
  return JSON.parse(res.content[0]!.text);
}

const joinedRoom = {
  room_topic: ROOM, opened_by: ME, opened_here: 1, public: 0, purpose: "pairing", joined_at: "2026-09-27T00:00:00.000Z",
  participants_seen: [ME], messages_received: 0, watched: 1, dropped: 2,
};

beforeEach(() => {
  process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB = ":memory:";
  vi.resetAllMocks();
  mocks.listRooms.mockReturnValue({ joined: [joinedRoom], seen_on_central: [], central_dropped: 0 });
});

describe("feed tools report what their feed lost", () => {
  it("mesh_rooms: each room's count and central's", async () => {
    const r = await reply(registerMeshRooms, "mesh_rooms", {});
    expect((r.joined as { dropped: number }[])[0]!.dropped).toBe(2);
    expect(r.central_dropped).toBe(0);
    expect(r.dropped_means).toMatch(/0 means none were discarded/);
  });

  it("mesh_say: the room's count with a wait, nothing without one", async () => {
    const sent = { message_id: "e".repeat(32), room_topic: ROOM, from: ME, kind: "remark_made", text: "hi", sent_at: 1 };
    mocks.say.mockResolvedValue({ sent, reply: null, timed_out: 1, dropped: 3 });
    const waited = await reply(registerMeshRooms, "mesh_say", { room_topic: ROOM, text: "hi", wait_reply_seconds: 1 });
    expect(waited).toMatchObject({ timed_out: 1, dropped: 3 });
    expect(waited.dropped_means).toMatch(/0 means none were discarded/);
    mocks.say.mockResolvedValue({ sent, reply: null });
    const unwaited = await reply(registerMeshRooms, "mesh_say", { room_topic: ROOM, text: "hi" });
    expect(unwaited.dropped).toBeUndefined();
    expect(unwaited.dropped_means).toBeUndefined();
  });

  it("mesh_wait_room: the room's count", async () => {
    mocks.waitRoom.mockResolvedValue({ reply: null, timed_out: 1, dropped: 5 });
    const r = await reply(registerMeshWaitRoom, "mesh_wait_room", { room_topic: ROOM, wait_seconds: 1 });
    expect(r).toMatchObject({ timed_out: 1, dropped: 5 });
    expect(r.dropped_means).toMatch(/0 means none were discarded/);
  });

  it("mesh_read_inbox: each room's count and central's", async () => {
    const r = await reply(registerMeshReadInbox, "mesh_read_inbox", { limit: 10 });
    expect((r.rooms as { dropped: number }[])[0]!.dropped).toBe(2);
    expect(r.central_dropped).toBe(0);
    expect(r.dropped_means).toMatch(/0 means none were discarded/);
  });

  it("mesh_lobby_transcript: the topic's count, or every observed topic's", async () => {
    mocks.dropped.mockImplementation((topic: string) => (topic === ROOM ? 4 : null));
    const one = await reply(registerMeshLobbyObserver, "mesh_lobby_transcript", { topic: ROOM, limit: 10 });
    expect(one.dropped).toBe(4);
    expect(one.dropped_means).toMatch(/0 means none were discarded/);
    const { recordFact } = await import("./lobby_transcript.js");
    recordFact({ topic: ROOM, payload: { text: "x" }, at: new Date().toISOString() });
    const all = await reply(registerMeshLobbyObserver, "mesh_lobby_transcript", { limit: 10 });
    expect(all.dropped_by_topic).toEqual({ [ROOM]: 4 });
  });
});

describe("feed tool descriptions say what dropped counts", () => {
  const cases: [string, (s: McpServer) => void][] = [
    ["mesh_rooms", registerMeshRooms],
    ["mesh_say", registerMeshRooms],
    ["mesh_wait_room", registerMeshWaitRoom],
    ["mesh_read_inbox", registerMeshReadInbox],
    ["mesh_lobby_transcript", registerMeshLobbyObserver],
  ];
  it.each(cases)("%s, full and terse", (name, fn) => {
    expect(register(fn).descriptions.get(name)!).toMatch(/dropped.*0 means none were discarded/s);
    process.env.MACULA_MCP_TERSE_TOOLS = "1";
    try {
      expect(register(fn).descriptions.get(name)!).toMatch(/dropped.*0 = none/s);
    } finally {
      delete process.env.MACULA_MCP_TERSE_TOOLS;
    }
  });
});
