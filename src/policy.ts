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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
