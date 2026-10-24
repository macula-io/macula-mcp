import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ringReceived } from "./ring_agents/ring_dossier.js";
import { appendNodeEvent, NODE_EVENT } from "./node_events.js";
import { closeMachineDb, machineDb } from "./machine_transcript.js";

const ME = "a".repeat(64);
const THEM = "b".repeat(64);
const ROOM = `agents.room.${"1".repeat(32)}`;

const mocks = vi.hoisted(() => ({ currentNodeId: vi.fn() }));
vi.mock("./be_present/presence.js", () => ({ currentNodeId: mocks.currentNodeId, ensurePresence: vi.fn() }));

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

/** Captures server.registerTool()'s registered handler instead of a real McpServer -- mesh_wait_ring.test.ts's own pattern. */
function fakeServer(): { server: McpServer; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, fn: Handler) => {
      handlers.set(name, fn);
    },
  } as unknown as McpServer;
  return { server, handlers };
}

/** The fake server skips the SDK's schema parsing, so the input schema's own defaults are applied here. */
async function call(args: Record<string, unknown> = {}) {
  const { registerMeshReadNodeEvents } = await import("./mesh_read_node_events.js");
  const { server, handlers } = fakeServer();
  registerMeshReadNodeEvents(server);
  const res = await handlers.get("mesh_read_node_events")!({ limit: 50, ...args });
  return { res, body: JSON.parse(res.content[0]!.text) as Record<string, unknown> };
}

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "macula-mcp-read-events-"));
  process.env.MACULA_MCP_RINGS_DB = join(dir, "rings.sqlite3");
  mocks.currentNodeId.mockReturnValue(ME);
});

afterEach(() => {
  closeMachineDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MACULA_MCP_RINGS_DB;
  vi.resetAllMocks();
});

describe("mesh_read_node_events", () => {
  it("serves the log oldest-first, with the cursor to continue from", async () => {
    ringReceived({ ring_id: "1".repeat(32), self: ME, peer: THEM, purpose: "pair on the plan", room_topic: ROOM, sent_at: 5, answer: 1 });
    appendNodeEvent(machineDb(), { self: ME, kind: NODE_EVENT.joinConfirmed, realm: "io.macula", org_identity: "mri:org:io.macula/raf", tier: "citizen" });

    const { body } = await call();
    const events = body.events as Record<string, unknown>[];

    expect(events.map((e) => e.kind)).toEqual(["ring_received", "ring_answered", "join_confirmed"]);
    expect(events[0]).toMatchObject({ ring_id: "1".repeat(32), direction: "in", peer: THEM, purpose: "pair on the plan", answer: 1, answer_label: "accepted" });
    expect(events[0]!.peer_petname).toBeTypeOf("string");
    // A join entry says nothing about rings, and a ring entry says nothing about realms.
    expect(events[2]).toEqual({ seq: 3, kind: "join_confirmed", at: expect.any(String), realm: "io.macula", org_identity: "mri:org:io.macula/raf", tier: "citizen" });
    expect(body.next_after_seq).toBe(3);
    expect(body.returned).toBe(3);
  });

  it("after_seq returns only what is newer, so a client sees each entry exactly once", async () => {
    ringReceived({ ring_id: "2".repeat(32), self: ME, peer: THEM, purpose: "pair on the plan", room_topic: ROOM, sent_at: 5, answer: null });
    const first = await call({ after_seq: 0 });
    expect((first.body.events as unknown[]).length).toBe(1);

    ringReceived({ ring_id: "3".repeat(32), self: ME, peer: THEM, purpose: "again", room_topic: ROOM, sent_at: 6, answer: 2 });
    const second = await call({ after_seq: first.body.next_after_seq });
    expect((second.body.events as Record<string, unknown>[]).map((e) => e.ring_id)).toEqual(["3".repeat(32), "3".repeat(32)]);
    expect(second.body.next_after_seq).toBe(3);
  });

  it("limit takes the newest window, still oldest-first", async () => {
    ringReceived({ ring_id: "4".repeat(32), self: ME, peer: THEM, purpose: "pair on the plan", room_topic: ROOM, sent_at: 5, answer: 1 });
    const { body } = await call({ limit: 1 });
    expect((body.events as Record<string, unknown>[]).map((e) => e.kind)).toEqual(["ring_answered"]);
    expect(body.next_after_seq).toBe(2);
  });
});
