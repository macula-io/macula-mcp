import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boundary mock, same pattern as presence.test.ts/rooms.test.ts: replace the
// module serve.ts talks to @macula-io/ts THROUGH (connectWithFallback,
// loadOrGenerateIdentity) with fakes whose Session/Identity methods are
// individually assertable -- this is the seam that matters for the
// regression this file exists to cover (see the first describe block).
const mocks = vi.hoisted(() => ({
  connectWithFallback: vi.fn(),
  loadOrGenerateIdentity: vi.fn(),
}));
vi.mock("./macula_ts_client.js", () => ({
  connectWithFallback: mocks.connectWithFallback,
  loadOrGenerateIdentity: mocks.loadOrGenerateIdentity,
  toCliError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
}));

const SERVE_IDENTITY_PATH = "/tmp/macula-mcp-test-serve-identity.seed";
const ADVERTISE_IDENTITY_PATH = "/tmp/macula-mcp-test-serve-advertise-identity.seed";

function fakeSession(stationNodeId: Uint8Array) {
  return {
    stationNodeId,
    serve: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(undefined)),
    putProcedureAdvertisement: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
  };
}
function fakeIdentity() {
  return { dispose: vi.fn() };
}

beforeEach(() => {
  // serve.ts keeps its Session state in module-level variables, not
  // exported or resettable directly -- resetModules() forces the next
  // `await import("./serve.js")` to get a genuinely fresh module instance
  // (state undefined again) instead of silently reusing whatever a PRIOR
  // test's serve() calls left registered, which would make every test
  // after the first see stale sessions and skip loadOrGenerateIdentity/
  // connectWithFallback entirely. The vi.mock("./macula_ts_client.js", ...)
  // factory above stays registered across this -- only the module cache
  // is cleared, not mock registrations.
  vi.resetModules();
  process.env.MACULA_MCP_SERVE_IDENTITY = SERVE_IDENTITY_PATH;
  process.env.MACULA_MCP_SERVE_ADVERTISE_IDENTITY = ADVERTISE_IDENTITY_PATH;
});
afterEach(() => {
  delete process.env.MACULA_MCP_SERVE_IDENTITY;
  delete process.env.MACULA_MCP_SERVE_ADVERTISE_IDENTITY;
  vi.resetAllMocks();
});

/** Wires loadOrGenerateIdentity/connectWithFallback so the serving identity/session and
 * the direct-advertise identity/session are two distinct, individually-assertable fakes --
 * exactly the two-Session split serve.ts's own ServeState.directAdvertise doc explains. */
function wireTwoSessions() {
  const servingStation = new Uint8Array(32).fill(1);
  const advertiseStation = new Uint8Array(32).fill(2); // deliberately DIFFERENT, so a test can tell which one a call actually used
  const servingSession = fakeSession(servingStation);
  const advertiseSession = fakeSession(advertiseStation);
  const servingIdentity = fakeIdentity();
  const advertiseIdentity = fakeIdentity();
  mocks.loadOrGenerateIdentity.mockImplementation((path: string) => (path === SERVE_IDENTITY_PATH ? servingIdentity : advertiseIdentity));
  mocks.connectWithFallback.mockImplementation(async (identity: unknown) => (identity === servingIdentity ? servingSession : advertiseSession));
  return { servingSession, advertiseSession, servingIdentity, advertiseIdentity };
}

describe("serve with direct: true", () => {
  it("puts the DHT advertisement on a SEPARATE Session/identity from the one serve() itself runs on -- never the same one (regression: @macula-io/ts's own #requireHandleNotServing guard rejects putProcedureAdvertisement on a Session that is actively serve()-ing, which broke every direct-dial registration, ring_service.ts's ring endpoint included, until this split existed)", async () => {
    const { servingSession, advertiseSession } = wireTwoSessions();
    const { serve } = await import("./serve.js");

    await serve({ procedure: "agent.x.ring", exec: "true", direct: true, ttlSeconds: 3600 });

    expect(servingSession.serve).toHaveBeenCalledTimes(1);
    expect(servingSession.putProcedureAdvertisement).not.toHaveBeenCalled();
    expect(advertiseSession.serve).not.toHaveBeenCalled();
    expect(advertiseSession.putProcedureAdvertisement).toHaveBeenCalledTimes(1);
  });

  it("advertises the SERVING session's own resolved station, not the advertise session's -- servingStation must name whichever station will actually route the CALL", async () => {
    const { advertiseSession } = wireTwoSessions();
    const { serve } = await import("./serve.js");

    await serve({ procedure: "agent.x.ring", exec: "true", direct: true, ttlSeconds: 3600 });

    expect(advertiseSession.putProcedureAdvertisement).toHaveBeenCalledWith("agent.x.ring", new Uint8Array(32).fill(1), { ttlMs: 3_600_000 });
  });

  it("reuses one direct-advertise Session across multiple direct: true registrations instead of reconnecting for each", async () => {
    wireTwoSessions();
    const { serve } = await import("./serve.js");

    await serve({ procedure: "agent.x.ring", exec: "true", direct: true, ttlSeconds: 3600 });
    await serve({ procedure: "agent.y.ring", exec: "true", direct: true, ttlSeconds: 3600 });

    // Two identities x one connect each = 2 total, not 3 or 4 -- the direct-advertise leg connects once, not per registration.
    expect(mocks.connectWithFallback).toHaveBeenCalledTimes(2);
  });

  it("never opens the direct-advertise Session at all when nothing asks for direct: true", async () => {
    wireTwoSessions();
    const { serve } = await import("./serve.js");

    await serve({ procedure: "agent.x.ring", exec: "true" });

    expect(mocks.loadOrGenerateIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.loadOrGenerateIdentity).toHaveBeenCalledWith(SERVE_IDENTITY_PATH);
  });

  it("closes BOTH Sessions once the last registration is unserved", async () => {
    const { servingSession, advertiseSession, servingIdentity, advertiseIdentity } = wireTwoSessions();
    const { serve, unserve } = await import("./serve.js");

    await serve({ procedure: "agent.x.ring", exec: "true", direct: true, ttlSeconds: 3600 });
    const res = await unserve("agent.x.ring");

    expect(res).toMatchObject({ unregistered: true, daemon_stopped: true, serving: [] });
    expect(servingSession.close).toHaveBeenCalledWith(servingIdentity);
    expect(advertiseSession.close).toHaveBeenCalledWith(advertiseIdentity);
  });
});
