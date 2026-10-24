// macula-mcp#44 step 5, the lock on its own (review r1).
//
// The bug this file exists for was reproduced at 7 of 10 trials before the fix: several processes finding
// the same crashed holder's lock, each "check stale, unlink, create", so a second one deleted the lock the
// first had just taken and both held it. An in-process test cannot show that -- one event loop cannot
// interleave with itself -- so the regression test at the bottom spawns eight REAL processes that race the
// real module, the way macula-mcp-realm and the server do on a box.
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
  it("takes a free lock, records its holder, and removes the file on release", () => {
    const fd = acquireLock(lock());
    expect(JSON.parse(readFileSync(lock(), "utf8")).pid).toBe(process.pid);
    releaseLock(lock(), fd);
    expect(existsSync(lock())).toBe(false);
  });

  it("reclaims a lock left by a process that has exited, and leaves nothing behind", () => {
    writeFileSync(lock(), JSON.stringify({ pid: deadPid(), at: 0 }));
    const fd = acquireLock(lock());
    releaseLock(lock(), fd);
    expect(existsSync(lock())).toBe(false);
    expect(existsSync(marker())).toBe(false);
  });

  it("does not steal a lock a live process holds: it gives up after its own timeout", () => {
    process.env.MACULA_MCP_REALM_LOCK_TIMEOUT_MS = "120";
    writeFileSync(lock(), JSON.stringify({ pid: process.pid, at: Date.now() }));
    expect(() => acquireLock(lock())).toThrow(/credential lock/);
    expect(existsSync(lock())).toBe(true);
  });

  it("a reclaim marker a live process has just taken is not transferred, so a stale lock waits instead of being stolen twice", () => {
    process.env.MACULA_MCP_REALM_LOCK_TIMEOUT_MS = "150";
    writeFileSync(lock(), JSON.stringify({ pid: deadPid(), at: 0 }));
    mkdirSync(dir, { recursive: true });
    // Another process is inside the reclaim right now: its marker is fresh.
    writeFileSync(marker(), JSON.stringify({ pid: process.pid, at: Date.now() }));
    expect(() => acquireLock(lock())).toThrow(/credential lock/);
    expect(existsSync(lock())).toBe(true);
    expect(existsSync(marker())).toBe(true);
  });
});

describe("eight real processes against one lock", () => {
  const SRC = fileURLToPath(new URL("./realm_lock.ts", import.meta.url));

  /** Each child takes the lock, says so in a shared append-only log, holds it 40 ms, and lets go. */
  async function race(workers: number, staleLock: boolean): Promise<{ entries: number; maxConcurrent: number }> {
    const log = join(dir, "log");
    writeFileSync(log, "");
    if (staleLock) writeFileSync(lock(), JSON.stringify({ pid: deadPid(), at: 0 }));
    const worker = join(dir, "worker.mjs");
    writeFileSync(
      worker,
      [
        `import { acquireLock, releaseLock } from ${JSON.stringify(SRC)};`,
        'import { appendFileSync } from "node:fs";',
        "const [lockPath, logPath, startAt] = process.argv.slice(2);",
        "while (Date.now() < Number(startAt)) {}",
        "const fd = acquireLock(lockPath);",
        "appendFileSync(logPath, `enter ${process.pid} ${Date.now()}\\n`);",
        "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);",
        "appendFileSync(logPath, `exit ${process.pid} ${Date.now()}\\n`);",
        "releaseLock(lockPath, fd);",
      ].join("\n"),
      "utf8",
    );
    const startAt = Date.now() + 400;
    const children = Array.from({ length: workers }, () => spawn(process.execPath, [worker, lock(), log, String(startAt)], { stdio: "ignore" }));
    const codes = await Promise.all(children.map((child) => new Promise<number | null>((resolve) => child.on("exit", resolve))));
    expect(codes).toEqual(Array.from({ length: workers }, () => 0));

    // Order by time, an "exit" before an "enter" on the same millisecond (a holder that lets go and a
    // waiter that takes it in one instant never overlapped), then walk the log for the running total.
    const events = readFileSync(log, "utf8")
      .trim()
      .split("\n")
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
    return { entries: events.filter((e) => e.phase === "enter").length, maxConcurrent };
  }

  it("serializes them against a lock a crashed holder left -- the r1 case -- with never more than one holder", async () => {
    const result = await race(8, true);
    expect(result.entries).toBe(8);
    expect(result.maxConcurrent).toBe(1);
  });

  it("control: serializes them against a free lock too", async () => {
    const result = await race(8, false);
    expect(result.entries).toBe(8);
    expect(result.maxConcurrent).toBe(1);
  });
});
