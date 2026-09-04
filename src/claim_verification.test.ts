import { describe, expect, it } from "vitest";
import { deriveClaimStatus, extractCheckableTokens, reproducesCheckableToken, tierOf } from "./claim_verification.js";

const REPORTER = "a".repeat(64);
const CONFIRMER = "b".repeat(64);
const OTHER_CONFIRMER = "c".repeat(64);

describe("tierOf", () => {
  it("citizen-tier capability -> citizen", () => {
    expect(tierOf([{ with: "mri:realm:io.macula", can: "member/email-verified" }])).toBe("citizen");
  });

  it("device-tier capability -> device", () => {
    expect(tierOf([{ with: "mri:realm:io.macula", can: "member/device-verified" }])).toBe("device");
  });

  it("unrecognized capability -> undefined", () => {
    expect(tierOf([{ with: "mri:realm:io.macula", can: "member/something-else" }])).toBeUndefined();
  });

  it("no capabilities at all -> undefined", () => {
    expect(tierOf([])).toBeUndefined();
  });

  it("citizen wins if a token somehow carries both -- favors requiring more trust, not less", () => {
    expect(
      tierOf([
        { with: "mri:realm:io.macula", can: "member/device-verified" },
        { with: "mri:realm:io.macula", can: "member/email-verified" },
      ]),
    ).toBe("citizen");
  });
});

describe("extractCheckableTokens", () => {
  it("finds a commit SHA", () => {
    expect(extractCheckableTokens("fixed in 8cdf17e, see the diff")).toContain("8cdf17e");
  });

  it("finds a test-count fraction", () => {
    expect(extractCheckableTokens("full suite 283/283 passes")).toContain("283/283");
  });

  it("finds a bare multi-digit number", () => {
    expect(extractCheckableTokens("ran it 42 times")).toContain("42");
  });

  it("finds a URL", () => {
    expect(extractCheckableTokens("see https://github.com/macula-io/macula-mcp/actions/runs/33891770161")).toContain(
      "https://github.com/macula-io/macula-mcp/actions/runs/33891770161",
    );
  });

  it("returns nothing for genuinely vague prose", () => {
    expect(extractCheckableTokens("done, it works now")).toEqual([]);
  });
});

describe("reproducesCheckableToken", () => {
  it("true when the confirming text echoes a real token from the target", () => {
    expect(reproducesCheckableToken("fixed in 8cdf17e", "verified 8cdf17e myself, holds")).toBe(true);
  });

  it("false when the confirming text has no token from the target at all", () => {
    expect(reproducesCheckableToken("fixed in 8cdf17e", "looks good to me")).toBe(false);
  });

  it("false when the confirming text has A token, just not one from the target", () => {
    expect(reproducesCheckableToken("fixed in 8cdf17e", "checked commit deadbeef, holds")).toBe(false);
  });
});

describe("deriveClaimStatus", () => {
  it("unconfirmed with no replies at all", () => {
    const r = deriveClaimStatus({ reporterFrom: REPORTER, targetText: "fixed in 8cdf17e", replies: [] });
    expect(r.status).toBe("unconfirmed");
    expect(r.reason).toBe("awaiting a qualified confirmer");
  });

  it("corroborated (not verified) when a device-tier peer echoes a real token from the claim -- weak signal, tier known but insufficient", () => {
    const r = deriveClaimStatus({
      reporterFrom: REPORTER,
      targetText: "fixed in 8cdf17e, full suite 283/283",
      replies: [{ from: CONFIRMER, kind: "claim_confirmed", text: "confirmed, 283/283 holds for me too", tier: "device" }],
    });
    expect(r.status).toBe("corroborated");
    expect(r.reason).toContain(CONFIRMER);
  });

  it("corroborated (not verified) when tier is unknown -- unknown is treated the same as device, never upgraded to verified by default", () => {
    const r = deriveClaimStatus({
      reporterFrom: REPORTER,
      targetText: "fixed in 8cdf17e, full suite 283/283",
      replies: [{ from: CONFIRMER, kind: "claim_confirmed", text: "confirmed, 283/283 holds for me too" }],
    });
    expect(r.status).toBe("corroborated");
  });

  it("verified when a CITIZEN-tier peer echoes a real token from a token-bearing claim", () => {
    const r = deriveClaimStatus({
      reporterFrom: REPORTER,
      targetText: "fixed in 8cdf17e, full suite 283/283",
      replies: [{ from: CONFIRMER, kind: "claim_confirmed", text: "verified, 283/283 holds", tier: "citizen" }],
    });
    expect(r.status).toBe("verified");
    expect(r.reason).toContain(CONFIRMER);
  });

  it("a token-less claim is NEVER confirmable by a device-tier peer, no matter what they write -- device-tier can't touch it at all", () => {
    const r = deriveClaimStatus({
      reporterFrom: REPORTER,
      targetText: "done, it works now",
      replies: [{ from: CONFIRMER, kind: "claim_confirmed", text: "verified independently, ran it myself, saw 999 pass", tier: "device" }],
    });
    expect(r.status).toBe("unconfirmed");
  });

  it("a token-less claim stays unconfirmed even from a citizen-tier peer if THEY don't supply their own checkable fact -- a bare rubber stamp still doesn't count, even from the strong tier", () => {
    const r = deriveClaimStatus({
      reporterFrom: REPORTER,
      targetText: "done, it works now",
      replies: [{ from: CONFIRMER, kind: "claim_confirmed", text: "confirmed, looks right", tier: "citizen" }],
    });
    expect(r.status).toBe("unconfirmed");
  });

  it("a token-less claim CAN reach verified, but only via a citizen-tier peer supplying genuinely new evidence of their own", () => {
    const r = deriveClaimStatus({
      reporterFrom: REPORTER,
      targetText: "done, it works now",
      replies: [{ from: CONFIRMER, kind: "claim_confirmed", text: "verified independently: ran the full suite myself, 312/312 pass", tier: "citizen" }],
    });
    expect(r.status).toBe("verified");
    expect(r.reason).toContain("independent evidence");
  });

  it("unconfirmed when a confirming reply exists but doesn't reproduce any real token -- a bare rubber stamp", () => {
    const r = deriveClaimStatus({
      reporterFrom: REPORTER,
      targetText: "fixed in 8cdf17e, full suite 283/283",
      replies: [{ from: CONFIRMER, kind: "claim_confirmed", text: "looks good, trust it" }],
    });
    expect(r.status).toBe("unconfirmed");
  });

  it("self-confirmation is discarded -- reporter confirming their own claim counts for nothing", () => {
    const r = deriveClaimStatus({
      reporterFrom: REPORTER,
      targetText: "fixed in 8cdf17e",
      replies: [{ from: REPORTER, kind: "claim_confirmed", text: "confirmed 8cdf17e, definitely holds" }],
    });
    expect(r.status).toBe("unconfirmed");
    expect(r.reason).toBe("awaiting a qualified confirmer");
  });

  it("self-dispute is ALSO discarded, same rule for both kinds", () => {
    const r = deriveClaimStatus({
      reporterFrom: REPORTER,
      targetText: "fixed in 8cdf17e",
      replies: [{ from: REPORTER, kind: "claim_disputed", text: "actually this is wrong" }],
    });
    expect(r.status).toBe("unconfirmed");
  });

  it("THE anti-perverse-incentive case: a token-less (vague) claim is NEVER easier to confirm than a token-bearing one -- stays unconfirmed even with a real confirming reply", () => {
    const r = deriveClaimStatus({
      reporterFrom: REPORTER,
      targetText: "done, it works now",
      replies: [{ from: CONFIRMER, kind: "claim_confirmed", text: "confirmed, looks right to me" }],
    });
    expect(r.status).toBe("unconfirmed");
    expect(r.reason).toContain("no checkable evidence");
  });

  it("dispute wins over a confirmation from someone else", () => {
    const r = deriveClaimStatus({
      reporterFrom: REPORTER,
      targetText: "fixed in 8cdf17e, 283/283",
      replies: [
        { from: CONFIRMER, kind: "claim_confirmed", text: "confirmed 8cdf17e" },
        { from: OTHER_CONFIRMER, kind: "claim_disputed", text: "re-ran it, only 280/283 pass for me" },
      ],
    });
    expect(r.status).toBe("disputed");
    expect(r.reason).toContain(OTHER_CONFIRMER);
  });

  it("the two 'not verified' reasons read distinctly -- disputed vs. structurally-stuck aren't the same label", () => {
    const disputed = deriveClaimStatus({
      reporterFrom: REPORTER,
      targetText: "fixed in 8cdf17e",
      replies: [{ from: CONFIRMER, kind: "claim_disputed", text: "does not hold, 8cdf17e reverts the fix" }],
    });
    const stuck = deriveClaimStatus({ reporterFrom: REPORTER, targetText: "fixed in 8cdf17e", replies: [] });
    expect(disputed.reason).not.toBe(stuck.reason);
    expect(disputed.status).toBe("disputed");
    expect(stuck.status).toBe("unconfirmed");
  });

  it("case-insensitive self-reply detection (node ids travel as hex, case shouldn't matter)", () => {
    const r = deriveClaimStatus({
      reporterFrom: REPORTER,
      targetText: "fixed in 8cdf17e",
      replies: [{ from: REPORTER.toUpperCase(), kind: "claim_confirmed", text: "confirmed 8cdf17e" }],
    });
    expect(r.status).toBe("unconfirmed");
  });
});
