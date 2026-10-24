// macula-mcp#44 step 5, the lock on its own (review r1).
//
// The bug this file exists for was reproduced at 7 of 10 trials before the fix: several processes finding
// the same crashed holder's lock, each "check stale, unlink, create", so a second one deleted the lock the
// first had just taken and both held it. An in-process test cannot show that -- one event loop cannot
// interleave with itself -- so the regression test at the bottom spawns eight REAL processes that race the
// real module, the way macula-mcp-realm and the server do on a box.
//
// How that race is judged changed after one unexplained CI failure (8 entries, 2 concurrent): the holders
// are caught by a witness file that a holder O_EXCL-creates, not by ordering the children's Date.now()
// readings, because a clock step between two processes can read one of them ahead of another. See `race`.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, abandonedLock, releaseLock } from "./realm_lock.js";

let dir = "";
const lock = () => join(dir, "cred.lock");
const marker = () => `${lock()}.reclaim`;
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "macula-mcp-lock-test-"));
});

afterEach(async () => {
  delete process.env.MACULA_MCP_REALM_LOCK_TIMEOUT_MS;
  await rm(dir, { recursive: true, force: true });
});

describe("abandonedLock", () => {
  const ageBy = async (ms: number): Promise<void> => {
    const old = new Date(Date.now() - ms);
    await utimes(lock(), old, old);
  };

  it("a holder that has exited is abandoned at once, whatever the file's age", async () => {
    writeFileSync(lock(), JSON.stringify({ pid: deadPid(), at: 0 }));
    expect(abandonedLock(lock())).toBe(true);
  });

  it("a live pid is abandoned past the stale window -- after a reboot that pid belongs to a system process (r2)", async () => {
    // The lock file lives under ~/.config and outlives a reboot; a crashed holder's pid is routinely reused.
    // Trusting the live pid at any age wedged every later store on this file, forever.
    writeFileSync(lock(), JSON.stringify({ pid: 1, at: 0 }));
    await ageBy(24 * 60 * 60_000);
    expect(abandonedLock(lock())).toBe(true);
  });

  it("a live pid inside the stale window is not abandoned -- a store takes milliseconds", async () => {
    writeFileSync(lock(), JSON.stringify({ pid: process.pid, at: 0 }));
    await ageBy(2_000);
    expect(abandonedLock(lock())).toBe(false);
  });

  it("a file naming no readable pid is judged by age alone", async () => {
    writeFileSync(lock(), "not json");
    expect(abandonedLock(lock())).toBe(false);
    await ageBy(10 * 60_000);
    expect(abandonedLock(lock())).toBe(true);
  });
});

describe("acquireLock / releaseLock", () => {
  it("takes a free lock, records its holder, and removes the file on release", async () => {
    const fd = await acquireLock(lock());
    expect(JSON.parse(readFileSync(lock(), "utf8")).pid).toBe(process.pid);
    releaseLock(lock(), fd);
    expect(existsSync(lock())).toBe(false);
  });

  it("reclaims a lock left by a process that has exited, and leaves nothing behind", async () => {
    writeFileSync(lock(), JSON.stringify({ pid: deadPid(), at: 0 }));
    const fd = await acquireLock(lock());
    releaseLock(lock(), fd);
    expect(existsSync(lock())).toBe(false);
    expect(existsSync(marker())).toBe(false);
  });

  it("does not steal a lock a live process holds: it gives up after its own timeout", async () => {
    process.env.MACULA_MCP_REALM_LOCK_TIMEOUT_MS = "120";
    writeFileSync(lock(), JSON.stringify({ pid: process.pid, at: Date.now() }));
    await expect(acquireLock(lock())).rejects.toThrow(/credential lock/);
    expect(existsSync(lock())).toBe(true);
  });

  it("a reclaim marker a live process has just taken is not transferred, so a stale lock waits instead of being stolen twice", async () => {
    process.env.MACULA_MCP_REALM_LOCK_TIMEOUT_MS = "150";
    writeFileSync(lock(), JSON.stringify({ pid: deadPid(), at: 0 }));
    mkdirSync(dir, { recursive: true });
    // Another process is inside the reclaim right now: its marker is fresh.
    writeFileSync(marker(), JSON.stringify({ pid: process.pid, at: Date.now() }));
    await expect(acquireLock(lock())).rejects.toThrow(/credential lock/);
    expect(existsSync(lock())).toBe(true);
    expect(existsSync(marker())).toBe(true);
  });
});

describe("eight real processes against one lock", () => {
  const SRC = fileURLToPath(new URL("./realm_lock.ts", import.meta.url));

  /**
   * Each child takes the lock, says so in a shared append-only log, holds it, and lets go.
   *
   * Two holders are caught by a WITNESS FILE, never by comparing the children's clocks: a holder
   * O_EXCL-creates `inside` for as long as it is inside, so a second holder cannot create it and records a
   * `violation` naming its pid. The earlier version inferred the overlap by sorting `enter`/`exit` lines by
   * Date.now() across processes. That is sound only while the wall clock never steps backwards between two
   * children's reads -- one millisecond of NTP correction invents a second holder that never existed, and
   * an unexplained CI failure of exactly this shape is why the check changed. No clock can fake a create.
   *
   * `bypass` is the guard that this detector is not vacuous: with the lock skipped, the same race must
   * report violations, so a green test can never mean "the witness could not fail".
   */
  async function race(workers: number, staleLock: boolean, bypass = false): Promise<{ entries: number; maxConcurrent: number; violations: string[] }> {
    const log = join(dir, "log");
    const inside = join(dir, "inside");
    writeFileSync(log, "");
    await rm(inside, { force: true });
    if (staleLock) writeFileSync(lock(), JSON.stringify({ pid: deadPid(), at: 0 }));
    const worker = join(dir, "worker.mjs");
    writeFileSync(
      worker,
      [
        `import { acquireLock, releaseLock } from ${JSON.stringify(SRC)};`,
        'import { appendFileSync, closeSync, openSync, unlinkSync } from "node:fs";',
        "const [lockPath, logPath, insidePath, startAt, bypass] = process.argv.slice(2);",
        // The bypassed run holds longer so that "all eight ran serialized" is not a way for the guard to
        // pass by accident.
        "const hold = bypass === '1' ? 150 : 40;",
        "while (Date.now() < Number(startAt)) {}",
        "const fd = bypass === '1' ? 0 : await acquireLock(lockPath);",
        "let witness = -1;",
        "try { witness = openSync(insidePath, 'wx', 0o600); } catch (e) { appendFileSync(logPath, `violation ${process.pid} ${e.code}\\n`); }",
        "appendFileSync(logPath, `enter ${process.pid} ${Date.now()}\\n`);",
        "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hold);",
        "appendFileSync(logPath, `exit ${process.pid} ${Date.now()}\\n`);",
        "if (witness !== -1) { closeSync(witness); unlinkSync(insidePath); }",
        "if (bypass !== '1') releaseLock(lockPath, fd);",
      ].join("\n"),
      "utf8",
    );
    const startAt = Date.now() + 400;
    const children = Array.from({ length: workers }, () =>
      spawn(process.execPath, [worker, lock(), log, inside, String(startAt), bypass ? "1" : "0"], { stdio: "ignore" }),
    );
    const codes = await Promise.all(children.map((child) => new Promise<number | null>((resolve) => child.on("exit", resolve))));
    expect(codes).toEqual(Array.from({ length: workers }, () => 0));

    // Order by time, an "exit" before an "enter" on the same millisecond (a holder that lets go and a
    // waiter that takes it in one instant never overlapped), then walk the log for the running total. This
    // total is a diagnostic only -- the assertion reads the witness lines, which no clock can bend.
    const lines = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    const violations = lines.filter((line) => line.startsWith("violation "));
    const events = lines
      .filter((line) => !line.startsWith("violation "))
      .map((line) => {
        const [phase, pid, at] = line.split(" ");
        return { phase, pid, at: Number(at) };
      })
      .sort((a, b) => a.at - b.at || (a.phase === b.phase ? 0 : a.phase === "exit" ? -1 : 1));
    let live = 0;
    let maxConcurrent = 0;
    for (const event of events) {
      live += event.phase === "enter" ? 1 : -1;
      maxConcurrent = Math.max(maxConcurrent, live);
    }
    return { entries: events.filter((e) => e.phase === "enter").length, maxConcurrent, violations };
  }

  it("serializes them against a lock a crashed holder left -- the r1 case -- with never more than one holder", async () => {
    const result = await race(8, true);
    expect(result.entries).toBe(8);
    expect(result.violations, `a second holder created the witness while the first held it (clock-ordered overlap, for information only: ${result.maxConcurrent})`).toEqual([]);
  });

  it("control: serializes them against a free lock too", async () => {
    const result = await race(8, false);
    expect(result.entries).toBe(8);
    expect(result.violations, `a second holder created the witness while the first held it (clock-ordered overlap, for information only: ${result.maxConcurrent})`).toEqual([]);
  });

  it("the witness is not vacuous: with the lock bypassed, the same race reports a violation", async () => {
    const result = await race(8, true, true);
    expect(result.violations.length).toBeGreaterThan(0);
  });
});
