// One live process per node identity on this machine (macula-mcp#80).
//
// macula-station keeps ONE link per node id: when a second handshake completes under an id that already has a
// link, it closes the older one with replaced_by_newer_handshake, and the older one's reconnect then closes the
// newer. Two macula-mcp processes on one key (a configured server and a plugin's copy in one Claude Code session,
// both reading the same MACULA_MCP_IDENTITY or session id) therefore knock each other off the station for as long
// as both live, and every call in flight on the dropped link fails or times out. So before it links, a process
// takes its identity here, and a second process is told who holds it instead of fighting for the link.
//
// The hold is a listening socket the KERNEL releases when its holder exits, however it exits: a SIGKILL or a crash
// leaves no lock to reclaim and nothing to race over. On Linux the socket is abstract (no file at all); on Windows
// it is a named pipe, which has none either. Anywhere else (macOS) it is a socket file under the temp dir, and a
// file a crashed holder left behind is unlinked only by whoever holds <file>.reclaim (realm_lock.ts's O_EXCL lock),
// after checking again that nobody answers on it, so two newcomers can never both unlink and both hold.
//
// Whoever asks an identity's holder who it is gets the holder's pid as one line, and nothing else is ever read
// from or written to the socket.
//
// No import from this package's own modules: realm_lock.ts is loaded only on the file-socket path, so a test can
// load this file in a plain child process.
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

/** What a refused hold knows: the holder's pid, or undefined when the holder did not say. */
export type IdentityHeld = { heldBy: number | undefined };
/** An identity this process holds until it releases it or exits. */
export type IdentityHold = { release(): Promise<void> };

/** How long a newcomer waits for a holder to say its pid before taking it as held by a process that did not say. */
export const HOLDER_ANSWER_MS = 2_000;
/** Attempts at holding: a leftover file socket reclaimed, or a holder that left between listen and ask, retries. */
const HOLD_ATTEMPTS = 3;
/** A socket file path stays under the 104 bytes macOS allows: the node id is cut to this many hex digits. */
const FILE_SOCKET_ID_HEX = 24;

/** Where one node identity is held on this machine. */
export function identityAddress(nodeIdHex: string, platform: NodeJS.Platform = process.platform): string {
  const id = nodeIdHex.toLowerCase();
  if (platform === "linux") return `\0macula-mcp/identity/${id}`;
  if (platform === "win32") return `\\\\.\\pipe\\macula-mcp-identity-${id}`;
  return join(tmpdir(), `macula-mcp-identity-${id.slice(0, FILE_SOCKET_ID_HEX)}.sock`);
}

const leavesAFile = (address: string) => !address.startsWith("\0") && !address.startsWith("\\\\.\\pipe\\");

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
    socket.on("end", () => {
      const pid = Number(said.trim());
      done(Number.isInteger(pid) && pid > 0 ? pid : undefined);
    });
    socket.on("error", (e: NodeJS.ErrnoException) =>
      done(e.code === "ECONNREFUSED" || e.code === "ENOENT" ? "none" : undefined),
    );
  });
}

/** A file socket no process answers on, unlinked under the reclaim lock and only after asking again. */
async function reclaimLeftover(address: string): Promise<void> {
  const { acquireLock, releaseLock } = await import("./realm_lock.js");
  const lock = `${address}.reclaim`;
  const fd = await acquireLock(lock);
  try {
    if ((await askHolder(address)) !== "none") return;
    try {
      unlinkSync(address);
    } catch {
      // already gone: the next listen settles who holds it
    }
  } finally {
    releaseLock(lock, fd);
  }
}

function holding(server: Server): IdentityHold {
  // The hold never keeps the process alive on its own.
  server.unref();
  return {
    release: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Takes this node identity for this process, or says which process holds it. Never throws for a held identity;
 * an address that cannot be listened on for any other reason (permissions, a full temp dir) does throw.
 */
export async function holdNodeIdentity(nodeIdHex: string): Promise<IdentityHold | IdentityHeld> {
  const address = identityAddress(nodeIdHex);
  for (let attempt = 1; attempt <= HOLD_ATTEMPTS; attempt += 1) {
    const server = createServer((socket) => socket.end(`${process.pid}\n`));
    if ((await listen(server, address)) === "listening") return holding(server);
    const holder = await askHolder(address);
    if (holder !== "none") return { heldBy: holder };
    // Nobody answers, yet the address is in use: a file socket a crashed holder left (abstract sockets and pipes
    // leave none, so there it was a holder that left between our listen and our ask, and listening again settles it).
    if (leavesAFile(address)) await reclaimLeftover(address);
  }
  return { heldBy: undefined };
}
