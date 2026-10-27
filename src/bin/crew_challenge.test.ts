// The verb: what an invocation means, what it prints, and the exit code a
// caller branches on. The check itself is pinned to the realm's vector in
// crew_redeem_challenge/check.test.ts; this file tests the seam around it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { check, crewChallengeMain, nonceMain, parseCheckArgs } from "./crew_challenge.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const vectorText = readFileSync(join(HERE, "..", "crew_redeem_challenge", "crew_redeem_challenge_vector.json"), "utf8");
const vector = JSON.parse(vectorText) as {
  nonce_hex: string;
  crew_id_hex: string;
  origin: string;
  answer: { realm_id: string; key_id: string };
};

const CREW = vector.crew_id_hex;
const KEY_ID = vector.answer.key_id;
const NONCE = vector.nonce_hex;
const ORIGIN = vector.origin;

const argv = (over: Record<string, string | undefined> = {}): string[] => {
  const flags: Record<string, string | undefined> = { "--origin": ORIGIN, "--crew": CREW, "--key-id": KEY_ID, "--nonce": NONCE, ...over };
  return Object.entries(flags).flatMap(([flag, value]) => (value === undefined ? [] : [flag, value]));
};

const printed = (run: () => void): string => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    run();
    return write.mock.calls.map(([chunk]) => String(chunk)).join("");
  } finally {
    write.mockRestore();
  }
};

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe("crew-challenge nonce", () => {
  it("prints 32 fresh bytes as hex, different each time", () => {
    const first = JSON.parse(printed(nonceMain)).nonce as string;
    const second = JSON.parse(printed(nonceMain)).nonce as string;

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });
});

describe("crew-challenge check", () => {
  it("reads the four things it must know", () => {
    expect(parseCheckArgs(argv())).toEqual({
      ok: true,
      args: { origin: ORIGIN, crew: CREW, keyId: KEY_ID, nonce: NONCE }
    });
    expect(parseCheckArgs([...argv(), "--answer-file", "/tmp/answer.json"])).toEqual({
      ok: true,
      args: { origin: ORIGIN, crew: CREW, keyId: KEY_ID, nonce: NONCE, answerFile: "/tmp/answer.json" }
    });
  });

  it("refuses an invocation it cannot make sense of, naming the flag", () => {
    expect(parseCheckArgs([...argv(), "--junk", "x"])).toMatchObject({ ok: false, reason: /"--junk" is not an argument/ });
    expect(parseCheckArgs(["--origin", ORIGIN, "--crew", CREW, "--key-id", KEY_ID])).toMatchObject({
      ok: false,
      reason: /--nonce needs a value|--nonce is 64 lowercase hex/
    });
    expect(parseCheckArgs(argv({ "--origin": "http://realm.example.test" }))).toMatchObject({ ok: false, reason: /--origin is the address/ });
    expect(parseCheckArgs(argv({ "--crew": "AB".repeat(32) }))).toMatchObject({ ok: false, reason: /--crew is 64 lowercase hex/ });
    expect(parseCheckArgs(argv({ "--key-id": "abc" }))).toMatchObject({ ok: false, reason: /--key-id is 64 lowercase hex/ });
    // A flag that eats the next flag would pair --origin with "--crew".
    expect(parseCheckArgs(["--origin", "--crew", CREW, "--key-id", KEY_ID, "--nonce", NONCE])).toMatchObject({
      ok: false,
      reason: /--origin needs a value/
    });
  });

  it("passes the realm's own answer and refuses the same answer under another key id", () => {
    const parsed = parseCheckArgs(argv());
    expect(parsed.ok).toBe(true);
    const args = parsed.ok ? parsed.args : undefined;
    if (args === undefined) throw new Error("the invocation did not parse");

    // The realm's own answer, as it comes over the wire: the four fields, unwrapped.
    const sent = JSON.stringify(vector.answer);
    expect(check(args, sent)).toEqual({ ok: true, realmId: vector.answer.realm_id });
    expect(check({ ...args, keyId: "0".repeat(64) }, sent)).toEqual({ ok: false, reason: "key_id_mismatch" });
  });

  it("a body that is not JSON is a malformed answer, not a crash", () => {
    const parsed = parseCheckArgs(argv());
    const args = parsed.ok ? parsed.args : undefined;
    if (args === undefined) throw new Error("the invocation did not parse");

    expect(check(args, "not json at all")).toEqual({ ok: false, reason: "malformed_answer" });
  });

  it("the verb takes nonce or check, and names neither as an invocation it can run", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await crewChallengeMain([]);
      expect(process.exitCode).toBe(2);
      expect(errors.mock.calls.map(([line]) => String(line)).join("\n")).toMatch(/is neither nonce nor check/);
    } finally {
      errors.mockRestore();
      process.exitCode = 0;
    }
  });
});
