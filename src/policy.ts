// Contact policy: the receiving operator's standing answer to a ring
// (PLAN_AGENT_CONVERSATIONS section 4, WP3). Read from a small JSON file
// next to the identity files, with MACULA_MCP_CONTACT_POLICY as a
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

/** "open" | "ask" | "allowlist" | "closed" | 1..4 (as string or number) -> a Policy, or undefined for anything else. */
export function parsePolicy(raw: unknown): Policy | undefined {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "open" || s === "1") return POLICY.open;
  if (s === "ask" || s === "2") return POLICY.ask;
  if (s === "allowlist" || s === "3") return POLICY.allowlist;
  if (s === "closed" || s === "4") return POLICY.closed;
  return undefined;
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
  for (const [key, value] of Object.entries(p)) {
    if (typeof value === "boolean") problems.push(`boolean at "${key}" -- use the policy names or 1..4, never true/false`);
  }
  let contact_policy: Policy | undefined;
  if (p.contact_policy !== undefined) {
    contact_policy = parsePolicy(p.contact_policy);
    if (contact_policy === undefined) problems.push(`contact_policy must be open, ask, allowlist or closed (or 1..4), got ${JSON.stringify(p.contact_policy)}`);
  }
  const allowlist: string[] = [];
  if (p.allowlist !== undefined) {
    if (!Array.isArray(p.allowlist)) problems.push("allowlist must be a list of 64-hex node ids");
    else {
      for (const entry of p.allowlist) {
        if (typeof entry === "string" && HEX64.test(entry)) allowlist.push(entry.toLowerCase());
        else problems.push(`allowlist entry is not a 64-hex node id: ${JSON.stringify(entry)}`);
      }
    }
  }
  const offers: string[] = [];
  if (p.offers !== undefined) {
    if (!Array.isArray(p.offers)) problems.push("offers must be a list of short strings");
    else {
      for (const entry of p.offers) {
        if (typeof entry === "string" && entry.trim().length > 0 && entry.length <= 64) offers.push(entry.trim());
        else problems.push(`offers entry must be a non-empty string of at most 64 chars: ${JSON.stringify(entry)}`);
      }
    }
  }
  return { contact_policy, allowlist, offers, problems };
}

/**
 * The effective contact policy right now. Re-read on every call (a
 * ring is rare and the file is tiny), so an operator's edit takes effect
 * on the next ring with no restart.
 */
export function loadContactPolicy(): ContactPolicy {
  const path = policyFilePath();
  let fileText: string | undefined;
  try {
    fileText = readFileSync(path, "utf8");
  } catch {
    fileText = undefined; // no file: the common case
  }
  const fromFile = fileText === undefined ? undefined : parsePolicyFile(fileText);
  const envRaw = process.env.MACULA_MCP_CONTACT_POLICY;
  const fromEnv = envRaw === undefined || envRaw.trim() === "" ? undefined : parsePolicy(envRaw);
  const problems = [...(fromFile?.problems ?? [])];
  if (envRaw !== undefined && envRaw.trim() !== "" && fromEnv === undefined) {
    problems.push(`MACULA_MCP_CONTACT_POLICY must be open, ask, allowlist or closed (or 1..4), got ${JSON.stringify(envRaw)}`);
  }
  const contact_policy = fromEnv ?? fromFile?.contact_policy ?? POLICY.ask;
  const source: ContactPolicy["source"] = fromEnv !== undefined ? "env" : fromFile?.contact_policy !== undefined ? "file" : "default";
  return {
    contact_policy,
    allowlist: fromFile?.allowlist ?? [],
    offers: fromFile?.offers ?? [],
    source,
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
// cryptographic identity (every ring is signed over it, verified by
// ownership_proof.ts) -- it is the only fit for a security boundary.
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

/** Writes `raw` back, 0600 in a 0700 directory -- same discipline as roster.sqlite3/ring_service.ts's socket dir/realm.ts's credential file. Preserves every key this module does not itself understand (only `allowlist` and, sometimes, `contact_policy` are ever touched by the callers below), so a field an operator added by hand survives a tool-driven edit. */
function writeRawPolicyFile(path: string, raw: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort, same as roster.ts/ring_service.ts
  }
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
 * opt-out from everyone stays authoritative, ring_service.ts's own
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
  const existing = Array.isArray(raw.allowlist) ? (raw.allowlist as unknown[]).filter((e): e is string => typeof e === "string").map((e) => e.toLowerCase()) : [];
  const nextAllowlist = existing.includes(id) ? existing : [...existing, id];
  const currentPolicy = parsePolicy(raw.contact_policy);
  const policyChanged = currentPolicy === undefined || currentPolicy === POLICY.ask;
  const nextPolicy: Policy = policyChanged ? POLICY.allowlist : currentPolicy;
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
  const existing = Array.isArray(raw.allowlist) ? (raw.allowlist as unknown[]).filter((e): e is string => typeof e === "string").map((e) => e.toLowerCase()) : [];
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
