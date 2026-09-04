import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serveProcedureIdentityPath } from "./mesh_config.js";

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

/**
 * Wires loadOrGenerateIdentity/connectWithFallback so:
 * - the ONE shared direct-advertise identity/session (serveAdvertiseIdentityPath(),
 *   pinned to ADVERTISE_IDENTITY_PATH via env) is a single, fixed fake, reused
 *   across every direct: true registration -- the deliberately-shared leg.
 * - every DISTINCT procedure gets its OWN identity/session, keyed by the real
 *   serveProcedureIdentityPath(procedure) (imported unmocked, exactly what
 *   serve.ts itself calls) -- this is the actual regression this file covers:
 *   two different procedures must never be handed the same identity/session.
 * Station bytes are distinct per serving session (10, 11, 12, ...) so a test
 * can tell which registration's own session a given putProcedureAdvertisement
 * call actually named.
 */
function wireSessions() {
  const advertiseSession = fakeSession(new Uint8Array(32).fill(2));
  const advertiseIdentity = fakeIdentity();
  const servingIdentityByPath = new Map<string, ReturnType<typeof fakeIdentity>>();
  const servingSessionByIdentity = new Map<object, ReturnType<typeof fakeSession>>();
  let nextStationByte = 10;

  mocks.loadOrGenerateIdentity.mockImplementation((path: string) => {
    if (path === ADVERTISE_IDENTITY_PATH) return advertiseIdentity;
    let identity = servingIdentityByPath.get(path);
    if (!identity) {
      identity = fakeIdentity();
      servingIdentityByPath.set(path, identity);
    }
    return identity;
  });
  mocks.connectWithFallback.mockImplementation(async (identity: unknown) => {
    if (identity === advertiseIdentity) return advertiseSession;
    let session = servingSessionByIdentity.get(identity as object);
    if (!session) {
      session = fakeSession(new Uint8Array(32).fill(nextStationByte++));
      servingSessionByIdentity.set(identity as object, session);
    }
    return session;
  });

  const servingSessionFor = (procedure: string) => {
    const identity = servingIdentityByPath.get(serveProcedureIdentityPath(procedure));
    return identity ? servingSessionByIdentity.get(identity) : undefined;
  };
  const servingIdentityFor = (procedure: string) => servingIdentityByPath.get(serveProcedureIdentityPath(procedure));

  return { advertiseSession, advertiseIdentity, servingSessionFor, servingIdentityFor };
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
  process.env.MACULA_MCP_SERVE_ADVERTISE_IDENTITY = ADVERTISE_IDENTITY_PATH;
});
afterEach(() => {
  delete process.env.MACULA_MCP_SERVE_ADVERTISE_IDENTITY;
  vi.resetAllMocks();
});

describe("serve: one Session per registered procedure (regression)", () => {
  it("registering two DIFFERENT procedures gives each its own Session and identity, both genuinely serving at once -- the actual bug: presence's ring endpoint used to steal the one shared serving slot from any real mesh_serve call", async () => {
    const { servingSessionFor, servingIdentityFor } = wireSessions();
    const { serve } = await import("./serve.js");

    const res1 = await serve({ procedure: "agent.some-node.ring", exec: "true" });
    const res2 = await serve({ procedure: "my_agent.summarize", exec: "true" });

    // Both registered, both listed as currently serving -- not one
    // replacing the other, and not the second one throwing "Session is
    // already serving" the way a shared-Session design would.
    expect(res1.registered).toBe(true);
    expect(res2.registered).toBe(true);
    expect(res2.serving.sort()).toEqual(["agent.some-node.ring", "my_agent.summarize"].sort());

    const session1 = servingSessionFor("agent.some-node.ring");
    const session2 = servingSessionFor("my_agent.summarize");
    expect(session1).toBeDefined();
    expect(session2).toBeDefined();
    expect(session1).not.toBe(session2); // never the same Session
    expect(servingIdentityFor("agent.some-node.ring")).not.toBe(servingIdentityFor("my_agent.summarize")); // never the same identity

    // Each Session actually served its OWN procedure, exactly once.
    expect(session1!.serve).toHaveBeenCalledTimes(1);
    expect(session1!.serve).toHaveBeenCalledWith("agent.some-node.ring", expect.any(Function));
    expect(session2!.serve).toHaveBeenCalledTimes(1);
    expect(session2!.serve).toHaveBeenCalledWith("my_agent.summarize", expect.any(Function));
  });

  it("unserving one procedure does not touch another procedure's own Session", async () => {
    const { servingSessionFor } = wireSessions();
    const { serve, unserve } = await import("./serve.js");

    await serve({ procedure: "agent.a.ring", exec: "true" });
    await serve({ procedure: "agent.b.ring", exec: "true" });
    const sessionB = servingSessionFor("agent.b.ring")!;

    const res = await unserve("agent.a.ring");

    expect(res).toMatchObject({ unregistered: true, serving: ["agent.b.ring"], daemon_stopped: false });
    expect(sessionB.close).not.toHaveBeenCalled();
    expect(sessionB.serve).toHaveBeenCalledTimes(1); // still registered, untouched
  });

  it("re-registering the SAME procedure replaces its own Session (closes the old one) without disturbing any other registration", async () => {
    const { servingSessionFor } = wireSessions();
    const { serve } = await import("./serve.js");

    await serve({ procedure: "agent.a.ring", exec: "true" });
    const firstSessionA = servingSessionFor("agent.a.ring")!;
    await serve({ procedure: "agent.other.ring", exec: "true" });
    const sessionOther = servingSessionFor("agent.other.ring")!;

    await serve({ procedure: "agent.a.ring", exec: "echo changed" });

    expect(firstSessionA.close).toHaveBeenCalledTimes(1);
    expect(sessionOther.close).not.toHaveBeenCalled();
    expect(sessionOther.serve).toHaveBeenCalledTimes(1);
  });
});

describe("serve with direct: true", () => {
  it("puts the DHT advertisement on a SEPARATE Session/identity from the one serve() itself runs on -- never the same one (regression: @macula-io/ts's own #requireHandleNotServing guard rejects putProcedureAdvertisement on a Session that is actively serve()-ing, which broke every direct-dial registration, ring_service.ts's ring endpoint included, until this split existed)", async () => {
    const { advertiseSession, servingSessionFor } = wireSessions();
    const { serve } = await import("./serve.js");

    await serve({ procedure: "agent.x.ring", exec: "true", direct: true, ttlSeconds: 3600 });

    const servingSession = servingSessionFor("agent.x.ring")!;
    expect(servingSession.serve).toHaveBeenCalledTimes(1);
    expect(servingSession.putProcedureAdvertisement).not.toHaveBeenCalled();
    expect(advertiseSession.serve).not.toHaveBeenCalled();
    expect(advertiseSession.putProcedureAdvertisement).toHaveBeenCalledTimes(1);
  });

  it("advertises the SERVING session's own resolved station, not the advertise session's -- servingStation must name whichever station will actually route the CALL", async () => {
    const { advertiseSession, servingSessionFor } = wireSessions();
    const { serve } = await import("./serve.js");

    await serve({ procedure: "agent.x.ring", exec: "true", direct: true, ttlSeconds: 3600 });

    const servingSession = servingSessionFor("agent.x.ring")!;
    expect(advertiseSession.putProcedureAdvertisement).toHaveBeenCalledWith("agent.x.ring", servingSession.stationNodeId, { ttlMs: 3_600_000 });
  });

  it("reuses ONE shared direct-advertise Session across multiple direct: true registrations for DIFFERENT procedures, even though each gets its own serving Session", async () => {
    const { advertiseSession, servingSessionFor } = wireSessions();
    const { serve } = await import("./serve.js");

    await serve({ procedure: "agent.x.ring", exec: "true", direct: true, ttlSeconds: 3600 });
    await serve({ procedure: "agent.y.ring", exec: "true", direct: true, ttlSeconds: 3600 });

    // Two DISTINCT serving sessions (the regression fix)...
    expect(servingSessionFor("agent.x.ring")).not.toBe(servingSessionFor("agent.y.ring"));
    // ...but the advertise leg connected exactly once and both advertisements landed on it.
    expect(advertiseSession.putProcedureAdvertisement).toHaveBeenCalledTimes(2);
    // Exactly 3 distinct identities ever passed to connectWithFallback: two serving + one shared advertise.
    const distinctIdentities = new Set(mocks.connectWithFallback.mock.calls.map(([identity]: [unknown]) => identity));
    expect(distinctIdentities.size).toBe(3);
  });

  it("never opens the direct-advertise Session at all when nothing asks for direct: true", async () => {
    const { advertiseSession } = wireSessions();
    const { serve } = await import("./serve.js");

    await serve({ procedure: "agent.x.ring", exec: "true" });

    expect(advertiseSession.putProcedureAdvertisement).not.toHaveBeenCalled();
    const identitiesUsed = new Set(mocks.connectWithFallback.mock.calls.map(([identity]: [unknown]) => identity));
    expect(identitiesUsed.size).toBe(1); // only the one serving identity, no advertise leg
  });

  it("closes the serving Session AND the shared advertise Session once the LAST registration is unserved, but not before", async () => {
    const { advertiseSession, servingSessionFor } = wireSessions();
    const { serve, unserve } = await import("./serve.js");

    await serve({ procedure: "agent.x.ring", exec: "true", direct: true, ttlSeconds: 3600 });
    await serve({ procedure: "agent.y.ring", exec: "true", direct: true, ttlSeconds: 3600 });
    const sessionX = servingSessionFor("agent.x.ring")!;
    const sessionY = servingSessionFor("agent.y.ring")!;

    const resFirst = await unserve("agent.x.ring");
    expect(resFirst).toMatchObject({ unregistered: true, daemon_stopped: false });
    expect(sessionX.close).toHaveBeenCalledTimes(1);
    expect(advertiseSession.close).not.toHaveBeenCalled(); // agent.y.ring still needs it

    const resLast = await unserve("agent.y.ring");
    expect(resLast).toMatchObject({ unregistered: true, daemon_stopped: true, serving: [] });
    expect(sessionY.close).toHaveBeenCalledTimes(1);
    expect(advertiseSession.close).toHaveBeenCalledTimes(1);
  });
});
