// The device-proof verb: everything it decides on its own is pure (what an
// invocation means, what a request body may be), and the one boundary that
// touches a key -- NodeKey -- is faked, so the sign path is checked for what
// it asks the key to sign, not against a key file this machine happens to hold.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { load, loadOrCreate } = vi.hoisted(() => ({ load: vi.fn(), loadOrCreate: vi.fn() }));

vi.mock("@macula-io/ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@macula-io/ts")>();
  return { ...actual, NodeKey: { load, loadOrCreate } };
});

import { resetForTests } from "../connect_to_mesh.js";
import { deviceProofMain, keyMain, keyMaterial, parseDeviceProofArgs, requestFromText, signRequest } from "./device_proof.js";

const REALM = "a".repeat(64);
// A real key is never touched: NodeKey.load is the only way this verb reaches
// one, and it answers with a key that records what it was asked to sign.
const PROOF = { v: 2 as const, timestamp: 1_788_870_000_000, nonce: "00".repeat(16), signature: "ab" };

// A request body on disk: the verb reads it from a file or standard input,
// never from an argument.
const REQUESTS = mkdtempSync(join(tmpdir(), "device-proof-"));
const requestFile = (name: string, body: string) => {
  const path = join(REQUESTS, name);
  writeFileSync(path, body, { mode: 0o600 });
  return path;
};
afterAll(() => rmSync(REQUESTS, { recursive: true, force: true }));

const NODE_ID = "b".repeat(64);
// The carried public key as the key hands it over; base64 of it is what a
// realm request names.
const PUBLIC_KEY = new Uint8Array([1, 2, 3]);
const SIGNED = { node_id: NODE_ID, public_key: "AQID", proof: PROOF };

const fakeKey = (proof: unknown = PROOF) => {
  const deviceRequestProof = vi.fn(async () => proof);
  load.mockResolvedValue({ nodeIdHex: () => NODE_ID, publicKey: () => PUBLIC_KEY, deviceRequestProof });
  return deviceRequestProof;
};

const parsed = (argv: string[]) => {
  const result = parseDeviceProofArgs(argv);
  if (!result.ok) throw new Error(`expected a parse, got: ${result.reason}`);
  return result.args;
};

const reason = (argv: string[]) => {
  const result = parseDeviceProofArgs(argv);
  if (result.ok) throw new Error("expected a refusal, got a parse");
  return result.reason;
};

describe("parseDeviceProofArgs", () => {
  it("takes a procedure and a realm id, and signs a JSON body unless told otherwise", () => {
    expect(parsed(["--procedure", "crew_redeem", "--realm", REALM])).toEqual({
      procedure: "crew_redeem",
      realm: REALM,
      rule: "http",
    });
  });

  it("carries --rule and --request-file when given, in any order", () => {
    expect(parsed(["--request-file", "/tmp/r.json", "--rule", "mesh", "--realm", REALM, "--procedure", "p"])).toEqual({
      procedure: "p",
      realm: REALM,
      rule: "mesh",
      requestFile: "/tmp/r.json",
    });
  });

  it("refuses a realm that is not 32 bytes of lowercase hex", () => {
    expect(reason(["--procedure", "p", "--realm", "A".repeat(64)])).toMatch(/64 lowercase hex/);
    expect(reason(["--procedure", "p", "--realm", "a".repeat(63)])).toMatch(/64 lowercase hex/);
    expect(reason(["--procedure", "p"])).toMatch(/64 lowercase hex/);
  });

  it("refuses a missing procedure: the proof is only ever for one named procedure", () => {
    expect(reason(["--realm", REALM])).toMatch(/needs --procedure/);
  });

  it("refuses a rule that is neither http nor mesh", () => {
    expect(reason(["--procedure", "p", "--realm", REALM, "--rule", "cbor"])).toMatch(/http or mesh/);
  });

  it("refuses an unknown argument, and a flag given no value rather than eating the next flag", () => {
    expect(reason(["--procedure", "p", "--realm", REALM, "--json"])).toMatch(/"--json" is not an argument/);
    expect(reason(["--procedure", "--realm", REALM])).toMatch(/--procedure needs a value/);
  });
});

describe("requestFromText", () => {
  it("takes a JSON object as the request", () => {
    const body = requestFromText('{"crew_id":"c","secret":"s"}');
    expect(body).toEqual({ ok: true, request: { crew_id: "c", secret: "s" } });
  });

  it("refuses an array, a bare value, and anything that is not JSON", () => {
    expect(requestFromText("[]")).toMatchObject({ ok: false });
    expect(requestFromText('"text"')).toMatchObject({ ok: false });
    expect(requestFromText("null")).toMatchObject({ ok: false });
    expect(requestFromText("{")).toMatchObject({ ok: false });
  });
});

describe("signRequest", () => {
  // connect_to_mesh caches the key for the process: without this reset the
  // first test's key would answer every later one.
  beforeEach(async () => {
    await resetForTests();
    load.mockReset();
    loadOrCreate.mockReset();
  });

  it("answers the key that signed with it: node id, carried public key, proof -- from one key load", async () => {
    const sign = fakeKey();
    const request = { crew_id: "c", secret: "s" };
    await expect(signRequest({ procedure: "crew_redeem", realm: REALM, rule: "http" }, request)).resolves.toEqual(SIGNED);
    expect(sign).toHaveBeenCalledWith(REALM, "crew_redeem", request, "http");
  });
});

describe("the key verb", () => {
  beforeEach(async () => {
    await resetForTests();
    load.mockReset();
    loadOrCreate.mockReset();
  });

  it("names the key and signs nothing: node id, carried public key, profile", async () => {
    const sign = fakeKey();
    await expect(keyMaterial()).resolves.toEqual({ node_id: NODE_ID, public_key: "AQID", profile: "pq_hybrid" });
    expect(sign).not.toHaveBeenCalled();
  });

  it("prints it as one JSON line", async () => {
    fakeKey();
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await keyMain();
      expect(out).toHaveBeenCalledWith(`${JSON.stringify({ node_id: NODE_ID, public_key: "AQID", profile: "pq_hybrid" })}\n`);
      expect(process.exitCode).toBeUndefined();
    } finally {
      out.mockRestore();
      process.exitCode = undefined;
    }
  });
});

describe("deviceProofMain", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetForTests();
    stdout.length = 0;
    stderr.length = 0;
    load.mockReset();
    loadOrCreate.mockReset();
    await resetForTests();
    outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
    errSpy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      stderr.push(String(line));
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = undefined;
  });

  it("prints exactly one line, the proof itself", async () => {
    fakeKey();
    const path = requestFile("ok.json", '{"crew_id":"c","members":[{"name":"dan"}]}');
    await deviceProofMain(["--procedure", "crew_redeem", "--realm", REALM, "--request-file", path]);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]!.endsWith("\n")).toBe(true);
    expect(JSON.parse(stdout[0]!)).toEqual(SIGNED);
    expect(stderr).toEqual([]);
  });

  it("refuses a bad invocation before it reads a request or touches a key", async () => {
    await deviceProofMain(["--procedure", "crew_redeem"]);
    expect(process.exitCode).toBe(2);
    expect(stderr.join("\n")).toMatch(/64 lowercase hex/);
    expect(loadOrCreate).not.toHaveBeenCalled();
  });

  it("refuses a request that is not a JSON object, and signs nothing", async () => {
    const path = requestFile("array.json", "[]");
    await deviceProofMain(["--procedure", "crew_redeem", "--realm", REALM, "--request-file", path]);
    expect(process.exitCode).toBe(2);
    expect(stderr.join("\n")).toMatch(/JSON object of fields/);
    expect(loadOrCreate).not.toHaveBeenCalled();
  });

  it("reports a key that cannot sign as one line, not as a stack trace", async () => {
    load.mockRejectedValue(new Error("the key is unreadable"));
    const path = requestFile("sign.json", '{"crew_id":"c"}');
    await deviceProofMain(["--procedure", "crew_redeem", "--realm", REALM, "--request-file", path]);
    expect(process.exitCode).toBe(1);
    expect(stderr.join("\n")).toMatch(/the key is unreadable/);
    expect(stdout).toEqual([]);
  });

  // The bug this verb exists to avoid (macula-sponsors#68 r2, Uranus B2): a
  // command that merely signs must never mint a key, or a mistyped agent name
  // creates a fresh identity and a node no session will ever run on.
  it("loads the key and refuses when there is none: it never creates one", async () => {
    load.mockRejectedValue(new Error("ENOENT: no such file or directory"));
    const path = requestFile("missing.json", '{"crew_id":"c"}');
    await deviceProofMain(["--procedure", "crew_redeem", "--realm", REALM, "--request-file", path]);
    expect(process.exitCode).toBe(1);
    expect(stderr.join("\n")).toMatch(/never creates one/);
    expect(stderr.join("\n")).toMatch(/start that member once/);
    expect(load).toHaveBeenCalled();
    expect(loadOrCreate).not.toHaveBeenCalled();
    expect(stdout).toEqual([]);
  });

  it("the key verb loads too: a name this machine holds no key for is refused, not invented", async () => {
    load.mockRejectedValue(new Error("ENOENT: no such file or directory"));
    await keyMain();
    expect(process.exitCode).toBe(1);
    expect(stderr.join("\n")).toMatch(/never creates one/);
    expect(loadOrCreate).not.toHaveBeenCalled();
  });
});
