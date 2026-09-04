#!/usr/bin/env node
// The relay serve.ts's own runExec runs once per inbound ring, via the
// registered exec command (see ring_service.ts for why a relay): reads
// the call's JSON payload from stdin, forwards it as one line over the
// local socket the running macula-mcp process listens on, prints the
// one-line JSON reply to stdout. Any failure exits non-zero with the
// reason on stderr, which serve.ts turns into an error for the caller --
// "unreachable" is the honest answer when the process behind the socket
// is gone.
//
// Deliberately tiny and dependency-free: it runs in a fresh node
// process for every ring, under serve.ts's own exec timeout.

import { connect } from "node:net";

const RELAY_TIMEOUT_MS = 25_000;

function fail(reason: string): never {
  process.stderr.write(`ring_handler: ${reason}\n`);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const socketPath = process.argv[2];
  if (!socketPath) fail("usage: ring_handler.js <socket path>");
  const payload = (await readStdin()).trim();
  if (!payload) fail("empty payload on stdin");

  const reply = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply within ${RELAY_TIMEOUT_MS} ms`)), RELAY_TIMEOUT_MS);
    const socket = connect(socketPath);
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(payload.replace(/\n/g, " ") + "\n"));
    socket.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        clearTimeout(timer);
        socket.end();
        resolve(buf.slice(0, nl));
      }
    });
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (buf.indexOf("\n") === -1) reject(new Error("socket closed before a reply"));
    });
  });
  process.stdout.write(reply);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
