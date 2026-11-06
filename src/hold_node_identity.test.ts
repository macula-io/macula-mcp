// macula-mcp#80: one live process per node identity on a machine. macula-station keeps one link per node id and
// closes the older with replaced_by_newer_handshake, so two processes on one key knock each other off the station
// for as long as both live. These hold an identity in this process and in real child processes, and kill a holder
// with SIGKILL to show the kernel lets go of it with nothing left to reclaim.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { holdNodeIdentity, type IdentityHold } from "./hold_node_identity.js";

const SRC = fileURLToPath(new URL("./hold_node_identity.ts", import.meta.url));
const freshId = () => randomBytes(32).toString("hex");
const isHold = (h: unknown): h is IdentityHold => typeof (h as IdentityHold).release === "function";

const holds: IdentityHold[] = [];
const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(holds.splice(0).map((h) => h.release()));
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function held(id: string) {
  const h = await holdNodeIdentity(id);
  if (isHold(h)) holds.push(h);
  return h;
}

/** A real process that holds `id` until killed, resolved once it says it holds it. */
function childHolding(id: string): Promise<ChildProcess> {
  const dir = mkdtempSync(join(tmpdir(), "macula-mcp-hold-"));
  dirs.push(dir);
  const worker = join(dir, "worker.mjs");
  writeFileSync(
    worker,
    [
      `import { holdNodeIdentity } from ${JSON.stringify(SRC)};`,
      "const h = await holdNodeIdentity(process.argv[2]);",
      "process.stdout.write(typeof h.release === 'function' ? 'held\\n' : `refused ${h.heldBy}\\n`);",
      "setInterval(() => {}, 1 << 30);",
    ].join("\n"),
  );
  const child = spawn(process.execPath, [worker, id], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.stdout!.once("data", (b: Buffer) => (b.toString().startsWith("held") ? resolve(child) : reject(new Error(b.toString()))));
    child.once("exit", (code) => reject(new Error(`worker exited ${code}`)));
  });
}

describe("holdNodeIdentity", () => {
  it("a second hold of one identity is refused and names the holding process", async () => {
    const id = freshId();
    expect(isHold(await held(id))).toBe(true);
    expect(await held(id)).toEqual({ heldBy: process.pid });
  });

  it("two identities are held side by side", async () => {
    expect(isHold(await held(freshId()))).toBe(true);
    expect(isHold(await held(freshId()))).toBe(true);
  });

  it("a released identity can be held again", async () => {
    const id = freshId();
    const first = await held(id);
    expect(isHold(first)).toBe(true);
    await (first as IdentityHold).release();
    expect(isHold(await held(id))).toBe(true);
  });

  it("an identity another live process holds is refused with that process's pid", async () => {
    const id = freshId();
    const child = await childHolding(id);
    expect(await held(id)).toEqual({ heldBy: child.pid });
  });

  it("a holder killed with SIGKILL leaves nothing behind: the identity is free at once", async () => {
    const id = freshId();
    const child = await childHolding(id);
    const gone = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await gone;
    expect(isHold(await held(id))).toBe(true);
  });
});
