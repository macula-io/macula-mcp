import { describe, expect, it, vi } from "vitest";
import type { Identity, Session } from "@macula-io/ts";
import { closeInBackground } from "./macula_ts_client.js";

// closeInBackground is the fix for the ~250ms drain sleep (macula-go's own
// connection teardown, see macula_ts_client.ts's own doc comment) that used
// to sit on every one-shot call's hot path -- withSession's finally block
// now fires it without awaiting, so a caller gets its result the moment
// it's ready, not after teardown too. These fakes only need the two methods
// this function actually calls; structural typing does the rest.
function fakeSession(closeImpl: () => Promise<void>): Session {
  return { close: vi.fn(closeImpl) } as unknown as Session;
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
    const session = fakeSession(() => closePromise);
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
    const session = fakeSession(() => closePromise);
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
    const session = fakeSession(() => Promise.reject(new Error("connection already gone")));
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
