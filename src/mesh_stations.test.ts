import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const REALM = "abb81b5a614b63551b400b810648c0c8a78efad845442630c94b46cc95d2fcd1";

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  findRecordsByType: vi.fn(),
  ensurePresence: vi.fn(),
}));
// Boundary mock, same pattern as rooms.test.ts/presence.test.ts: replace the
// module mesh_stations.ts talks to the mesh THROUGH (macula_ts_client.js) --
// both the DHT discovery half and the actual list_stations call go through
// it now that realm support landed, so this is the one seam to mock.
vi.mock("./macula_ts_client.js", () => ({ call: mocks.call, findRecordsByType: mocks.findRecordsByType }));
vi.mock("./presence.js", () => ({ ensurePresence: mocks.ensurePresence }));

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

/** Captures server.tool()'s registered handler instead of a real McpServer -- same shape mesh_stations.ts's own registerMeshListStations expects. */
function fakeServer(): { server: McpServer; getHandler: () => Handler } {
  let handler: Handler = async () => {
    throw new Error("mesh_list_stations was never registered");
  };
  const server = {
    tool: (_name: string, _desc: string, _schema: unknown, fn: Handler) => {
      handler = fn;
    },
  } as unknown as McpServer;
  return { server, getHandler: () => handler };
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("mesh_list_stations", () => {
  it("discovers hecate_stations' current realm via the DHT, then calls list_stations under it", async () => {
    mocks.findRecordsByType.mockResolvedValue({
      host: "demo.macula.io:4433",
      type: 0x06,
      count: 2,
      records: [
        { procedure_advertisement: { procedure: "other.thing", realm: "0".repeat(64) } },
        { procedure_advertisement: { procedure: "hecate_stations.list_stations", realm: REALM } },
      ],
    });
    mocks.call.mockResolvedValue({
      procedure: "hecate_stations.list_stations",
      payload: { stations: [{ node_id: "abc", city: "0x" + Buffer.from("Paris").toString("hex") }] },
      duration_ms: 12,
    });

    const { registerMeshListStations } = await import("./mesh_stations.js");
    const { server, getHandler } = fakeServer();
    registerMeshListStations(server);
    const res = (await getHandler()({})) as { content: { text: string }[] };
    const body = JSON.parse(res.content[0]!.text);

    expect(mocks.ensurePresence).toHaveBeenCalledWith(server);
    // The call must be scoped to the realm hecate_stations was actually found under, not the default.
    expect(mocks.call).toHaveBeenCalledWith(
      expect.objectContaining({ procedure: "hecate_stations.list_stations", realm: REALM }),
    );
    expect(body.realm).toBe(REALM);
    expect(body.stations).toEqual([{ node_id: "abc", city: "Paris" }]); // hex-decoded text field
  });

  it("errors clearly, without ever calling list_stations, when hecate_stations isn't advertised", async () => {
    mocks.findRecordsByType.mockResolvedValue({ host: "demo.macula.io:4433", type: 0x06, count: 0, records: [] });

    const { registerMeshListStations } = await import("./mesh_stations.js");
    const { server, getHandler } = fakeServer();
    registerMeshListStations(server);
    const res = (await getHandler()({})) as { isError?: boolean; content: { text: string }[] };

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/not currently advertised/);
    expect(mocks.call).not.toHaveBeenCalled();
  });
});
