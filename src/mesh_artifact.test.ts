import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const MCID = "0255" + "ab".repeat(48);

const mocks = vi.hoisted(() => ({ shareContent: vi.fn(), getContent: vi.fn(), ensurePresence: vi.fn() }));
vi.mock("./macula_ts_client.js", () => ({ shareContent: mocks.shareContent, getContent: mocks.getContent }));
vi.mock("./presence.js", () => ({ ensurePresence: mocks.ensurePresence }));

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;

async function tools(): Promise<Map<string, Handler>> {
  const handlers = new Map<string, Handler>();
  const server = { tool: (n: string, _d: string, _s: unknown, fn: Handler) => handlers.set(n, fn) } as unknown as McpServer;
  const { registerMeshArtifact } = await import("./mesh_artifact.js");
  registerMeshArtifact(server);
  return handlers;
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("mesh_put", () => {
  it("shares the decoded bytes, named, and answers the content id and that this agent serves it", async () => {
    mocks.shareContent.mockResolvedValue(MCID);
    const res = await (await tools()).get("mesh_put")!({ content: Buffer.from("hello mesh").toString("base64"), name: "note.txt" });
    expect(mocks.shareContent).toHaveBeenCalledWith({ data: new Uint8Array(Buffer.from("hello mesh")), name: "note.txt" });
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ mcid_hex: MCID, size_bytes: 10, served_by: "this agent, while it is present" });
    expect(mocks.ensurePresence).toHaveBeenCalled();
  });

  it("refuses content that looks like a secret, before sharing anything", async () => {
    const res = await (await tools()).get("mesh_put")!({ content: Buffer.from("key AKIAIOSFODNN7EXAMPLE").toString("base64") });
    expect(res.isError).toBe(true);
    expect(mocks.shareContent).not.toHaveBeenCalled();
  });
});

describe("mesh_get", () => {
  it("fetches a content id and answers its bytes as base64", async () => {
    mocks.getContent.mockResolvedValue(new Uint8Array(Buffer.from("hello mesh")));
    const res = await (await tools()).get("mesh_get")!({ mcid_hex: MCID });
    expect(mocks.getContent).toHaveBeenCalledWith({ mcidHex: MCID });
    expect(JSON.parse(res.content[0]!.text)).toEqual({ content: Buffer.from("hello mesh").toString("base64"), size_bytes: 10 });
  });

  it("says plainly when nobody shares the content", async () => {
    const { MeshError } = await import("./mesh_config.js");
    mocks.getContent.mockRejectedValue(new MeshError("macula-ts: no node shares that content in that realm", "not_shared"));
    const res = await (await tools()).get("mesh_get")!({ mcid_hex: MCID });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/code=not_shared/);
  });
});
