import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity, Session } from "@macula-io/ts";

const { poolConnect, sessionConnect } = vi.hoisted(() => ({
  poolConnect: vi.fn(),
  sessionConnect: vi.fn(),
}));

// Boundary mock for the tests below that exercise call()/publish()/watch()/
// callThenDirect()'s NEW pool-vs-one-shot routing (added when macula-mcp
// migrated onto @macula-io/ts 0.14.0's Pool, see this file's own header
// doc): Session.connect/Pool.connect are the two entry points that would
// otherwise open a REAL network connection, so those two are replaced;
// Identity and MaculaCallError stay real (Identity.generate()/
// fromSeedBytes() are pure local ed25519 operations, no network, and
// toCliError's `instanceof TsCallError` check needs the real class).
vi.mock("@macula-io/ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@macula-io/ts")>();
  return {
    ...actual,
    Session: { connect: sessionConnect },
    Pool: { connect: poolConnect },
  };
});

import { call, callThenDirect, closeInBackground, publish, watch } from "./macula_ts_client.js";
import { defaultStations } from "./mesh_config.js";

// closeInBackground is the fix for the ~250ms drain sleep (macula-go's own
// connection teardown, see macula_ts_client.ts's own doc comment) that used
// to sit on every one-shot call's hot path -- withSession's finally block
// now fires it without awaiting, so a caller gets its result the moment
// it's ready, not after teardown too. These fakes only need the two methods
// this function actually calls; structural typing does the rest.
function fakeIdentityForClose(closeImpl: () => Promise<void>): { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn(closeImpl) };
}
function fakeIdentity(): Identity & { dispose: ReturnType<typeof vi.fn> } {
  return { dispose: vi.fn() } as unknown as Identity & { dispose: ReturnType<typeof vi.fn> };
}

describe("closeInBackground", () => {
  it("does not block the caller -- returns before close() resolves", async () => {
    let closeResolved = false;
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((r) => {
      resolveClose = () => {
        closeResolved = true;
        r();
      };
    });
    const session = fakeIdentityForClose(() => closePromise) as unknown as Session;
    const identity = fakeIdentity();

    closeInBackground(session, identity);
    // closeInBackground itself is synchronous (fire-and-forget); at this
    // point close() has been called but not yet awaited to completion.
    expect(session.close).toHaveBeenCalledWith(identity);
    expect(closeResolved).toBe(false);

    resolveClose();
    await closePromise;
  });

  it("disposes the identity only after close() settles, not before", async () => {
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((r) => {
      resolveClose = r;
    });
    const session = fakeIdentityForClose(() => closePromise) as unknown as Session;
    const identity = fakeIdentity();

    closeInBackground(session, identity);
    await Promise.resolve(); // let the fire-and-forget chain start
    expect(identity.dispose).not.toHaveBeenCalled();

    resolveClose();
    await closePromise;
    await Promise.resolve();
    await Promise.resolve();
    expect(identity.dispose).toHaveBeenCalledTimes(1);
  });

  it("swallows a close() failure -- best-effort teardown, never throws into the caller", async () => {
    const session = fakeIdentityForClose(() => Promise.reject(new Error("connection already gone"))) as unknown as Session;
    const identity = fakeIdentity();

    expect(() => closeInBackground(session, identity)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(identity.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes immediately when there is no session to close (connect itself failed)", () => {
    const identity = fakeIdentity();
    closeInBackground(undefined, identity);
    expect(identity.dispose).toHaveBeenCalledTimes(1);
  });
});

// ---- pool-vs-one-shot routing (@macula-io/ts 0.14.0 migration) -----------
//
// call()/publish()/watch() hold 3 simultaneous seed connections via a
// shared, lazily-created Pool (per identityPath) instead of
// connectWithFallback()'s dial-one-then-fallback -- but ONLY when the
// caller doesn't need something Pool has no equivalent for (an explicit
// `host` override, `direct`, or `ucanPath`). These tests are the actual
// proof of that routing decision, not just that the functions still work.

function fakeSession(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    call: vi.fn().mockResolvedValue("session-call-result"),
    callDirect: vi.fn().mockResolvedValue("session-call-direct-result"),
    callWithUcan: vi.fn().mockResolvedValue("session-call-ucan-result"),
    callDirectWithUcan: vi.fn().mockResolvedValue("session-call-direct-ucan-result"),
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(undefined)),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakePool(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    call: vi.fn().mockResolvedValue("pool-call-result"),
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(undefined)),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

let tmpDir: string;
let identityCounter = 0;
// A fresh identityPath per test -- sharedPool()'s cache is module-level
// state that outlives any one test (there is no exported way to clear it),
// so two tests sharing one identityPath would see each other's cached
// pool instead of the one this test's own poolConnect mock just set up.
function freshIdentityPath(): string {
  identityCounter += 1;
  return join(tmpDir, `identity-${identityCounter}.seed`);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "macula-ts-client-pool-test-"));
  poolConnect.mockReset().mockImplementation(async () => fakePool());
  sessionConnect.mockReset().mockImplementation(async () => fakeSession());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("call() routing", () => {
  it("with no host/direct/ucanPath, uses the shared pool and never opens a one-shot session", async () => {
    const pool = fakePool({ call: vi.fn().mockResolvedValue({ ok: 1 }) });
    poolConnect.mockResolvedValue(pool);
    const identityPath = freshIdentityPath();

    const result = await call({ procedure: "some.procedure", identityPath, realm: "R", timeoutMs: 5000 });

    expect(result.payload).toEqual({ ok: 1 });
    expect(pool.call).toHaveBeenCalledWith("R", "some.procedure", {}, { deadlineMs: 5000 });
    expect(sessionConnect).not.toHaveBeenCalled();
    const [seeds] = poolConnect.mock.calls[0];
    expect(seeds).toEqual(defaultStations().map((s: string) => expect.objectContaining({ host: expect.any(String), port: expect.any(Number) })));
    expect(seeds.length).toBe(defaultStations().length);
  });

  it("with an explicit host, bypasses the pool and uses a one-shot session against that host", async () => {
    const session = fakeSession({ call: vi.fn().mockResolvedValue("direct-host-result") });
    sessionConnect.mockResolvedValue(session);
    const identityPath = freshIdentityPath();

    const result = await call({ procedure: "some.procedure", identityPath, host: "custom-station.example:9999" });

    expect(result.payload).toBe("direct-host-result");
    expect(poolConnect).not.toHaveBeenCalled();
    expect(sessionConnect).toHaveBeenCalledWith("custom-station.example", 9999, expect.anything());
  });

  it("with direct=true, bypasses the pool even without a host override", async () => {
    const session = fakeSession();
    sessionConnect.mockResolvedValue(session);
    const identityPath = freshIdentityPath();

    await call({ procedure: "some.procedure", identityPath, direct: true });

    expect(poolConnect).not.toHaveBeenCalled();
    expect(session.callDirect).toHaveBeenCalled();
    expect(session.call).not.toHaveBeenCalled();
  });

  it("with ucanPath set, bypasses the pool even without a host override", async () => {
    const session = fakeSession();
    sessionConnect.mockResolvedValue(session);
    const identityPath = freshIdentityPath();
    const ucanPath = join(tmpDir, "token.ucan");
    writeFileSync(ucanPath, "fake-ucan-token");

    await call({ procedure: "some.procedure", identityPath, ucanPath });

    expect(poolConnect).not.toHaveBeenCalled();
    expect(session.callWithUcan).toHaveBeenCalled();
  });

  it("wraps a pool failure the same way withSession wraps a one-shot failure", async () => {
    poolConnect.mockResolvedValue(fakePool({ call: vi.fn().mockRejectedValue(new Error("boom")) }));
    const identityPath = freshIdentityPath();

    await expect(call({ procedure: "some.procedure", identityPath })).rejects.toThrow("boom");
  });
});

describe("publish() routing", () => {
  it("with no host, uses the shared pool", async () => {
    const pool = fakePool();
    poolConnect.mockResolvedValue(pool);
    const identityPath = freshIdentityPath();

    await publish({ topic: "some.topic", fact: { a: 1 }, identityPath, realm: "R" });

    expect(pool.publish).toHaveBeenCalledWith("R", "some.topic", { a: 1 });
    expect(sessionConnect).not.toHaveBeenCalled();
  });

  it("with an explicit host, bypasses the pool", async () => {
    const session = fakeSession();
    sessionConnect.mockResolvedValue(session);
    const identityPath = freshIdentityPath();

    await publish({ topic: "some.topic", fact: {}, identityPath, host: "custom-station.example:1234" });

    expect(poolConnect).not.toHaveBeenCalled();
    expect(session.publish).toHaveBeenCalled();
  });
});

describe("shared pool caching", () => {
  it("reuses ONE pool across call() and publish() for the same identityPath", async () => {
    const pool = fakePool();
    poolConnect.mockResolvedValue(pool);
    const identityPath = freshIdentityPath();

    await call({ procedure: "p1", identityPath });
    await publish({ topic: "t1", fact: {}, identityPath });
    await call({ procedure: "p2", identityPath });

    expect(poolConnect).toHaveBeenCalledTimes(1);
  });

  it("creates a DISTINCT pool for a distinct identityPath", async () => {
    poolConnect.mockImplementation(async () => fakePool());
    const identityPathA = freshIdentityPath();
    const identityPathB = freshIdentityPath();

    await call({ procedure: "p", identityPath: identityPathA });
    await call({ procedure: "p", identityPath: identityPathB });

    expect(poolConnect).toHaveBeenCalledTimes(2);
    const identityA = poolConnect.mock.calls[0][1];
    const identityB = poolConnect.mock.calls[1][1];
    expect(Buffer.from(identityA.nodeId).toString("hex")).not.toBe(Buffer.from(identityB.nodeId).toString("hex"));
  });

  it("evicts the cache on a genuine connect failure, so a later call retries instead of staying stuck", async () => {
    poolConnect.mockRejectedValueOnce(new Error("all seeds refused")).mockResolvedValueOnce(fakePool());
    const identityPath = freshIdentityPath();

    await expect(call({ procedure: "p", identityPath })).rejects.toThrow("all seeds refused");
    await expect(call({ procedure: "p", identityPath })).resolves.toBeDefined();

    expect(poolConnect).toHaveBeenCalledTimes(2);
  });
});

describe("watch() routing", () => {
  it("with no host, subscribes via the pool, collects events, and unsubscribes once the duration elapses", async () => {
    vi.useFakeTimers();
    try {
      let capturedHandler: ((evt: { publisher: Uint8Array; seq: number; payload: unknown }) => void) | undefined;
      const unsubscribe = vi.fn().mockResolvedValue(undefined);
      const pool = fakePool({
        subscribe: vi.fn(async (_realm: string | undefined, _topic: string, handler: typeof capturedHandler) => {
          capturedHandler = handler;
          return unsubscribe;
        }),
      });
      poolConnect.mockResolvedValue(pool);
      const identityPath = freshIdentityPath();

      const watchPromise = watch({ topic: "some.topic", durationSeconds: 5, identityPath });
      await vi.waitFor(() => expect(capturedHandler).toBeDefined());
      capturedHandler!({ publisher: new Uint8Array([1, 2, 3]), seq: 7, payload: { hello: "world" } });

      await vi.advanceTimersByTimeAsync(5000);
      const events = await watchPromise;

      expect(events).toEqual([{ topic: "some.topic", publisher: "010203", seq: 7, payload: { hello: "world" } }]);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(sessionConnect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves early once `count` events have arrived, without waiting out the full duration", async () => {
    vi.useFakeTimers();
    try {
      let capturedHandler: ((evt: { publisher: Uint8Array; seq: number; payload: unknown }) => void) | undefined;
      const unsubscribe = vi.fn().mockResolvedValue(undefined);
      const pool = fakePool({
        subscribe: vi.fn(async (_realm: string | undefined, _topic: string, handler: typeof capturedHandler) => {
          capturedHandler = handler;
          return unsubscribe;
        }),
      });
      poolConnect.mockResolvedValue(pool);
      const identityPath = freshIdentityPath();

      const watchPromise = watch({ topic: "some.topic", durationSeconds: 60, count: 1, identityPath });
      await vi.waitFor(() => expect(capturedHandler).toBeDefined());
      capturedHandler!({ publisher: new Uint8Array([9]), seq: 1, payload: null });

      const events = await watchPromise; // must resolve without advancing timers at all
      expect(events).toHaveLength(1);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("with an explicit host, bypasses the pool", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const session = fakeSession({ subscribe: vi.fn().mockResolvedValue(stop) });
    sessionConnect.mockResolvedValue(session);
    const identityPath = freshIdentityPath();

    const events = await watch({ topic: "t", durationSeconds: 0.01, identityPath, host: "custom-station.example:1234" });

    expect(events).toEqual([]);
    expect(poolConnect).not.toHaveBeenCalled();
    expect(session.subscribe).toHaveBeenCalled();
  });
});

describe("callThenDirect() routing", () => {
  it("with no host, tries the pool first and never opens a session when the pool succeeds", async () => {
    const pool = fakePool({ call: vi.fn().mockResolvedValue("pool-result") });
    poolConnect.mockResolvedValue(pool);
    const identityPath = freshIdentityPath();

    const result = await callThenDirect({ procedure: "p", identityPath });

    expect(result.payload).toBe("pool-result");
    expect(sessionConnect).not.toHaveBeenCalled();
  });

  it("with no host, falls back to a one-shot session's callDirect() when the pool's plain call fails", async () => {
    poolConnect.mockResolvedValue(fakePool({ call: vi.fn().mockRejectedValue(new Error("temporary_relay_failure")) }));
    const session = fakeSession({ callDirect: vi.fn().mockResolvedValue("direct-result") });
    sessionConnect.mockResolvedValue(session);
    const identityPath = freshIdentityPath();

    const result = await callThenDirect({ procedure: "p", identityPath });

    expect(result.payload).toBe("direct-result");
    expect(session.callDirect).toHaveBeenCalled();
  });

  it("combines both error messages when the pool call AND the direct-dial fallback both fail", async () => {
    poolConnect.mockResolvedValue(fakePool({ call: vi.fn().mockRejectedValue(new Error("temporary_relay_failure")) }));
    const session = fakeSession({ callDirect: vi.fn().mockRejectedValue(new Error("no direct-dial advertisement")) });
    sessionConnect.mockResolvedValue(session);
    const identityPath = freshIdentityPath();

    await expect(callThenDirect({ procedure: "p", identityPath })).rejects.toThrow(
      /temporary_relay_failure; direct-dial retry: no direct-dial advertisement/,
    );
  });

  it("with an explicit host, bypasses the pool and shares ONE session for both legs", async () => {
    const session = fakeSession({
      call: vi.fn().mockRejectedValue(new Error("plain failed")),
      callDirect: vi.fn().mockResolvedValue("direct-result"),
    });
    sessionConnect.mockResolvedValue(session);
    const identityPath = freshIdentityPath();

    const result = await callThenDirect({ procedure: "p", identityPath, host: "custom-station.example:1234" });

    expect(result.payload).toBe("direct-result");
    expect(poolConnect).not.toHaveBeenCalled();
    expect(session.call).toHaveBeenCalledTimes(1);
    expect(session.callDirect).toHaveBeenCalledTimes(1);
    expect(sessionConnect).toHaveBeenCalledTimes(1); // ONE session, not two
  });
});
