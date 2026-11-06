// One live process per node identity on this machine (macula-mcp#80).
//
// macula-station keeps ONE link per node id: when a second handshake completes under an id that already has a
// link, it closes the older one with replaced_by_newer_handshake, and the older one's reconnect then closes the
// newer. Two macula-mcp processes on one key (a configured server and a plugin's copy in one Claude Code session,
// both reading the same MACULA_MCP_IDENTITY or session id) therefore knock each other off the station for as long
// as both live, and every call in flight on the dropped link fails or times out. So before it links, a process
// takes its identity here, and a second process is told who holds it instead of fighting for the link.
//
// The hold sits where only its owner can reach it (review r=1). A name in a namespace every local user shares (a
// Linux abstract socket, a Windows pipe) lets any of them take a node's identity first and keep it, or answer for
// it with a pid of their choosing. So:
//
//   - Everywhere but Windows, the hold is a listening socket FILE in the hold directory, which must be a real
//     directory this user owns that nobody else can enter, under a parent nobody else can write to. A holder that
//     dies leaves its file. Whoever comes next and finds nobody answering on it unlinks it and listens, both while
//     holding <file>.reclaim (realm_lock.ts's O_EXCL lock): a listen outside that lock can only take a path no
//     file is at, and a file is only unlinked inside it, so two newcomers never both hold.
//   - On Windows, where a socket is always a pipe in the shared namespace, the hold is a file in the hold
//     directory opened with no sharing (UV_FS_O_EXLOCK), which the kernel closes when its holder exits however it
//     exits. The directory sits in the user's profile and inherits its owner-only ACL; the holder's pid is
//     written to a file beside it.
//
// Whoever asks an identity's holder who it is gets the holder's pid as one line, and nothing else is ever read
// from or written to the socket.
import { createConnection, createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { acquireLock, releaseLock } from "./realm_lock.js";

/** What a refused hold knows: the holder's pid, or undefined when the holder did not say. */
export type IdentityHeld = { heldBy: number | undefined };
/** An identity this process holds until it releases it or exits. */
export type IdentityHold = { release(): Promise<void> };
/**
 * Test-only pause points inside a reclaim, which is otherwise decided in a few syscalls no test can come between:
 * after the leftover was asked and before it is unlinked, and after the unlink and before the listen. Each is
 * awaited while .reclaim is held. Nothing outside the tests passes them.
 */
export type ReclaimPauses = { askedToUnlink?: () => Promise<void>; unlinkedToListen?: () => Promise<void> };
/** Where this machine holds node identities: the platform's mechanism and the directory it holds them in. */
export type HoldPlace = { platform: NodeJS.Platform; directory: string; pausesForTests?: ReclaimPauses };

/** How long a newcomer waits for a holder to say its pid before taking it as held by a process that did not say. */
export const HOLDER_ANSWER_MS = 2_000;
/** Attempts at holding: a leftover file socket reclaimed, or a holder that left between listen and ask, retries. */
const HOLD_ATTEMPTS = 3;
/** A socket file path stays short (see socketPathMaxBytes): the node id is cut to this many hex digits. */
const HOLD_ID_HEX = 24;
/** sizeof(sun_path) in <sys/un.h>: 108 on Linux, 104 on macOS and the BSDs. */
const SUN_PATH_LINUX = 108;
const SUN_PATH_BSD = 104;
/** The bytes sun_path keeps for the terminating NUL. */
const SUN_PATH_NUL = 1;
/** Permission bits that let anyone but the owner into the hold directory. */
const NOT_OWNER_BITS = 0o077;
/** Permission bits that let anyone but the owner write to the hold directory's parent. */
const OTHERS_WRITE_BITS = 0o022;
/**
 * libuv's open flag for "no sharing" on Windows, UV_FS_O_EXLOCK in libuv's include/uv/win.h; its fs__open opens the
 * file with share mode 0 when it is set. Node passes numeric open flags through to libuv but does not export this one
 * in fs.constants (Node 24 on windows-latest has none), so it is used only where Node gives no value of its own.
 */
const LIBUV_WIN_O_EXLOCK = 0x10000000;

/**
 * The hold directory: under $XDG_RUNTIME_DIR when it is set (a per-user directory on local storage, emptied at
 * logout), else under the user's config directory, beside the keys.
 */
export function holdDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime && isAbsolute(runtime)) return join(runtime, "macula-mcp", "holds");
  return join(homedir(), ".config", "macula-mcp", "holds");
}

/** This process's hold place. */
export function holdPlace(): HoldPlace {
  return { platform: process.platform, directory: holdDirectory() };
}

const holdName = (nodeIdHex: string) => nodeIdHex.toLowerCase().slice(0, HOLD_ID_HEX);

/** Where one node identity is held: a socket file, or on Windows the locked file. */
export function identityAddress(nodeIdHex: string, place: HoldPlace = holdPlace()): string {
  const suffix = place.platform === "win32" ? "hold" : "sock";
  return join(place.directory, `${holdName(nodeIdHex)}.${suffix}`);
}

function notOwnerOnly(directory: string, why: string): Error {
  return new Error(
    `the identity hold directory ${directory} is not owner-only (${why}), so another user could take this node's ` +
      `identity or answer for it: make it a directory you own with mode 0700 (chmod 700 ${directory}), or remove it`,
  );
}

/** The longest socket file path this platform takes, in bytes. */
export function socketPathMaxBytes(platform: NodeJS.Platform): number {
  return (platform === "linux" ? SUN_PATH_LINUX : SUN_PATH_BSD) - SUN_PATH_NUL;
}

/** Refuses, by name, a socket path the kernel would refuse with a bare EINVAL or cut short. */
function shortEnoughSocketPath(address: string, platform: NodeJS.Platform): void {
  const bytes = Buffer.byteLength(address);
  const max = socketPathMaxBytes(platform);
  if (bytes <= max) return;
  throw new Error(
    `the identity hold socket ${address} is ${bytes} bytes, longer than the ${max} bytes a socket path may have ` +
      `on ${platform}: hold identities in a shorter directory (set XDG_RUNTIME_DIR to one)`,
  );
}

/** Makes the hold directory owner-only if it is new, and refuses one anybody else could reach. */
function ownerOnlyDirectory(place: HoldPlace): void {
  mkdirSync(place.directory, { recursive: true, mode: 0o700 });
  if (place.platform === "win32") return;
  const uid = process.getuid!();
  const dir = lstatSync(place.directory);
  if (!dir.isDirectory()) throw notOwnerOnly(place.directory, "it is not a directory");
  if (dir.uid !== uid) throw notOwnerOnly(place.directory, `owned by uid ${dir.uid}`);
  if ((dir.mode & NOT_OWNER_BITS) !== 0) throw notOwnerOnly(place.directory, `mode ${(dir.mode & 0o777).toString(8)}`);
  // The parent may be reached through a link (a ~/.config kept elsewhere): what counts is the directory it is.
  const parent = statSync(dirname(place.directory));
  if (parent.uid !== uid) throw notOwnerOnly(place.directory, `its parent is owned by uid ${parent.uid}`);
  if ((parent.mode & OTHERS_WRITE_BITS) !== 0) {
    throw notOwnerOnly(place.directory, `others can write to its parent, mode ${(parent.mode & 0o777).toString(8)}`);
  }
}

function listen(server: Server, address: string): Promise<"listening" | "in_use"> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (e.code === "EADDRINUSE") resolve("in_use");
      else reject(e);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve("listening");
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(address);
  });
}

function pidIn(said: string): number | undefined {
  const pid = Number(said.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** The pid the identity's holder answers with; "none" when nobody listens there (gone, or a leftover file). */
function askHolder(address: string): Promise<number | undefined | "none"> {
  return new Promise((resolve) => {
    let said = "";
    const socket = createConnection(address);
    const done = (answer: number | undefined | "none") => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => done(undefined), HOLDER_ANSWER_MS);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      said += chunk;
    });
    socket.on("end", () => done(pidIn(said)));
    socket.on("error", (e: NodeJS.ErrnoException) =>
      done(e.code === "ECONNREFUSED" || e.code === "ENOENT" ? "none" : undefined),
    );
  });
}

/**
 * A hold whose release lets go once: a second release does nothing, so it can never close a descriptor or unlink a
 * file that by then belongs to whoever holds the identity next.
 */
function releasedOnce(letGo: () => Promise<void>): IdentityHold {
  let released: Promise<void> | undefined;
  return { release: () => (released ??= letGo()) };
}

/** A socket hold at `address`, or "in_use" when a file is already there. */
async function listenedHold(address: string): Promise<IdentityHold | "in_use"> {
  const server = createServer((socket) => socket.end(`${process.pid}\n`));
  if ((await listen(server, address)) === "in_use") return "in_use";
  // The hold never keeps the process alive on its own.
  server.unref();
  return releasedOnce(() => new Promise((resolve) => server.close(() => resolve())));
}

function unlinkedIfThere(address: string): void {
  try {
    unlinkSync(address);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** The file at `address` as device and inode, or undefined when there is none. */
function fileAt(address: string): string | undefined {
  try {
    const st = lstatSync(address);
    return `${st.dev}:${st.ino}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/**
 * A file socket no process answers on: under the reclaim lock, asked again, unlinked, and listened on before the
 * lock is let go, so nobody else can decide it is a leftover once this process is listening there.
 *
 * Only the file that did not answer is unlinked (review r=2). A newcomer outside the lock may take the address the
 * moment it is free, and between its bind and its listen it does not answer either: its file is a different inode,
 * so it stands, and the next ask finds it.
 */
async function reclaimedHold(address: string, pauses: ReclaimPauses): Promise<IdentityHold | "in_use"> {
  const lock = `${address}.reclaim`;
  const fd = await acquireLock(lock);
  try {
    const asked = fileAt(address);
    if ((await askHolder(address)) !== "none") return "in_use";
    await pauses.askedToUnlink?.();
    const now = fileAt(address);
    if (now !== asked) return "in_use";
    if (now !== undefined) unlinkedIfThere(address);
    await pauses.unlinkedToListen?.();
    return await listenedHold(address);
  } finally {
    releaseLock(lock, fd);
  }
}

async function holdSocketFile(address: string, pauses: ReclaimPauses): Promise<IdentityHold | IdentityHeld> {
  for (let attempt = 1; attempt <= HOLD_ATTEMPTS; attempt += 1) {
    const first = await listenedHold(address);
    if (first !== "in_use") return first;
    const holder = await askHolder(address);
    if (holder !== "none") return { heldBy: holder };
    const reclaimed = await reclaimedHold(address, pauses);
    if (reclaimed !== "in_use") return reclaimed;
  }
  return { heldBy: undefined };
}

function pidOnFile(pidFile: string): number | undefined {
  try {
    return pidIn(readFileSync(pidFile, "utf8"));
  } catch {
    return undefined;
  }
}

/** Windows: a file opened with no sharing, which no other process can open until this one closes it or exits. */
function holdLockedFile(address: string): IdentityHold | IdentityHeld {
  const noSharing = (constants as { UV_FS_O_EXLOCK?: number }).UV_FS_O_EXLOCK ?? LIBUV_WIN_O_EXLOCK;
  const pidFile = `${address}.pid`;
  let fd: number;
  try {
    fd = openSync(address, constants.O_CREAT | constants.O_WRONLY | noSharing);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EBUSY") throw e;
    return { heldBy: pidOnFile(pidFile) };
  }
  writeFileSync(pidFile, `${process.pid}\n`);
  return releasedOnce(async () => {
    try {
      unlinkSync(pidFile);
    } catch {
      // never written, or already gone: nothing of this hold is left in it
    }
    closeSync(fd);
  });
}

/**
 * Takes this node identity for this process, or says which process holds it. Never throws for a held identity;
 * a hold directory others could reach, or one that cannot be made or listened in, does throw.
 */
export async function holdNodeIdentity(
  nodeIdHex: string,
  place: HoldPlace = holdPlace(),
): Promise<IdentityHold | IdentityHeld> {
  ownerOnlyDirectory(place);
  const address = identityAddress(nodeIdHex, place);
  if (place.platform !== "win32") shortEnoughSocketPath(address, place.platform);
  return place.platform === "win32" ? holdLockedFile(address) : holdSocketFile(address, place.pausesForTests ?? {});
}
