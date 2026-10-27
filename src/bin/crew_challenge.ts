// macula-mcp-realm crew-challenge: the nonce a crew join sends, and the check
// of the realm's signed answer to it (macula-realm#107 R9, macula-sponsors#68).
//
// `crew join` has to know the realm at an address is the realm whose key its
// invite carries BEFORE the invite's secret leaves the machine. TLS does not
// prove it, the identity document is the host's own claim, and the key id that
// document carries is the host's claim too. The signed challenge is the one
// statement a host serving a copy cannot make.
//
// Two invocations, because the nonce must be chosen before the answer exists:
//
//   macula-mcp-realm crew-challenge nonce
//     prints {"nonce": "<64 hex>"}: 32 bytes from the OS.
//
//   macula-mcp-realm crew-challenge check --origin <https address>
//                                        --crew <64 hex> --key-id <64 hex>
//                                        --nonce <64 hex> [--answer-file <path>]
//     takes the realm's answer as JSON on standard input (or in the file) and
//     prints {"ok": true, "realm_id": "<64 hex>"} or {"ok": false, "reason":
//     "<name>"}, exit 0 or 1. A refused invocation is exit 2 and a sentence.
//
// CLI only, never an MCP tool, for bin/realm.ts's own reason: an agent's
// tool-calling loop must not make an identity decision over an answer it
// composed. The check itself is pure, and the tests pin it to the realm's
// checked-in vector.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import { checkChallenge, type ChallengeCheck } from "../crew_redeem_challenge/check.js";

/** The verb, as it is typed after the binary's name. */
export const CREW_CHALLENGE = "crew-challenge";

/** Its two halves. */
export const NONCE = "nonce";
export const CHECK = "check";

const HEX64 = /^[0-9a-f]{64}$/;
const ORIGIN = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;

const USAGE =
  "usage: macula-mcp-realm crew-challenge nonce\n" +
  "       macula-mcp-realm crew-challenge check --origin <https address> --crew <64 hex> " +
  "--key-id <64 hex> --nonce <64 hex> [--answer-file <path>]\n" +
  "  (the realm's answer is read from the file, else standard input)";

/** What one `check` asks for, once parsed. */
export interface CheckArgs {
  origin: string;
  crew: string;
  keyId: string;
  nonce: string;
  answerFile?: string;
}

/** A parse that worked, or the one line that says why it did not. */
export type Parsed = { ok: true; args: CheckArgs } | { ok: false; reason: string };

/**
 * The first word of a flag that takes a value when it was given no value, or
 * undefined when `value` is one. `--origin --crew abc` must not read the next
 * flag as the origin.
 */
const valueOf = (value: string | undefined): string | undefined =>
  value === undefined || value.startsWith("--") ? undefined : value;

interface Raw {
  origin?: string;
  crew?: string;
  keyId?: string;
  nonce?: string;
  answerFile?: string;
}

/** Every `--flag value` pair this verb knows, and the first unknown one. */
const RAW_FLAGS: Record<string, keyof Raw> = {
  "--origin": "origin",
  "--crew": "crew",
  "--key-id": "keyId",
  "--nonce": "nonce",
  "--answer-file": "answerFile"
};

const HEX_FLAGS: Array<[keyof Raw, string]> = [
  ["crew", "--crew"],
  ["keyId", "--key-id"],
  ["nonce", "--nonce"]
];

/** Every flag the check half takes, and the values it read, or the first reason it cannot run. */
function collected(argv: string[]): { raw: Raw; reason?: undefined } | { raw?: undefined; reason: string } {
  const raw: Raw = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const key = RAW_FLAGS[flag];
    if (key === undefined) return { reason: `"${flag}" is not an argument of crew-challenge check\n${USAGE}` };
    const value = valueOf(argv[i + 1]);
    if (value === undefined) return { reason: `${flag} needs a value\n${USAGE}` };
    raw[key] = value;
    i++;
  }
  return { raw };
}

/** The invocation as parsed, or the one line that says why it cannot run. Pure. */
export function parseCheckArgs(argv: string[]): Parsed {
  const scanned = collected(argv);
  if (scanned.raw === undefined) return { ok: false, reason: scanned.reason };
  const raw = scanned.raw;

  if (raw.origin === undefined || !ORIGIN.test(raw.origin)) {
    return { ok: false, reason: `--origin is the address this command called, as https://host[:port]\n${USAGE}` };
  }
  for (const [key, flag] of HEX_FLAGS) {
    const value = raw[key];
    if (value === undefined || !HEX64.test(value)) {
      return { ok: false, reason: `${flag} is 64 lowercase hex\n${USAGE}` };
    }
  }
  return {
    ok: true,
    args: {
      origin: raw.origin,
      crew: raw.crew!,
      keyId: raw.keyId!,
      nonce: raw.nonce!,
      ...(raw.answerFile === undefined ? {} : { answerFile: raw.answerFile })
    }
  };
}

/** The answer's text, from the file named or standard input. */
async function answerText(args: CheckArgs): Promise<string> {
  if (args.answerFile !== undefined) return readFileSync(args.answerFile, "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The answer as a JSON value. A body that is not JSON is a malformed answer, not a crash. */
export function answerFromText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** One check, from parsed arguments and the answer's text: the verdict, never a throw. */
export function check(args: CheckArgs, answerText: string): ChallengeCheck {
  return checkChallenge(answerFromText(answerText), {
    nonce: Buffer.from(args.nonce, "hex"),
    origin: args.origin,
    crewId: Buffer.from(args.crew, "hex"),
    keyId: Buffer.from(args.keyId, "hex")
  });
}

/** The nonce half: 32 bytes from the OS, as hex. */
export function nonceMain(): void {
  process.stdout.write(`${JSON.stringify({ nonce: randomBytes(32).toString("hex") })}\n`);
}

/** The check half: one JSON line, and an exit code the caller can branch on. */
export async function checkMain(argv: string[]): Promise<void> {
  const parsed = parseCheckArgs(argv);
  if (!parsed.ok) {
    console.error(`macula-mcp-realm crew-challenge check: ${parsed.reason}`);
    process.exitCode = 2;
    return;
  }

  const verdict = check(parsed.args, await answerText(parsed.args));
  process.stdout.write(`${JSON.stringify(verdict.ok ? { ok: true, realm_id: verdict.realmId } : { ok: false, reason: verdict.reason })}\n`);
  process.exitCode = verdict.ok ? 0 : 1;
}

/** The verb: `nonce` or `check`, and nothing else. */
export async function crewChallengeMain(argv: string[]): Promise<void> {
  const [half, ...rest] = argv;
  if (half === NONCE) return nonceMain();
  if (half === CHECK) return checkMain(rest);
  console.error(`macula-mcp-realm crew-challenge: "${half ?? ""}" is neither ${NONCE} nor ${CHECK}\n${USAGE}`);
  process.exitCode = 2;
}
