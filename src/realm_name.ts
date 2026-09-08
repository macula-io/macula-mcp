// Realm name grammar + resolution: the dotted-hierarchical string an
// operator TYPES -- never selects from a list, Raf's explicit security
// call in the multi-realm design thread (2026-09-08) -- to name which
// macula-realm deployment to join (`io.macula`, `net.beam-campus`,
// `net.beam-campus.sales`). Reversed into a domain, exactly the way
// "io.macula" already resolves to realm.macula.io today: DEFAULT_REALM_URL
// in realm.ts IS this formula, applied once, hardcoded -- this module
// generalizes it, not invents a new convention.
//
// Fixed reversal, no discovery hop (`.well-known` or otherwise): a lookup
// step between what the human typed and where they end up would
// reintroduce exactly the untrusted-indirection problem typing the name
// is meant to avoid (Raf's own reasoning for typing over selecting
// applies here too -- see the design thread).
//
// Grammar is deliberately the same shape DNS itself already enforces per
// label (RFC 1035/1123), not a looser one -- found by Fable's adversarial
// review (2026-09-08) that the naive "letters and dots" version this
// started as had three real holes, each closed below, checked against
// the review's own findings rather than reasoned about in the abstract:
//   - rejected the project's OWN example ("net.beam-campus" has a
//     hyphen) -- fixed by allowing internal hyphens per label.
//   - no case-folding rule -- "IO.macula" and "io.macula" would clobber
//     or double-write the same credential file depending on filesystem
//     case-sensitivity. Fixed: canonical form is always lowercased.
//   - no ASCII restriction -- without one, a Cyrillic "а" in place of
//     Latin "a" resolves to a REAL, differently-owned domain (a classic
//     IDN homograph attack), and punycode (xn--) is the one lookalike
//     class that survives a naive "letters only" filter since it's
//     ASCII by construction. Fixed: explicit ASCII-only check run before
//     any case-folding (so a non-ASCII character can't hide by folding
//     to something that looks like it passed), plus an explicit xn--
//     prefix rejection per label.
// A single label ("io") would resolve to realm.io, a domain anyone can
// register -- minimum two labels closes that too.
//
// The canonical form this produces is also, deliberately, already safe
// to use as a filesystem path segment directly: only lowercase letters,
// digits, hyphens, and single dots survive parseRealmName, so there is
// no separate path-safety check needed at the storage layer (no `/`, no
// `..` as a path traversal sequence -- the "no double dot anywhere"
// check above already forbids it structurally, not as a special case).

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_LENGTH = 253;
const MIN_LABELS = 2;

export interface ParsedRealmName {
  ok: true;
  /** Lowercased, otherwise byte-identical to the input -- the canonical form used for storage, resolution, and display everywhere else. Never re-derive this from the raw input a second time; one canonicalization, used consistently, is the whole point. */
  canonical: string;
  labels: string[];
}

export interface RejectedRealmName {
  ok: false;
  reason: string;
}

/** Validates and canonicalizes a typed realm name. Pure -- no filesystem or network access. */
export function parseRealmName(input: string): ParsedRealmName | RejectedRealmName {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: "realm name is empty" };
  if (trimmed.length > MAX_LENGTH) return { ok: false, reason: `realm name is longer than ${MAX_LENGTH} characters` };
  // ASCII-only check BEFORE lowercasing, on the raw input: JS's
  // toLowerCase() is Unicode-aware and would happily fold a Cyrillic а
  // to itself, so checking after case-folding would let it hide.
  if (!/^[\x00-\x7F]*$/.test(trimmed)) {
    return { ok: false, reason: "realm name must be ASCII only -- a non-ASCII character (including a lookalike of a Latin letter) is rejected outright, not folded" };
  }
  const canonical = trimmed.toLowerCase();
  if (canonical.startsWith(".") || canonical.endsWith(".") || canonical.includes("..")) {
    return { ok: false, reason: "realm name must not have an empty, leading, or trailing label" };
  }
  const labels = canonical.split(".");
  if (labels.length < MIN_LABELS) {
    return { ok: false, reason: `realm name needs at least ${MIN_LABELS} labels (e.g. "io.macula", not just "io")` };
  }
  for (const label of labels) {
    if (!LABEL.test(label)) {
      return {
        ok: false,
        reason: `"${label}" is not a valid label -- lowercase ASCII letters, digits, and internal hyphens only, must start and end with a letter or digit`,
      };
    }
    if (label.startsWith("xn--")) {
      return { ok: false, reason: `"${label}" looks like punycode (xn--) -- rejected outright, the one lookalike class a plain character check cannot catch` };
    }
  }
  return { ok: true, canonical, labels };
}

/**
 * The realm's own base URL for an already-parsed, already-canonical
 * realm name: reverse every label, dot-join, prefix "realm.". Pass
 * parseRealmName's own `canonical` output here, never raw user input --
 * this function does no validation of its own.
 *
 * Same contract as realm.ts's realmUrl() -- a bare origin, no path --
 * deliberately, so this is a drop-in override wherever that function's
 * result is used (createSession/pollSession's own baseURL param) rather
 * than needing its own separate path-joining logic.
 *
 * `realmBaseURL("io.macula")` === DEFAULT_REALM_URL (realm.ts) -- same
 * formula, not a coincidence.
 */
export function realmBaseURL(canonical: string): string {
  const reversed = canonical.split(".").reverse().join(".");
  return `https://realm.${reversed}`;
}
