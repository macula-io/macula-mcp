// Contact policy: the receiving operator's standing answer to a ring.
// Read from a small JSON file next to the identity files, with MACULA_MCP_CONTACT_POLICY as a
// per-process override of the policy alone -- the file is what an
// operator edits once; the env var is for one session or one script.
//
//   ~/.config/macula-mcp/contact_policy.json
//   {
//     "contact_policy": "ask",            // open | ask | allowlist | closed, or 1..4
//     "allowlist": ["<64-hex node id>"],  // used by "allowlist"; citizen ids are node ids today
//     "offers": ["erlang", "code review"] // what this agent can help with (advertised by WP4)
//   }
//
// No booleans anywhere, the policy is an integer on the wire and in
// status. A missing file is the default (ask). A malformed file is ALSO
// the default, with the parse problem surfaced in status rather than
// thrown: a typo in a config file must never make an agent unringable
// without saying so.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** No booleans: the policy is one of these integers, advertised as contact_policy. */
export const POLICY = { open: 1, ask: 2, allowlist: 3, closed: 4 } as const;
export type Policy = (typeof POLICY)[keyof typeof POLICY];

export function policyLabel(p: Policy): keyof typeof POLICY {
  return p === 1 ? "open" : p === 2 ? "ask" : p === 3 ? "allowlist" : "closed";
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

export interface ContactPolicy {
  contact_policy: Policy;
  /** Lowercased 64-hex node ids (citizen ids are node ids today). */
  allowlist: string[];
  offers: string[];
  /** Where contact_policy came from: the env override, the file, or the built-in default. */
  source: "env" | "file" | "default";
  path: string;
  /** Set when the file exists but could not be used; the policy is then the default (or the env override). */
  error?: string;
}

export function policyFilePath(): string {
  return process.env.MACULA_MCP_CONTACT_POLICY_FILE ?? join(homedir(), ".config", "macula-mcp", "contact_policy.json");
}

const POLICY_BY_NAME = new Map<string, Policy>([
  ["open", POLICY.open],
  ["1", POLICY.open],
  ["ask", POLICY.ask],
  ["2", POLICY.ask],
  ["allowlist", POLICY.allowlist],
  ["3", POLICY.allowlist],
  ["closed", POLICY.closed],
  ["4", POLICY.closed],
]);

/** "open" | "ask" | "allowlist" | "closed" | 1..4 (as string or number) -> a Policy, or undefined for anything else. */
export function parsePolicy(raw: unknown): Policy | undefined {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return POLICY_BY_NAME.get(s);
}

/** Validates one allowlist entry: a 64-hex node id, lowercased on the way in. */
function allowlistEntries(value: unknown, problems: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push("allowlist must be a list of 64-hex node ids");
    return [];
  }
  const allowlist: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && HEX64.test(entry)) allowlist.push(entry.toLowerCase());
    else problems.push(`allowlist entry is not a 64-hex node id: ${JSON.stringify(entry)}`);
  }
  return allowlist;
}

/** Validates one offers entry: a non-empty short string, trimmed on the way in. */
function offerEntries(value: unknown, problems: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push("offers must be a list of short strings");
    return [];
  }
  const offers: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0 && entry.length <= 64) offers.push(entry.trim());
    else problems.push(`offers entry must be a non-empty string of at most 64 chars: ${JSON.stringify(entry)}`);
  }
  return offers;
}

/** No booleans anywhere: name each boolean key rather than letting the policy check miss it. */
function booleanKeyProblems(p: Record<string, unknown>, problems: string[]): void {
  for (const [key, value] of Object.entries(p)) {
    if (typeof value === "boolean") problems.push(`boolean at "${key}" -- use the policy names or 1..4, never true/false`);
  }
}

/** Pure: turns file contents into the file's contribution, naming every problem instead of throwing. Exported for tests. */
export function parsePolicyFile(text: string): { contact_policy?: Policy; allowlist: string[]; offers: string[]; problems: string[] } {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { allowlist: [], offers: [], problems: [`not JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { allowlist: [], offers: [], problems: ["top level must be an object"] };
  }
  const p = parsed as Record<string, unknown>;
  booleanKeyProblems(p, problems);
  let contact_policy: Policy | undefined;
  if (p.contact_policy !== undefined) {
    contact_policy = parsePolicy(p.contact_policy);
    if (contact_policy === undefined) problems.push(`contact_policy must be open, ask, allowlist or closed (or 1..4), got ${JSON.stringify(p.contact_policy)}`);
  }
  const allowlist = allowlistEntries(p.allowlist, problems);
  const offers = offerEntries(p.offers, problems);
  return { contact_policy, allowlist, offers, problems };
}

/** The file's text, or undefined when there is no file (the common case). */
function readPolicyText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The env override, naming its own problem when it is set to something unusable. */
function envPolicy(problems: string[]): Policy | undefined {
  const raw = process.env.MACULA_MCP_CONTACT_POLICY;
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = parsePolicy(raw);
  if (parsed === undefined) {
    problems.push(`MACULA_MCP_CONTACT_POLICY must be open, ask, allowlist or closed (or 1..4), got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** Where contact_policy came from: the env override, the file, or the built-in default. */
function policySource(fromEnv: Policy | undefined, fromFile: Policy | undefined): ContactPolicy["source"] {
  if (fromEnv !== undefined) return "env";
  if (fromFile !== undefined) return "file";
  return "default";
}

type PolicyFile = ReturnType<typeof parsePolicyFile>;

/** What a missing policy file contributes: the defaults, and nothing to report. */
const NO_POLICY_FILE: PolicyFile = { allowlist: [], offers: [], problems: [] };

/**
 * The effective contact policy right now. Re-read on every call (a
 * ring is rare and the file is tiny), so an operator's edit takes effect
 * on the next ring with no restart.
 */
export function loadContactPolicy(): ContactPolicy {
  const path = policyFilePath();
  const fileText = readPolicyText(path);
  const fromFile = fileText === undefined ? NO_POLICY_FILE : parsePolicyFile(fileText);
  const problems = [...fromFile.problems];
  const fromEnv = envPolicy(problems);
  return {
    contact_policy: fromEnv ?? fromFile.contact_policy ?? POLICY.ask,
    allowlist: fromFile.allowlist,
    offers: fromFile.offers,
    source: policySource(fromEnv, fromFile.contact_policy),
    path,
    ...(problems.length > 0 ? { error: problems.join("; ") } : {}),
  };
}

/** Whether `nodeId` (or a citizen id, the same string today) is on the allowlist. Case-insensitive. */
export function isAllowlisted(policy: ContactPolicy, nodeId: string): boolean {
  return policy.allowlist.includes(nodeId.toLowerCase());
}

// ---- managing the allowlist from inside a session (macula-mcp#1) ----
//
// Design decision, recorded here rather than left open: keyed by node_id,
// never by operator_name or session_name. Both are free text a peer sets
// on its OWN agent.hello (presence.ts) -- nothing verifies either, and
// roster.ts stores whatever the last hello claimed. Trusting a self-asserted
// label would let any stranger type "Raf's fleet" into operator_name and be
// auto-accepted. node_id is the one thing here that is actually a
// cryptographic identity (every ring is a CALL signed by the caller's key,
// verified before the handler sees its node_id) -- it is the only fit for
// a security boundary.
// petname.ts is used the other way around: mesh_trust_agent.ts echoes
// petname(node_id) back so a human/model can eyeball "is this the peer I
// meant" the same way mesh_ring/mesh_answer_ring already do, but it is
// never accepted as a lookup key -- petname.ts's own doc is explicit that
// two different node ids can share one (1-in-64000, not a uniqueness
// proof), which would make an allowlist keyed on it ambiguous exactly
// where an allowlist cannot afford to be.

export interface AllowlistMutationResult {
  ok: 1 | 0;
  node_id?: string;
  allowlist_size?: number;
  contact_policy?: Policy;
  policy_label?: string;
  /** 1 when this call also switched contact_policy in the file (see addToAllowlist's own doc for when that happens). */
  policy_changed?: 0 | 1;
  path: string;
  error?: string;
}

/**
 * Reads the file's raw parsed JSON (or {} if it does not exist yet),
 * naming exactly why it cannot when it can't -- a missing file is fine
 * (there is nothing to preserve), but a file that exists and is broken
 * is NOT silently replaced: overwriting an operator's mid-edit or
 * genuinely malformed file out from under them would destroy whatever
 * they were doing, the opposite of "never delete features/work."
 */
function readRawPolicyFile(path: string): { raw: Record<string, unknown> } | { error: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { raw: {} };
    return { error: `cannot read ${path}: ${e instanceof Error ? e.message : String(e)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { error: `${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)} -- fix it by hand first, this cannot safely edit a file it cannot parse` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: `${path}: top level must be an object -- fix it by hand first, this cannot safely edit a file it cannot parse` };
  }
  return { raw: parsed as Record<string, unknown> };
}

/** Writes `raw` back, 0600 in a 0700 directory -- same discipline as roster.sqlite3/serve_rings.ts's socket dir/realm.ts's credential file. Preserves every key this module does not itself understand (only `allowlist` and, sometimes, `contact_policy` are ever touched by the callers below), so a field an operator added by hand survives a tool-driven edit. */
function writeRawPolicyFile(path: string, raw: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort, same as roster.ts/serve_rings.ts
  }
}

/** The file's allowlist, lowercased, ignoring anything that is not a string. */
function rawAllowlist(raw: Record<string, unknown>): string[] {
  if (!Array.isArray(raw.allowlist)) return [];
  return (raw.allowlist as unknown[]).filter((e): e is string => typeof e === "string").map((e) => e.toLowerCase());
}

/** The policy to store after a trust, and whether that also changed it: only the unset or "ask" default flips to "allowlist". */
function trustedPolicy(current: Policy | undefined): { policy: Policy; changed: boolean } {
  if (current === undefined || current === POLICY.ask) return { policy: POLICY.allowlist, changed: true };
  return { policy: current, changed: false };
}

/**
 * Adds `nodeId` to this operator's own allowlist, so the next ring from
 * that peer skips the "ask" round-trip -- the ergonomic path
 * macula-mcp#1 asked for, in place of hand-editing the JSON file.
 *
 * Also flips contact_policy to "allowlist" in the file, but ONLY when it
 * is currently unset or the "ask" default: an allowlist nobody is
 * consulting does nothing (the exact friction the issue reported --
 * POLICY.allowlist already existed and nothing used it), so trusting the
 * first peer is also the moment "ask" stops making sense as this
 * operator's standing answer. "closed" is left alone -- a deliberate
 * opt-out from everyone stays authoritative, serve_rings.ts's own
 * switch never even consults the allowlist under closed, so the entry is
 * recorded for later but has no effect until the operator changes
 * contact_policy themselves. "open" is left alone too -- already accepts
 * everyone, so there is nothing to flip.
 */
export function addToAllowlist(nodeId: string): AllowlistMutationResult {
  const path = policyFilePath();
  const id = nodeId.toLowerCase();
  if (!HEX64.test(id)) return { ok: 0, path, error: `not a 64-hex node id: ${JSON.stringify(nodeId)}` };
  const read = readRawPolicyFile(path);
  if ("error" in read) return { ok: 0, path, error: read.error };
  const raw = read.raw;
  const existing = rawAllowlist(raw);
  const nextAllowlist = existing.includes(id) ? existing : [...existing, id];
  const { policy: nextPolicy, changed: policyChanged } = trustedPolicy(parsePolicy(raw.contact_policy));
  raw.allowlist = nextAllowlist;
  raw.contact_policy = policyLabel(nextPolicy);
  try {
    writeRawPolicyFile(path, raw);
  } catch (e) {
    return { ok: 0, path, error: `cannot write ${path}: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: 1, node_id: id, allowlist_size: nextAllowlist.length, contact_policy: nextPolicy, policy_label: policyLabel(nextPolicy), policy_changed: policyChanged ? 1 : 0, path };
}

/**
 * Removes `nodeId` from the allowlist, if present. Never touches
 * contact_policy either way -- untrusting one peer is not a signal about
 * what the operator wants for everyone else, so this never guesses at
 * reverting "allowlist" back to "ask" (there may be other trusted peers
 * still relying on it).
 */
export function removeFromAllowlist(nodeId: string): AllowlistMutationResult {
  const path = policyFilePath();
  const id = nodeId.toLowerCase();
  const read = readRawPolicyFile(path);
  if ("error" in read) return { ok: 0, path, error: read.error };
  const raw = read.raw;
  const existing = rawAllowlist(raw);
  const nextAllowlist = existing.filter((e) => e !== id);
  raw.allowlist = nextAllowlist;
  const currentPolicy = parsePolicy(raw.contact_policy) ?? POLICY.ask;
  try {
    writeRawPolicyFile(path, raw);
  } catch (e) {
    return { ok: 0, path, error: `cannot write ${path}: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: 1, node_id: id, allowlist_size: nextAllowlist.length, contact_policy: currentPolicy, policy_label: policyLabel(currentPolicy), policy_changed: 0, path };
}
