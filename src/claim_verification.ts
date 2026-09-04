// Turns a result_reported and its claim_confirmed/claim_disputed replies
// (envelope.ts) into a derived verification status. Exists so trusting a
// peer's "done" on shared work is a mesh-visible, mechanically-derivable
// fact instead of a personal habit a coordinator applies -- the gap this
// whole design closes: an open mesh means peers can be careless, wrong,
// or genuinely adversarial, and "done" needs to be checkable, not just
// declared.
//
// Scope, stated plainly: this can only meaningfully verify
// EVIDENCE-backed claims (tests pass, CI green, a reproducible command
// produces a claimed output). It does not and cannot verify judgment
// calls ("is this the right design") -- there's no objective check for
// those, so a claim_confirmed there would just be a second unverifiable
// opinion, the same trust problem one layer down. And even for
// evidence-backed claims, this raises the bar from "trust one peer's
// unverifiable prose" to "trust evidence anyone COULD check" -- it does
// not achieve non-repudiation or cryptographic proof. A determined
// dishonest peer can still fabricate evidence or falsely claim to have
// checked; this makes dishonesty require an active, specific, falsifiable
// claim instead of a costless bare assertion, nothing stronger.
//
// Design history (three adversarial rounds, 2026-09-04, before any of
// this shipped):
//
// 1. First cut: reject a claim_confirmed/claim_disputed from the SAME
//    `from` as the result_reported it replies to (self-confirmation is
//    meaningless). Real, cheap, kept below -- but INSUFFICIENT alone:
//    minting a second identity on this mesh is free (citizenship
//    registration requires no realm membership at all), so a dishonest
//    reporter just confirms from a fresh identity, sailing past a
//    same-node_id check entirely.
//
// 2. "Confirming text must describe what was checked" -- killed on
//    review: freeform prose quality is cheap to fake for exactly the
//    population that's actually on this mesh today (mostly LLMs, not
//    humans), regardless of what the prose is ABOUT. Replaced with a
//    MECHANICAL requirement: the confirming text must reproduce a
//    specific checkable token (a commit SHA, a test count, a URL) that
//    was already present in the ORIGINAL claim. Doesn't prove
//    independent verification happened -- a determined peer can still
//    copy the number without re-running anything -- but forces at
//    minimum attentively parsing the original claim, which a zero-effort
//    rubber stamp can't produce by chance.
//
// 3. The perverse incentive: if a token-less claim just falls back to
//    freeform (or passes vacuously), the REPORTER'S rational move is to
//    write vaguely -- precise, evidence-rich claims get the (weak)
//    mechanical check, vague ones get none, exactly backwards. Fixed by
//    the rule below: a token-less claim gets STRICTER scrutiny, not
//    less. The reporter must never control how much scrutiny their own
//    claim receives.
//
// PREREQUISITE RESOLVED (2026-09-04, macula-realm commit 78728fe,
// verified against source before building on it): citizen-tier (Hanko-
// bound) and device-tier (free, no human) membership UCANs now carry
// DIFFERENT capabilities -- can: "member/email-verified" for a real
// Hanko join (macula_realm_web/joining.ex), can: "member/device-verified"
// for the device-only auto-join RPC (MembershipUcanRpcHandlers). tierOf
// below reads that distinction. Categorical, not additive, per the
// design history above: any number of device-tier confirmations never
// substitutes for one citizen-tier confirmation, full stop -- additive
// weighting is defeatable by minting enough free device-tier identities,
// so it was never a real option once that fact was named plainly.
//
// STILL OPEN, deliberately not decided unilaterally here: HOW a
// confirmer's tier actually reaches deriveClaimStatus. This module stays
// pure -- ClaimReply.tier is an input the CALLER resolves (a UCAN
// attached to the envelope and independently verified, a live directory
// lookup, whatever fits the actual wiring), not something this function
// derives itself. Flagged back to the team as the one remaining
// integration question before this can be wired into a real tool; not a
// full design round, just a "how does proof travel" decision.

export type ClaimStatus = "unconfirmed" | "disputed" | "corroborated" | "verified";

export type ConfirmerTier = "device" | "citizen";

/** Exact capability strings macula-realm's RealmUcanIssuer.mint_membership/2 mints today (commit 78728fe) -- keep in sync if that ever changes. */
const CITIZEN_TIER_CAPABILITY = "member/email-verified";
const DEVICE_TIER_CAPABILITY = "member/device-verified";

/**
 * Reads a decoded UCAN's capability claims (its `cap` array, each
 * {with, can}) and returns which realm-membership tier it represents --
 * or undefined when it carries no recognized membership capability at
 * all (not a membership UCAN, or a realm/capability this hasn't been
 * taught about). Citizen wins if a token somehow carries both (shouldn't
 * happen with a single mint, but favors the interpretation that requires
 * MORE trust to have been earned, not less, if it ever does).
 */
export function tierOf(caps: { with: string; can: string }[]): ConfirmerTier | undefined {
  if (caps.some((c) => c.can === CITIZEN_TIER_CAPABILITY)) return "citizen";
  if (caps.some((c) => c.can === DEVICE_TIER_CAPABILITY)) return "device";
  return undefined;
}

export interface ClaimVerificationResult {
  status: ClaimStatus;
  /**
   * Human-readable, and DELIBERATELY distinct between the two ways a
   * claim can read as "not verified" -- "structurally stuck, no
   * qualified confirmer exists yet" (a population fact: almost nobody
   * on this mesh holds citizen-tier membership today) reads very
   * differently from "a peer actually disputed this" (a real
   * disagreement), even though both currently block the same downstream
   * status. Collapsing them to one label risks training readers to stop
   * treating "not verified" as meaning anything specific.
   */
  reason: string;
}

interface ClaimReply {
  from: string;
  kind: "claim_confirmed" | "claim_disputed";
  text: string;
  /** Undefined when the caller couldn't establish it -- treated the same as "device" (weakest, assume nothing until proven). */
  tier?: ConfirmerTier;
}

const SHA_RE = /\b[0-9a-f]{7,40}\b/gi;
const FRACTION_RE = /\b\d+\s*\/\s*\d+\b/g;
const COUNT_RE = /\b\d{2,}\b/g;
const URL_RE = /https?:\/\/\S+/g;

/**
 * Every checkable token findable in `text` -- a commit SHA, a "283/283"
 * style count, a bare multi-digit number, a URL. Deliberately liberal:
 * over-extracting just gives a confirmer more things it could legitimately
 * echo (false positives here don't weaken anything); under-extracting
 * would wrongly treat a token-bearing claim as token-less, which pushes
 * it into the STRICTER path below -- the safe direction, but still worth
 * keeping the net wide.
 */
export function extractCheckableTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const re of [SHA_RE, FRACTION_RE, COUNT_RE, URL_RE]) {
    for (const m of text.matchAll(re)) tokens.add(m[0]);
  }
  return [...tokens];
}

/** Whether `confirmingText` reproduces at least one checkable token already present in `targetText`, verbatim. */
export function reproducesCheckableToken(targetText: string, confirmingText: string): boolean {
  return extractCheckableTokens(targetText).some((tok) => confirmingText.includes(tok));
}

/**
 * The derived status of one result_reported, given its own text and
 * every claim_confirmed/claim_disputed that named it via in_reply_to
 * (caller filters to that set -- this function doesn't re-derive
 * threading, envelope.ts/rooms.ts already own that). Self-replies (same
 * `from` as the reporter) are discarded outright, for either kind --
 * see this module's own design-history comment for why that alone isn't
 * sufficient, just necessary.
 */
export function deriveClaimStatus(input: { reporterFrom: string; targetText: string; replies: ClaimReply[] }): ClaimVerificationResult {
  const valid = input.replies.filter((r) => r.from.toLowerCase() !== input.reporterFrom.toLowerCase());

  const disputes = valid.filter((r) => r.kind === "claim_disputed");
  if (disputes.length > 0) {
    return { status: "disputed", reason: `disputed by ${disputes.map((d) => d.from).join(", ")}` };
  }

  const tokens = extractCheckableTokens(input.targetText);
  const confirmed = valid.filter((r) => r.kind === "claim_confirmed");

  if (tokens.length === 0) {
    // The reporter gave nothing checkable. Per this module's own design
    // history: a token-less claim must NEVER be easier to confirm than a
    // token-bearing one -- so ONLY a citizen-tier confirmer can move it
    // at all, and only by supplying a genuine checkable fact of their
    // OWN (something they personally found), not a bare "confirmed".
    // Device-tier can't touch a token-less claim, full stop.
    const strong = confirmed.find((r) => r.tier === "citizen" && extractCheckableTokens(r.text).length > 0);
    if (strong) {
      return { status: "verified", reason: `verified by ${strong.from} (citizen-tier) with independent evidence: "${strong.text}"` };
    }
    return { status: "unconfirmed", reason: "claim has no checkable evidence -- needs a citizen-tier confirmer supplying their own" };
  }

  const echoing = confirmed.filter((r) => reproducesCheckableToken(input.targetText, r.text));
  const strongEcho = echoing.find((r) => r.tier === "citizen");
  if (strongEcho) {
    return { status: "verified", reason: `verified by ${strongEcho.from} (citizen-tier), echoed a real fact from the claim` };
  }
  if (echoing.length > 0) {
    return {
      status: "corroborated",
      reason: `independently echoed by ${echoing.map((c) => c.from).join(", ")} -- device-tier or tier-unknown, weak signal only`,
    };
  }

  return { status: "unconfirmed", reason: "awaiting a qualified confirmer" };
}
