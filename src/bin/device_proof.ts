// macula-mcp-realm device-proof: sign one realm request with a named agent's key.
//
// A realm proof v2 (macula-realm#29) is only ever produced by the code that
// holds the key, and on a machine that key is this package's: an ML-DSA node
// key under the fleet's pq_hybrid profile, at mesh_config.ts's nodeKeyPath.
// A client that must prove a node's possession of a request -- `crew join`
// signing an enrolment with the operator's key and with each member's
// (macula-realm#107 threat model R6, macula-sponsors#68) -- would otherwise
// have to carry that whole crypto stack itself, and load the mesh SDK on a
// machine that has no realm credential yet. So it asks here instead, exactly
// as `crew` already asks macula-mcp-node-id for a node id.
//
// CLI only, never an MCP tool, for the reason bin/realm.ts gives for `join`:
// an agent's tool-calling loop must not be able to obtain a signature over a
// body it composed. A person, or a launcher on a person's own explicit action,
// runs this.
//
// One invocation answers all three things a caller must send beside the
// request -- the key's node id, its carried public key, and the proof -- so
// the key a request names and the key that signed it are never assembled from
// two different answers.
//
// What it will not do is decide what to sign. It signs the `request` it is
// given, whole, and the caller is responsible for that request being the one
// the realm will rebuild from the delivered body: a signature over a different
// shape is a bad_proof at the realm, not a wrong one here.
//
// The request is read from standard input or from a file, never from an
// argument: a shell keeps arguments in its history and the process list, and
// this body carries an invite secret (threat model R8).

import { readFileSync } from "node:fs";
import type { DeviceRequestRule, JsonValue } from "@macula-io/ts";
import { KEY_PROFILE, nodeKey } from "../connect_to_mesh.js";

/** The verb, as it is typed after the binary's name. */
export const DEVICE_PROOF = "device-proof";

/** The second verb: this configuration's key, and nothing signed. */
export const KEY = "key";

/** What one invocation asks for, once parsed. */
export interface DeviceProofArgs {
  /** The procedure the realm will verify the proof for. */
  procedure: string;
  /** The realm's 32-byte id, 64 lowercase hex. */
  realm: string;
  /** How the request becomes signed bytes: a JSON body ("http") or a call payload ("mesh"). */
  rule: DeviceRequestRule;
  /** Where the request is, or undefined to read standard input. */
  requestFile?: string;
}

/** A parse that worked, or the one line that says why it did not. */
export type Parsed = { ok: true; args: DeviceProofArgs } | { ok: false; reason: string };

/** What a stray argument is, for the message: never echoed into a shell-meaningful place. */
const USAGE =
  "usage: macula-mcp-realm device-proof --procedure <text> --realm <64 hex> [--rule http|mesh] " +
  "[--request-file <path>]  (the request is read from the file, else standard input)";

const REALM_ID = /^[0-9a-f]{64}$/;

/**
 * The first word of a flag that takes a value when it was given no value, or
 * undefined when `value` is one. `--procedure --realm abc` must not read the
 * next flag as the procedure.
 */
const valueOf = (flag: string, value: string | undefined): string | undefined =>
  value === undefined || value.startsWith("--") ? undefined : value;

/** The rule as typed ("http" when absent), or the reason it is not one. */
const ruleOf = (value: string | undefined): { ok: true; rule: DeviceRequestRule } | { ok: false; reason: string } => {
  if (value === undefined) return { ok: true, rule: "http" };
  if (value === "http" || value === "mesh") return { ok: true, rule: value };
  return { ok: false, reason: `--rule is http or mesh, not "${value}"` };
};

interface Raw {
  procedure?: string;
  realm?: string;
  rule?: string;
  requestFile?: string;
}

/** Every `--flag value` pair this verb knows, and the first unknown one. */
const RAW_FLAGS: Record<string, keyof Raw> = {
  "--procedure": "procedure",
  "--realm": "realm",
  "--rule": "rule",
  "--request-file": "requestFile",
};

const collected = (argv: string[], raw: Raw): { raw: Raw; reason?: undefined } | { raw?: undefined; reason: string } => {
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const key = RAW_FLAGS[flag];
    if (key === undefined) return { reason: `"${flag}" is not an argument of device-proof\n${USAGE}` };
    const value = valueOf(flag, argv[i + 1]);
    if (value === undefined) return { reason: `${flag} needs a value\n${USAGE}` };
    raw[key] = value;
    i++;
  }
  return { raw };
};

const missing = (raw: Raw): string | undefined => {
  if (raw.procedure === undefined) return `device-proof needs --procedure: the procedure the realm verifies the proof for\n${USAGE}`;
  if (raw.realm === undefined || !REALM_ID.test(raw.realm)) return `--realm is the realm's id, 64 lowercase hex\n${USAGE}`;
  return undefined;
};

/** The invocation as parsed, or the one line that says why it cannot run. Pure. */
export function parseDeviceProofArgs(argv: string[]): Parsed {
  const scanned = collected(argv, {});
  if (scanned.raw === undefined) return { ok: false, reason: scanned.reason };
  const raw = scanned.raw;
  const problem = missing(raw);
  if (problem !== undefined) return { ok: false, reason: problem };
  const rule = ruleOf(raw.rule);
  if (!rule.ok) return { ok: false, reason: rule.reason };
  return { ok: true, args: { procedure: raw.procedure!, realm: raw.realm!, rule: rule.rule, ...(raw.requestFile === undefined ? {} : { requestFile: raw.requestFile }) } };
}

/**
 * A request body as JSON: an object of fields, never an array or a bare value.
 * Booleans and out-of-range numbers are left to the signer, which refuses them
 * under its own rule -- one place decides what a request may hold.
 */
export function requestFromText(text: string): { ok: true; request: { [field: string]: JsonValue } } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `the request is not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "the request is a JSON object of fields, not an array or a bare value" };
  }
  return { ok: true, request: parsed as { [field: string]: JsonValue } };
}

/** The request's text, from the file named or standard input. */
async function requestText(args: DeviceProofArgs): Promise<string> {
  if (args.requestFile !== undefined) return readFileSync(args.requestFile, "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Signs and returns what the caller needs to send BESIDE the request: the
 * node id and the carried public key of the key that signed, and the proof.
 * All three come from one key load, so the key a request names and the key
 * that signed it cannot be a pair the caller assembled from two answers.
 *
 * Throws with a line a person can act on. The key is the one this
 * invocation's MACULA_MCP_AGENT / MACULA_MCP_IDENTITY names, loaded exactly
 * as the server would load it.
 */
export async function signRequest(args: DeviceProofArgs, request: { [field: string]: JsonValue }) {
  const key = await nodeKey();
  return {
    node_id: await key.nodeIdHex(),
    public_key: Buffer.from(key.publicKey()).toString("base64"),
    proof: await key.deviceRequestProof(args.realm, args.procedure, request, args.rule)
  };
}

/**
 * The key this invocation's MACULA_MCP_AGENT / MACULA_MCP_IDENTITY names: its
 * node id, its carried public key and its profile. Nothing is signed.
 *
 * A caller that must put a public key INSIDE the request it signs needs this
 * before it can compose that request (`crew join` names the operator's key in
 * the enrolment the operator then signs, macula-sponsors#68). Asking for it
 * here rather than deriving it elsewhere keeps the key and the proof that
 * matches it coming from the same place.
 */
export async function keyMaterial() {
  const key = await nodeKey();
  return {
    node_id: await key.nodeIdHex(),
    public_key: Buffer.from(key.publicKey()).toString("base64"),
    profile: KEY_PROFILE
  };
}

/** The key verb: one JSON line, or one line saying why there is no key. */
export async function keyMain(): Promise<void> {
  try {
    process.stdout.write(`${JSON.stringify(await keyMaterial())}\n`);
  } catch (e) {
    console.error(`macula-mcp-realm key: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

/** The whole verb: read, sign, print one JSON line. Sets the exit code on any refusal. */
export async function deviceProofMain(argv: string[]): Promise<void> {
  const parsed = parseDeviceProofArgs(argv);
  if (!parsed.ok) {
    console.error(`macula-mcp-realm device-proof: ${parsed.reason}`);
    process.exitCode = 2;
    return;
  }
  try {
    const body = requestFromText(await requestText(parsed.args));
    if (!body.ok) {
      console.error(`macula-mcp-realm device-proof: ${body.reason}`);
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`${JSON.stringify(await signRequest(parsed.args, body.request))}\n`);
  } catch (e) {
    console.error(`macula-mcp-realm device-proof: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
