// The credential lock (macula-mcp#44 step 5): one writer per (node, realm), across PROCESSES.
//
// The realm credential file is written by this server and by macula-mcp-realm, a separate process the
// operator runs, so an in-process mutex is not enough: the lock is a file beside the credential, taken with
// O_EXCL. Whoever holds it re-reads the credential, decides, writes, and lets go.
//
// Reclaiming a lock left by a crashed holder is the subtle part, and it is why this file is separate and
// testable on its own (realm_lock.test.ts spawns real processes at it). The rule:
//
//   - A pid that is GONE reclaims at once. Anything else -- a live pid, or one that cannot be read -- is
//     judged by age: a store takes milliseconds, so a lock past LOCK_STALE_MS belongs to a wedged process
//     or to a pid that a reboot handed to somebody else.
//   - The unlink of a stale lock happens in exactly ONE place, reclaimAbandonedLock, and only the process
//     holding <lock>.reclaim may be in there. Taken with O_EXCL, so one winner; every other waiter backs
//     off and re-reads, by which time the lock is either gone or someone else's and no longer abandoned.
//
// That exclusivity is the whole point (review r1): "read says stale, unlink, create" from several waiters
// at once had no single decision point. A unlinked the stale lock and took it; then B's unlink -- decided
// before A created anything -- deleted A's LIVE lock, and B took it too. Two writers, the exact window this
// lock exists to close. It was reproduced at 7 of 10 trials with eight processes.
import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export const LOCK_TIMEOUT_MS = 5_000;
/** A lock whose holder cannot be read at all is taken as abandoned past this age. */
export const LOCK_STALE_MS = 30_000;
/** A reclaim marker this old belongs to a process that is gone or wedged; a live reclaim takes microseconds. */
export const MARKER_STALE_MS = 60_000;
const LOCK_RETRY_MS = 10;

/** How long a waiter waits before giving up. MACULA_MCP_REALM_LOCK_TIMEOUT_MS exists for the tests. */
export function lockTimeoutMs(): number {
  const configured = Number(process.env.MACULA_MCP_REALM_LOCK_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : LOCK_TIMEOUT_MS;
}

/**
 * Waits WITHOUT blocking the event loop (step 5 review, observation c). The lock is held by another process
 * for as long as that process takes, so a waiter can sit here for the whole timeout -- and this is an MCP
 * server answering other tool calls in the same process meanwhile. Sleeping synchronously froze every one of
 * them for up to five seconds, the cache refresh and the heartbeat included.
 *
 * Nothing depends on the wait being synchronous: the store's read, decide and write all happen after the lock
 * is taken and never across an await, so they still run as one uninterrupted turn.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function lockHolder(path: string): { pid?: number } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    return { pid: typeof parsed.pid === "number" ? parsed.pid : undefined };
  } catch {
    return undefined;
  }
}

function processAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A lock its holder is done with.
 *
 * A pid that is GONE decides at once: a CLI killed mid-join is the common case, and nothing has to age for
 * it. Otherwise age decides, and it decides for a readable pid too (review r2): the lock file lives under
 * ~/.config and outlives a reboot, and after a reboot a crashed holder's pid is routinely REUSED by a live
 * system process (pid 1, say). Trusting a live pid at any age wedged every later store on that file,
 * forever -- renewals failing, a membership lapsing, until someone deleted it by hand.
 *
 * Age is safe here because a store is synchronous and takes milliseconds: a lock older than LOCK_STALE_MS
 * belongs to a process that is wedged or to a pid that was reused, and a holder that overran is harmless
 * anyway -- drop() never unlinks a lock that is no longer its own.
 */
export function abandonedLock(path: string): boolean {
  const holder = lockHolder(path);
  if (holder?.pid !== undefined && !processAlive(holder.pid)) return true;
  try {
    return Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS;
  } catch {
    return true;
  }
}

/** O_EXCL create, or undefined when someone else holds it. */
function tryCreate(path: string): number | undefined {
  try {
    const fd = openSync(path, "wx", 0o600);
    writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    return fd;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw e;
  }
}

function drop(path: string, fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // nothing to release
  }
  // Transferred away while we held it (we overran the stale window): the file is someone else's now.
  if (lockHolder(path)?.pid !== process.pid) return;
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

function markerIsStale(marker: string): boolean {
  try {
    return Date.now() - statSync(marker).mtimeMs > MARKER_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Takes a reclaim marker, or gives up for this round. Never steals a live marker: the only transfer is of
 * one old enough that no live reclaim could own it (a reclaim is two syscalls), and it is done by RENAME,
 * which is atomic -- at most one waiter can move this file, and the others simply back off.
 */
function takeReclaimMarker(marker: string): number | undefined {
  const taken = tryCreate(marker);
  if (taken !== undefined) return taken;
  if (!markerIsStale(marker)) return undefined;
  const quarantine = `${marker}.${process.pid}.${randomBytes(6).toString("hex")}.stale`;
  try {
    renameSync(marker, quarantine);
  } catch {
    return undefined; // another waiter moved it first, or it is gone
  }
  try {
    unlinkSync(quarantine);
  } catch {
    // already gone
  }
  return undefined;
}

/**
 * Removes a stale lock. The ONLY place a credential lock is unlinked other than by its own holder, and
 * exclusive: one waiter at a time is ever inside here, so no one can delete a lock another just took.
 */
export function reclaimAbandonedLock(lock: string): void {
  const marker = `${lock}.reclaim`;
  const fd = takeReclaimMarker(marker);
  if (fd === undefined) return;
  try {
    // Re-read under the marker: by now the lock is either still the stale one, or gone/replaced, and a
    // replacement is not abandoned (its holder is alive).
    if (!abandonedLock(lock)) return;
    try {
      unlinkSync(lock);
    } catch {
      // already gone
    }
  } finally {
    drop(marker, fd);
  }
}

/** Takes the credential lock, or throws: a store that cannot be sure what is on disk must not write. */
export async function acquireLock(path: string): Promise<number> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + lockTimeoutMs();
  for (;;) {
    const held = tryCreate(path);
    if (held !== undefined) return held;
    if (abandonedLock(path)) reclaimAbandonedLock(path);
    if (Date.now() >= deadline) {
      throw new Error(`realm: the credential lock ${path} is held by another process (pid ${lockHolder(path)?.pid ?? "unknown"}); gave up after ${lockTimeoutMs()} ms without writing`);
    }
    await sleep(LOCK_RETRY_MS);
  }
}

/** Releases the lock this process holds. A lock reclaimed out from under us is not ours to remove. */
export function releaseLock(path: string, fd: number): void {
  drop(path, fd);
}
