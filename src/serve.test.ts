import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "@macula-io/ts";

const SELF = "c".repeat(64);
const CALLER = "a".repeat(64);

const mocks = vi.hoisted(() => ({ serve: vi.fn(), ownProcedure: vi.fn() }));
vi.mock("./macula_ts_client.js", () => ({ serve: mocks.serve, ownProcedure: mocks.ownProcedure }));

type Handler = (r: Request) => Promise<unknown>;
let served: { procedure: string; handler: Handler; stop: ReturnType<typeof vi.fn>; bytes?: string }[];

beforeEach(() => {
  served = [];
  mocks.ownProcedure.mockImplementation(async (name: string) => `~${SELF}/${name}`);
  mocks.serve.mockImplementation(async (args: { procedure: string; handler: Handler; bytes?: string }) => {
    const stop = vi.fn().mockResolvedValue(undefined);
    served.push({ ...args, stop });
    return { stop };
  });
});

afterEach(async () => {
  const serve = await import("./serve.js");
  await serve.stopAll();
  vi.resetAllMocks();
});

function request(procedure: string, payload: unknown): Request {
  return { caller: CALLER, realm: "00".repeat(32), procedure, payload: payload as never, deadlineMs: Date.now() + 5_000 };
}

describe("serve", () => {
  it("serves the name in this node's own namespace, asking for tagged bytes, and reports what callers call", async () => {
    const serve = await import("./serve.js");
    const result = await serve.serve({ name: "summarize", exec: "cat", bytes: "tagged" });
    expect(result).toEqual({ name: "summarize", procedure: `~${SELF}/summarize`, registered: true, serving: [`~${SELF}/summarize`] });
    expect(served[0]).toMatchObject({ procedure: `~${SELF}/summarize`, bytes: "tagged" });
  });

  it("answers a call by running the command once: the payload on stdin, stdout as the reply, the verified caller in MACULA_MCP_CALLER", async () => {
    const serve = await import("./serve.js");
    await serve.serve({ name: "whoami", exec: `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify({got:JSON.parse(s),caller:process.env.MACULA_MCP_CALLER})))'` });
    expect(await served[0]!.handler(request(`~${SELF}/whoami`, { n: 1 }))).toEqual({ got: { n: 1 }, caller: CALLER });
  });

  it("answers null for empty stdout, and refuses a failing command, a timeout, bad JSON and a likely secret", async () => {
    const serve = await import("./serve.js");
    await serve.serve({ name: "quiet", exec: "true" });
    expect(await served[0]!.handler(request("x", {}))).toBeNull();
    await serve.serve({ name: "fails", exec: "echo nope >&2; exit 3" });
    await expect(served[1]!.handler(request("x", {}))).rejects.toThrow(/exited 3: nope/);
    await serve.serve({ name: "slow", exec: "sleep 5", execTimeoutSeconds: 1 });
    await expect(served[2]!.handler(request("x", {}))).rejects.toThrow(/timed out/);
    await serve.serve({ name: "garbled", exec: "echo not-json" });
    await expect(served[3]!.handler(request("x", {}))).rejects.toThrow(/not valid JSON/);
    await serve.serve({ name: "leaky", exec: `echo '{"key":"AKIAIOSFODNN7EXAMPLE"}'` });
    await expect(served[4]!.handler(request("x", {}))).rejects.toThrow(/refusing to reply/);
  });

  it("re-registering a name changes its command in place, without advertising it again", async () => {
    const serve = await import("./serve.js");
    await serve.serve({ name: "echo", exec: `echo '"first"'` });
    await serve.serve({ name: "echo", exec: `echo '"second"'` });
    expect(served).toHaveLength(1);
    expect(await served[0]!.handler(request("x", {}))).toBe("second");
  });

  it("unserve withdraws one name and leaves the others serving; an unknown name is a no-op", async () => {
    const serve = await import("./serve.js");
    await serve.serve({ name: "a", exec: "true" });
    await serve.serve({ name: "b", exec: "true" });
    expect(await serve.unserve("a")).toEqual({ name: "a", unregistered: true, serving: [`~${SELF}/b`] });
    expect(served[0]!.stop).toHaveBeenCalledTimes(1);
    expect(served[1]!.stop).not.toHaveBeenCalled();
    expect(await serve.unserve("nothing")).toEqual({ name: "nothing", unregistered: false, serving: [`~${SELF}/b`] });
  });

  it("a name the client refuses is never served", async () => {
    mocks.ownProcedure.mockRejectedValueOnce(new Error('"a/b" is not a procedure name'));
    const serve = await import("./serve.js");
    await expect(serve.serve({ name: "a/b", exec: "true" })).rejects.toThrow(/not a procedure name/);
    expect(mocks.serve).not.toHaveBeenCalled();
  });
});
