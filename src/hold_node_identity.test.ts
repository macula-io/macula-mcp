// macula-mcp#80: one live process per node identity on a machine. macula-station keeps one link per node id and
// closes the older with replaced_by_newer_handshake, so two processes on one key knock each other off the station
// for as long as both live. These hold an identity in this process and in real child processes, kill a holder with
// SIGKILL, and race newcomers at what it left behind.
//
// Every test holds in its own owner-only directory under the temp dir, never in this user's real hold directory.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { holdNodeIdentity, identityAddress, type HoldPlace, type IdentityHold } from "./hold_node_identity.js";

const SRC_URL = new URL("./hold_node_identity.ts", import.meta.url).href;
const ON_WINDOWS = process.platform === "win32";
/** Newcomers raced at one leftover, and how many times the race is run. */
const RACERS = 8;
const RACE_TRIALS = 5;
const RACE_TEST_MS = 60_000;

const freshId = () => randomBytes(32).toString("hex");
const isHold = (h: unknown): h is IdentityHold => typeof (h as IdentityHold).release === "function";

const holds: IdentityHold[] = [];
const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(holds.splice(0).map((h) => h.release()));
  await Promise.all(children.splice(0).map(killed));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch directory of this test's own, removed after it. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "macula-mcp-hold-"));
  dirs.push(dir);
  return dir;
}

/** A hold place in a fresh scratch directory; the hold directory itself is left for the code to make. */
const freshPlace = (): HoldPlace => ({ platform: process.platform, directory: join(scratch(), "holds") });

async function held(id: string, place: HoldPlace) {
  const h = await holdNodeIdentity(id, place);
  if (isHold(h)) holds.push(h);
  return h;
}

function killed(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

/** A real process that tries to hold `id` at `place` and stays alive; resolves with the line it says. */
function childTrying(id: string, place: HoldPlace): Promise<{ child: ChildProcess; said: string }> {
  const worker = join(scratch(), "worker.mjs");
  writeFileSync(
    worker,
    [
      // The sources import their siblings as .js, as the build emits them; a plain node runs the .ts beside each.
      'import { registerHooks } from "node:module";',
      "registerHooks({ resolve: (spec, ctx, next) => {",
      "  try { return next(spec, ctx); } catch (e) {",
      "    if (spec.startsWith('.') && spec.endsWith('.js')) return next(spec.slice(0, -3) + '.ts', ctx);",
      "    throw e;",
      "  }",
      "} });",
      `const { holdNodeIdentity } = await import(${JSON.stringify(SRC_URL)});`,
      "const [id, platform, directory] = process.argv.slice(2);",
      "const h = await holdNodeIdentity(id, { platform, directory });",
      "process.stdout.write(typeof h.release === 'function' ? 'held\\n' : `refused ${h.heldBy}\\n`);",
      "setInterval(() => {}, 1 << 30);",
    ].join("\n"),
  );
  const child = spawn(process.execPath, [worker, id, place.platform, place.directory], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.stdout!.once("data", (b: Buffer) => resolve({ child, said: b.toString().trim() }));
    child.once("exit", (code) => reject(new Error(`worker exited ${code}`)));
  });
}

async function childHolding(id: string, place: HoldPlace): Promise<ChildProcess> {
  const { child, said } = await childTrying(id, place);
  if (said !== "held") throw new Error(`the worker did not hold: ${said}`);
  return child;
}

describe("holdNodeIdentity", () => {
  it("a second hold of one identity is refused and names the holding process", async () => {
    const id = freshId();
    const place = freshPlace();
    expect(isHold(await held(id, place))).toBe(true);
    expect(await held(id, place)).toEqual({ heldBy: process.pid });
  });

  it("two identities are held side by side", async () => {
    const place = freshPlace();
    expect(isHold(await held(freshId(), place))).toBe(true);
    expect(isHold(await held(freshId(), place))).toBe(true);
  });

  it("a released identity can be held again", async () => {
    const id = freshId();
    const place = freshPlace();
    const first = await held(id, place);
    expect(isHold(first)).toBe(true);
    await (first as IdentityHold).release();
    expect(isHold(await held(id, place))).toBe(true);
  });

  it("an identity another live process holds is refused with that process's pid", async () => {
    const id = freshId();
    const place = freshPlace();
    const child = await childHolding(id, place);
    expect(await held(id, place)).toEqual({ heldBy: child.pid });
  });

  it("a holder killed with SIGKILL does not keep the identity: the next process holds it at once", async () => {
    const id = freshId();
    const place = freshPlace();
    await killed(await childHolding(id, place));
    expect(isHold(await held(id, place))).toBe(true);
  });
});

// Every platform but Windows: the hold is a socket FILE in a directory only its owner can reach, so no other user
// can take a node's identity before it, or answer for it with a pid of their choosing (#80 r=1, required 1).
describe.runIf(!ON_WINDOWS)("the hold lives where only its owner can reach it", () => {
  it("the hold is a socket in the directory it was given, which is made owner-only", async () => {
    const id = freshId();
    const place = freshPlace();
    expect(isHold(await held(id, place))).toBe(true);
    expect(identityAddress(id, place).startsWith(join(place.directory, ""))).toBe(true);
    expect(existsSync(identityAddress(id, place))).toBe(true);
    expect(statSync(place.directory).mode & 0o777).toBe(0o700);
  });

  it("a hold directory other users can reach is refused, and nothing is held", async () => {
    for (const mode of [0o777, 0o770, 0o755]) {
      const place = freshPlace();
      mkdirSync(place.directory, { mode: 0o700 });
      chmodSync(place.directory, mode);
      await expect(holdNodeIdentity(freshId(), place)).rejects.toThrow(/owner-only/);
    }
  });

  it("a hold directory that is a symbolic link is refused", async () => {
    const real = join(scratch(), "real");
    mkdirSync(real, { mode: 0o700 });
    const place = freshPlace();
    symlinkSync(real, place.directory);
    await expect(holdNodeIdentity(freshId(), place)).rejects.toThrow(/owner-only/);
  });

  it("a hold directory whose parent other users can write to is refused", async () => {
    const place = freshPlace();
    chmodSync(join(place.directory, ".."), 0o777);
    await expect(holdNodeIdentity(freshId(), place)).rejects.toThrow(/owner-only/);
  });
});

// The reclaim path (#80 r=1, required 2 and 3): a SIGKILLed holder leaves its socket file, and whoever comes next
// unlinks it under <socket>.reclaim and listens before letting go of that lock.
describe.runIf(!ON_WINDOWS)("a socket file a killed holder left behind", () => {
  it("is reclaimed: the file stays after SIGKILL, and the next process holds the identity", async () => {
    const id = freshId();
    const place = freshPlace();
    await killed(await childHolding(id, place));
    expect(existsSync(identityAddress(id, place))).toBe(true);
    expect(isHold(await held(id, place))).toBe(true);
  });

  it(
    "newcomers racing at it end with exactly one hold, and every other names that holder",
    async () => {
      for (let trial = 1; trial <= RACE_TRIALS; trial += 1) {
        const id = freshId();
        const place = freshPlace();
        await killed(await childHolding(id, place));
        const tries = await Promise.all(Array.from({ length: RACERS }, () => childTrying(id, place)));
        const holders = tries.filter((t) => t.said === "held");
        expect(holders.length, `trial ${trial}: ${tries.map((t) => t.said).join(", ")}`).toBe(1);
        const holderPid = holders[0]!.child.pid;
        for (const t of tries.filter((t) => t.said !== "held")) expect(t.said).toBe(`refused ${holderPid}`);
        await Promise.all(children.splice(0).map(killed));
      }
    },
    RACE_TEST_MS,
  );
});
