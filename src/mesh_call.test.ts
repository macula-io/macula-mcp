import { describe, expect, it } from "vitest";
import { MaculaCliError, splitRealmPrefix } from "./macula_cli.js";

// The io.macula realm, sha256("io.macula"), as a DHT listing prints it.
const REALM = "ABB81B5A614B63551B400B810648C0C8A78EFAD845442630C94B46CC95D2FCD1";

describe("splitRealmPrefix", () => {
  it("leaves a bare procedure and its realm alone", () => {
    expect(splitRealmPrefix("hecate-rag.search_chunks_semantic", REALM)).toEqual({
      procedure: "hecate-rag.search_chunks_semantic",
      realm: REALM,
    });
    expect(splitRealmPrefix("rl_probe.echo")).toEqual({ procedure: "rl_probe.echo", realm: undefined });
  });

  it("splits the realm-prefixed form a procedure_advertisement prints", () => {
    expect(splitRealmPrefix(`${REALM}/hecate-rag.search_chunks_semantic`)).toEqual({
      procedure: "hecate-rag.search_chunks_semantic",
      realm: REALM,
    });
  });

  it("keeps the org segment: the registry holds _/name as its own entry", () => {
    expect(splitRealmPrefix(`${REALM}/_/hecate_agora.get_posts_page`)).toEqual({
      procedure: "_/hecate_agora.get_posts_page",
      realm: REALM,
    });
  });

  it("accepts a realm passed alongside when it agrees, whatever the case", () => {
    expect(splitRealmPrefix(`${REALM}/hecate-rag.answer_query`, REALM.toLowerCase())).toEqual({
      procedure: "hecate-rag.answer_query",
      realm: REALM,
    });
  });

  it("refuses a realm passed alongside that disagrees with the prefix", () => {
    const other = "0".repeat(64);
    expect(() => splitRealmPrefix(`${REALM}/hecate-rag.answer_query`, other)).toThrow(MaculaCliError);
    expect(() => splitRealmPrefix(`${REALM}/hecate-rag.answer_query`, other)).toThrow(/hecate-rag\.answer_query/);
  });

  it("does not mistake a short hex-looking prefix for a realm", () => {
    expect(splitRealmPrefix("abcd/thing")).toEqual({ procedure: "abcd/thing", realm: undefined });
  });
});
