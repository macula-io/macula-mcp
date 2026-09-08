import { describe, expect, it } from "vitest";
import { parseRealmName, realmBaseURL } from "./realm_name.js";
import { DEFAULT_REALM_URL } from "./realm.js";

describe("parseRealmName -- accepts", () => {
  it("the project's own two canonical examples", () => {
    expect(parseRealmName("io.macula")).toEqual({ ok: true, canonical: "io.macula", labels: ["io", "macula"] });
    expect(parseRealmName("net.beam-campus")).toEqual({ ok: true, canonical: "net.beam-campus", labels: ["net", "beam-campus"] });
  });

  it("a sub-realm as a third label", () => {
    expect(parseRealmName("net.beam-campus.sales")).toEqual({
      ok: true,
      canonical: "net.beam-campus.sales",
      labels: ["net", "beam-campus", "sales"],
    });
  });

  it("canonicalizes case, trims surrounding whitespace, and a label with internal digits/hyphens", () => {
    expect(parseRealmName(" IO.MACULA ")).toEqual({ ok: true, canonical: "io.macula", labels: ["io", "macula"] });
    expect(parseRealmName("com.example-2").ok).toBe(true);
  });
});

describe("parseRealmName -- rejects, each for the specific reason found live (Fable, 2026-09-08)", () => {
  it("a single label -- realm.io would be a domain anyone can register", () => {
    const got = parseRealmName("io");
    expect(got.ok).toBe(false);
    expect((got as { reason: string }).reason).toMatch(/at least 2 labels/);
  });

  it("non-ASCII, including a Cyrillic lookalike of 'macula' -- a real, differently-owned domain, not the intended one", () => {
    const homograph = "io.mаcula"; // Cyrillic а (U+0430), not Latin a
    const got = parseRealmName(homograph);
    expect(got.ok).toBe(false);
    expect((got as { reason: string }).reason).toMatch(/ASCII/);
  });

  // The Cyrillic test above doesn't actually prove the ASCII check has to
  // run BEFORE lowercasing -- the label regex alone already rejects
  // Cyrillic characters (they're simply not in [a-z0-9]), ASCII check or
  // not. This one does: U+212A KELVIN SIGN renders as "K" and
  // JavaScript's String.prototype.toLowerCase() folds it to plain ASCII
  // "k" (a real, documented Unicode case-folding quirk, verified
  // directly in this runtime before writing this test, not assumed) --
  // so a version of this function that lowercased FIRST and checked
  // ASCII-ness AFTER would let "io.mKacula" through as if it were
  // the real "io.mkacula" domain, when what was actually typed contained
  // a non-ASCII lookalike a browser or terminal renders identically to
  // the letter it folds to.
  it("a character that folds TO ascii under toLowerCase (Kelvin sign, U+212A) is still caught -- proves the ASCII check runs before folding, not after", () => {
    const kelvin = "io.mKacula";
    expect(kelvin.toLowerCase()).toBe("io.mkacula"); // sanity: confirms the fold this test depends on actually happens in this runtime
    const got = parseRealmName(kelvin);
    expect(got.ok).toBe(false);
    expect((got as { reason: string }).reason).toMatch(/ASCII/);
  });

  it("a label starting xn-- -- punycode is the one lookalike class that survives a naive ASCII-letters filter", () => {
    const got = parseRealmName("io.xn--mcula-xxa"); // a real punycode-shaped label
    expect(got.ok).toBe(false);
    expect((got as { reason: string }).reason).toMatch(/punycode/);
  });

  it("empty, leading, trailing, or doubled dots", () => {
    for (const bad of ["", "   ", ".io.macula", "io.macula.", "io..macula"]) {
      expect(parseRealmName(bad).ok).toBe(false);
    }
  });

  it("a label starting or ending with a hyphen", () => {
    expect(parseRealmName("io.-macula").ok).toBe(false);
    expect(parseRealmName("io.macula-").ok).toBe(false);
  });

  it("over the 253-char total length", () => {
    const huge = "io." + "a".repeat(260);
    const got = parseRealmName(huge);
    expect(got.ok).toBe(false);
    expect((got as { reason: string }).reason).toMatch(/253/);
  });

  it("an over-length single label (DNS's own 63-char limit per label)", () => {
    const got = parseRealmName("io." + "a".repeat(64));
    expect(got.ok).toBe(false);
  });
});

describe("realmBaseURL", () => {
  it("io.macula resolves to exactly today's real default -- not a coincidence, the same formula", () => {
    expect(realmBaseURL("io.macula")).toBe(DEFAULT_REALM_URL);
  });

  it("a sub-realm becomes a subdomain with zero special-casing -- reversing ALL labels already produces the right shape", () => {
    expect(realmBaseURL("net.beam-campus.sales")).toBe("https://realm.sales.beam-campus.net");
  });

  it("a two-label realm reverses the same way", () => {
    expect(realmBaseURL("net.beam-campus")).toBe("https://realm.beam-campus.net");
  });
});
