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
// KNOWN, CURRENTLY UNRESOLVED PREREQUISITE (2026-09-04): the design
// calls for citizen-tier (Hanko-bound) realm membership to matter more
// than device-tier (free, no human) when weighing a confirmation --
// categorically, not additively, since device-tier is free to mint in
// unlimited quantity and any finite additive threshold is therefore
// clearable by minting enough of them. That check is NOT implemented
// here: macula-realm's RealmUcanIssuer.mint_membership/2 currently
// issues the IDENTICAL capability (can: "member/email-verified")
// whether the caller went through the real Hanko join flow or the
// device-only auto-join RPC -- there is no wire-level way to tell the
// two apart yet, confirmed by reading both call sites
// (macula_realm_web/joining.ex and MembershipUcanRpcHandlers). Until
// that lands, deriveClaimStatus below deliberately never returns
// "verified" -- only "corroborated" (a token-matching echo, tier
// unverifiable) at best. This is an honest cap, not a placeholder: every
// piece here is fully functional, it just cannot reach the strong
// outcome yet because the prerequisite it depends on doesn't exist on
// the wire. Revisit once macula-realm's issuer distinguishes tiers.

export type ClaimStatus = "unconfirmed" | "disputed" | "corroborated";

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
  if (tokens.length === 0) {
    // The reporter gave nothing checkable. Per this module's own design
    // history: a token-less claim must NEVER be easier to confirm than a
    // token-bearing one. The intended bar is "citizen-tier confirmer
    // supplying genuine new evidence" -- since tier isn't checkable yet
    // (see the prerequisite note above this function), NOTHING can
    // currently clear that bar, which is stricter than intended but the
    // only honest option: silently accepting any confirmation here would
    // reopen exactly the perverse incentive round 3 closed.
    return { status: "unconfirmed", reason: "claim has no checkable evidence -- needs a citizen-tier confirmer, not verifiable yet (see known limitation)" };
  }

  const confirmations = valid.filter((r) => r.kind === "claim_confirmed" && reproducesCheckableToken(input.targetText, r.text));
  if (confirmations.length > 0) {
    return {
      status: "corroborated",
      reason: `independently echoed by ${confirmations.map((c) => c.from).join(", ")} -- tier not verifiable yet, weak signal only`,
    };
  }

  return { status: "unconfirmed", reason: "awaiting a qualified confirmer" };
}
