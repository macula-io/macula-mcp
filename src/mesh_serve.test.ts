import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const mocks = vi.hoisted(() => ({ serve: vi.fn() }));
vi.mock("./serve.js", () => ({ serve: mocks.serve }));

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;

async function meshServe(): Promise<Handler> {
  let handler: Handler | undefined;
  const server = { registerTool: (_n: string, _config: unknown, fn: Handler) => (handler = fn) } as unknown as McpServer;
  const { registerMeshServe } = await import("./mesh_serve.js");
  registerMeshServe(server);
  return handler!;
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("mesh_serve", () => {
  it("serves with tagged bytes and passes confidential through", async () => {
    mocks.serve.mockResolvedValue({ name: "sum", procedure: "~ab/sum", registered: true, serving: ["~ab/sum"] });
    const handler = await meshServe();
    await handler({ name: "sum", exec: "cat", confidential: "required" });
    expect(mocks.serve).toHaveBeenLastCalledWith({ name: "sum", exec: "cat", execTimeoutSeconds: 10, bytes: "tagged",
      confidential: "required" });
    await handler({ name: "sum", exec: "cat" });
    expect(mocks.serve).toHaveBeenLastCalledWith(expect.objectContaining({ confidential: undefined }));
  });
});
