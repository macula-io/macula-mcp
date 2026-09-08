import { describe, expect, it } from "vitest";
import { realmSummary } from "./mesh_list_realms.js";
import type { RealmMembership } from "./realm.js";

describe("realmSummary", () => {
  it("carries the display fields but never a bearer credential (refresh_token/cert_pem)", () => {
    const membership: RealmMembership = {
      realm: "net.beam-campus",
      node_id: "n",
      portal: "https://realm.beam-campus.net",
      org_identity: "mri:org:net.beam-campus/rgfaber",
      refresh_token: "mrt_secret",
      cert_pem: "PEM_SECRET",
      joined_at: "2026-09-08T00:00:00Z",
      citizen_did: "n",
      ucan: "eyJ.fake.token",
      tier: "citizen",
    };
    const got = realmSummary(membership);
    expect(got).toEqual({
      realm: "net.beam-campus",
      org_identity: "mri:org:net.beam-campus/rgfaber",
      handle: "rgfaber",
      account: undefined,
      joined_at: "2026-09-08T00:00:00Z",
      tier: "citizen",
      has_ucan: true,
    });
    expect(JSON.stringify(got)).not.toContain("mrt_secret");
    expect(JSON.stringify(got)).not.toContain("PEM_SECRET");
    // and never the raw UCAN either, only whether one exists -- same
    // posture as mesh_identity.ts's has_ucan boolean.
    expect(JSON.stringify(got)).not.toContain("eyJ.fake.token");
  });

  it("has_ucan is false, not absent, when there's genuinely no UCAN (an older/unconfigured realm)", () => {
    const membership: RealmMembership = {
      realm: "io.macula",
      node_id: "n",
      portal: "https://realm.macula.io",
      org_identity: "mri:org:io.macula/rgfaber",
      refresh_token: "mrt_1",
      joined_at: "2026-09-08T00:00:00Z",
    };
    expect(realmSummary(membership).has_ucan).toBe(false);
  });
});
