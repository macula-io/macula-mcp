import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

// Boundary mock: begin() takes this node's id and its proof of key
// possession from the client layer (whose own suite checks the proof's
// byte layout); the realm's HTTP side is a scripted fake below.
const mocks = vi.hoisted(() => ({ selfNodeId: vi.fn(), proveKeyPossession: vi.fn() }));
vi.mock("./macula_ts_client.js", () => ({ selfNodeId: mocks.selfNodeId, proveKeyPossession: mocks.proveKeyPossession }));

import * as realm from "./realm.js";

const NODE = "4f769c4e76402f3a0114f00f81a6b255f8f3298a1a9029ea5cf8a25c1463d7a0";
let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "macula-mcp-realm-test-"));
  process.env.MACULA_MCP_REALM_DIR = dir;
  process.env.MACULA_MCP_REALM_URL = "https://realm.test/";
  realm.abandon();
});

afterEach(async () => {
  realm.abandon();
  delete process.env.MACULA_MCP_REALM_DIR;
  delete process.env.MACULA_MCP_REALM_URL;
  await rm(dir, { recursive: true, force: true });
});

describe("pure shapes", () => {
  // Found live 2026-09-05: the join-session route moved from macula.io to
  // realm.macula.io (its own app/domain since the 2026-08-30 split), and
  // this client's DEFAULT_PORTAL_URL/JOIN_PROOF_PROCEDURE were never
  // updated to follow -- every mesh_join_realm call 404'd in production.
  // Every other test in this file overrides MACULA_MCP_REALM_URL in
  // beforeEach and so never actually exercised the real default; check it
  // directly here, not through the URL-building logic alone, or a
  // regression back to the wrong host/procedure would pass silently again.
  it("the real default target is realm.macula.io, and the proof procedure matches macula-realm's own join_session_controller/joining.ex", () => {
    const previous = process.env.MACULA_MCP_REALM_URL;
    delete process.env.MACULA_MCP_REALM_URL;
    try {
      expect(realm.realmUrl()).toBe("https://realm.macula.io");
    } finally {
      if (previous !== undefined) process.env.MACULA_MCP_REALM_URL = previous;
    }
    expect(realm.DEFAULT_REALM_URL).toBe("https://realm.macula.io");
    expect(realm.JOIN_PROOF_PROCEDURE).toBe("macula_realm.join_session");
  });

  it("agentMri names this server and the identity's first bytes", () => {
    expect(realm.agentMri(NODE)).toBe("mri:agent:io.macula/anonymous/macula-mcp-4f769c4e");
  });

  it("joinRequest sends the key as carried (base64, as the realm decodes it), device_info (not agent_info -- see the field's own doc comment), and the proof", () => {
    const req = realm.joinRequest({ nodeId: NODE, proof: { public_key: "Y2FycmllZA==", timestamp: 7, signature: "ab" }, connectedVia: "opencode 1.18.25" });
    expect(req.public_key).toBe("Y2FycmllZA==");
    expect(req.agent_mri).toBe(realm.agentMri(NODE));
    expect(req.proof).toEqual({ timestamp: 7, signature: "ab" });
    expect(req.agent_info).toBeUndefined();
    const info = req.device_info as Record<string, unknown>;
    expect(typeof info.hostname).toBe("string");
    expect(info.client).toBe("opencode 1.18.25");
    expect(String(info.version)).toMatch(/^macula-mcp \d+\.\d+\.\d+/);
  });

  it("parseCreated accepts the realm's 201 and throws with the realm's error text otherwise", () => {
    expect(realm.parseCreated(201, { session_id: "s1", join_url: "https://realm.test/join/s1", expires_at: "2026-09-02T14:00:00Z" })).toEqual({
      session_id: "s1",
      join_url: "https://realm.test/join/s1",
      expires_at: "2026-09-02T14:00:00Z",
    });
    expect(() => realm.parseCreated(400, { error: "invalid_public_key_size" })).toThrow(/invalid_public_key_size/);
  });

  it("parseSessionStatus maps pending, confirmed, expired (410 or body) and anything else to error", () => {
    expect(realm.parseSessionStatus(200, { status: "pending", expires_at: "x" })).toEqual({ status: "pending", expires_at: "x" });
    expect(realm.parseSessionStatus(200, { status: "confirmed", refresh_token: "mrt_1", org_identity: "mri:org:io.macula/raf", cert_pem: "PEM", oauth_account: "a@b", oauth_provider: "hanko" })).toEqual({
      status: "confirmed",
      refresh_token: "mrt_1",
      org_identity: "mri:org:io.macula/raf",
      cert_pem: "PEM",
      oauth_account: "a@b",
      oauth_provider: "hanko",
      citizen_did: undefined,
      ucan: undefined,
    });
    expect(realm.parseSessionStatus(410, { error: "session_expired" })).toEqual({ status: "expired" });
    expect(realm.parseSessionStatus(200, { error: "session_expired" })).toEqual({ status: "expired" });
    expect(realm.parseSessionStatus(404, { error: "session_not_found" }).status).toBe("error");
  });

  it("parseSessionStatus picks up citizen_did/ucan when the realm sends them", () => {
    const confirmed = realm.parseSessionStatus(200, {
      status: "confirmed",
      refresh_token: "mrt_1",
      org_identity: "mri:org:io.macula/raf",
      citizen_did: NODE,
      ucan: "eyJ.fake.token",
    });
    expect(confirmed).toMatchObject({ citizen_did: NODE, ucan: "eyJ.fake.token" });
  });

  it("handleOf takes the last segment of an org identity", () => {
    expect(realm.handleOf("mri:org:io.macula/rgfaber")).toBe("rgfaber");
    expect(realm.handleOf(undefined)).toBeUndefined();
    expect(realm.handleOf("")).toBeUndefined();
  });

  it("renders the join URL as a terminal QR and as a PNG", async () => {
    const ascii = await realm.qrTerminal("https://realm.test/join/s1");
    expect(ascii.split("\n").length).toBeGreaterThan(8);
    // plain glyphs only: no ANSI escapes, nothing but blocks, half-blocks and spaces
    expect(ascii).not.toMatch(/\u001b\[/);
    expect(ascii.replace(/[\u2588\u2580\u2584 \n]/g, "")).toBe("");
    const png = Buffer.from(await realm.qrPngBase64("https://realm.test/join/s1"), "base64");
    expect(png.subarray(0, 4).toString("hex")).toBe("89504e47");
  });
});

describe("credential store", () => {
  it("round-trips a credential, 0600, keyed by (node_id, realm), and reports it as joined", async () => {
    const path = realm.storeCredential({
      node_id: NODE,
      portal: "https://realm.test",
      org_identity: "mri:org:io.macula/rgfaber",
      account: "a@b",
      cert_pem: "PEM",
      refresh_token: "mrt_1",
      joined_at: "2026-09-02T14:00:00Z",
      citizen_did: NODE,
      ucan: "eyJ.fake.token",
      tier: "citizen",
    });
    // Nested (node_id, realm) layout, not the old flat <node_id>.json --
    // see credentialPath's own doc for why: a credential now belongs to
    // one (identity, realm) pair, not just an identity.
    expect(path).toBe(join(dir, NODE, "io.macula.json"));
    if (process.platform !== "win32") expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
    expect(realm.loadCredential(NODE)?.refresh_token).toBe("mrt_1");
    expect(realm.orgHandle(NODE)).toBe("rgfaber");
    const s = realm.status(NODE);
    expect(s.joined).toBe(true);
    expect(s.handle).toBe("rgfaber");
    expect(s.credential_path).toBe(path);
    expect(s.citizen_did).toBe(NODE);
    expect(s.has_ucan).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8")).cert_pem).toBe("PEM");
    // the raw UCAN is never echoed back through status() -- it's a bearer
    // credential, only has_ucan (a boolean) is
    expect((s as Record<string, unknown>).ucan).toBeUndefined();
  });

  it("a credential from an older/unconfigured realm (no citizen_did/ucan) still reports joined, just without them", async () => {
    realm.storeCredential({
      node_id: NODE,
      portal: "https://realm.test",
      org_identity: "mri:org:io.macula/rgfaber",
      refresh_token: "mrt_1",
      joined_at: "2026-09-02T14:00:00Z",
      tier: "citizen",
    });
    const s = realm.status(NODE);
    expect(s.joined).toBe(true);
    expect(s.citizen_did).toBeUndefined();
    expect(s.has_ucan).toBe(false);
  });

  it("an absent or unreadable credential is simply not joined", () => {
    expect(realm.loadCredential(NODE)).toBeUndefined();
    expect(realm.status(NODE)).toEqual({ portal: "https://realm.test", joined: false });
    expect(realm.status(undefined).joined).toBe(false);
  });

  it("a device-tier credential (device_membership.ts's auto-join) round-trips its tier through status()", () => {
    realm.storeCredential({
      node_id: NODE,
      portal: "io.macula",
      org_identity: "mri:org:io.macula",
      refresh_token: "",
      joined_at: "2026-09-04T00:00:00Z",
      citizen_did: NODE,
      ucan: "eyJ.device.token",
      tier: "device",
    });
    expect(realm.status(NODE).tier).toBe("device");
  });

  it("stores and loads independently under different realms for the same identity -- one does not clobber or leak into the other", () => {
    realm.storeCredential(
      { node_id: NODE, portal: "https://realm.macula.io", org_identity: "mri:org:io.macula/rgfaber", refresh_token: "mrt_macula", joined_at: "2026-09-08T00:00:00Z", tier: "citizen" },
      "io.macula",
    );
    realm.storeCredential(
      { node_id: NODE, portal: "https://realm.beam-campus.net", org_identity: "mri:org:net.beam-campus/rgfaber", refresh_token: "mrt_beamcampus", joined_at: "2026-09-08T00:01:00Z", tier: "citizen" },
      "net.beam-campus",
    );
    expect(realm.loadCredential(NODE, "io.macula")?.refresh_token).toBe("mrt_macula");
    expect(realm.loadCredential(NODE, "net.beam-campus")?.refresh_token).toBe("mrt_beamcampus");
    // omitting realmName defaults to io.macula, same as every pre-multi-realm caller already assumes
    expect(realm.loadCredential(NODE)?.refresh_token).toBe("mrt_macula");
  });

  it("listCredentials returns every realm a node_id has a confirmed membership for, tagged by realm", () => {
    realm.storeCredential(
      { node_id: NODE, portal: "https://realm.beam-campus.net", org_identity: "mri:org:net.beam-campus/rgfaber", refresh_token: "mrt_beamcampus", joined_at: "2026-09-08T00:01:00Z", tier: "citizen" },
      "net.beam-campus",
    );
    realm.storeCredential(
      { node_id: NODE, portal: "https://realm.macula.io", org_identity: "mri:org:io.macula/rgfaber", refresh_token: "mrt_macula", joined_at: "2026-09-08T00:02:00Z", tier: "citizen" },
      "io.macula",
    );
    const byRealm = Object.fromEntries(realm.listCredentials(NODE).map((m) => [m.realm, m]));
    expect(Object.keys(byRealm).sort()).toEqual(["io.macula", "net.beam-campus"]);
    expect(byRealm["net.beam-campus"]?.refresh_token).toBe("mrt_beamcampus");
  });

  it("a stored file without a tier is not a credential this server wrote, and is not read as one", async () => {
    await mkdir(join(dir, NODE), { recursive: true });
    await writeFile(join(dir, NODE, "io.macula.json"), JSON.stringify({ node_id: NODE, org_identity: "mri:org:io.macula/x", refresh_token: "t" }), "utf8");
    expect(realm.loadCredential(NODE)).toBeUndefined();
  });
  it("listCredentials is empty, not an error, for an identity with no memberships at all", () => {
    expect(realm.listCredentials(NODE)).toEqual([]);
  });
});

describe("join flow against a fake realm", () => {
  const NODE = "5e".repeat(32);
  const PROOF = { public_key: Buffer.alloc(3118, 3).toString("base64"), timestamp: 0, signature: "cd".repeat(5139) };

  beforeEach(() => {
    mocks.selfNodeId.mockResolvedValue(NODE);
    mocks.proveKeyPossession.mockImplementation(async () => ({ ...PROOF, timestamp: Date.now() }));
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  function fakeRealm(script: Array<{ status: number; body: unknown }>) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: realm.FetchLike = async (url, init) => {
      calls.push({ url, init });
      const next = script.shift() ?? { status: 500, body: { error: "script exhausted" } };
      return { status: next.status, json: async () => next.body };
    };
    return { fetchImpl, calls };
  }

  it("begin creates the session with a proof of key possession bound to the join procedure, and returns link + QR", async () => {
    const server = fakeRealm([{ status: 201, body: { session_id: "s1", join_url: "https://realm.test/join/s1", expires_at: "2999-01-01T00:00:00Z" } }]);
    const began = await realm.begin({ connectedVia: "opencode 1.18.25", fetchImpl: server.fetchImpl });
    expect(began.reused).toBe(false);
    expect(began.node_id).toBe(NODE);
    expect(began.join_url).toBe("https://realm.test/join/s1");
    expect(began.qr_terminal.length).toBeGreaterThan(0);
    expect(server.calls[0].url).toBe("https://realm.test/api/v1/join/sessions");
    const sent = JSON.parse(String(server.calls[0].init?.body));
    // The proof is fresh, bound to the join procedure, and carries the key
    // it proves: the realm derives the node_id from that key.
    expect(mocks.proveKeyPossession).toHaveBeenCalledWith(realm.JOIN_PROOF_PROCEDURE);
    expect(sent.public_key).toBe(PROOF.public_key);
    expect(sent.proof.signature).toBe(PROOF.signature);
    expect(Math.abs(Date.now() - sent.proof.timestamp)).toBeLessThan(5_000);
    expect(realm.status(NODE).pending?.session_id).toBe("s1");
    // Found live 2026-09-08: mesh://identity and mesh_hello's own result
    // both embed this exact status(), neither behind any tool allowlist
    // -- a pending join's session_id/join_url is a bearer link meant only
    // for the human about to scan/click it, so anything reached through
    // an incidental identity/hello check must never carry it, even
    // though the direct, human-requested channel (the default here,
    // asserted just above) still legitimately does.
    const redacted = realm.status(NODE, { redactPending: true });
    expect(redacted.pending?.session_id).toBeUndefined();
    expect(redacted.pending?.join_url).toBeUndefined();
    expect(redacted.pending?.expires_at).toBe("2999-01-01T00:00:00Z");
    // a second begin while pending reuses the same session rather than spamming the realm
    const again = await realm.begin({ fetchImpl: server.fetchImpl });
    expect(again.reused).toBe(true);
    expect(again.session_id).toBe("s1");
    expect(server.calls.length).toBe(1);
  });

  it("waitForOutcome stores the credential once the person confirms, including the membership UCAN", async () => {
    const server = fakeRealm([
      { status: 201, body: { session_id: "s2", join_url: "https://realm.test/join/s2", expires_at: "2999-01-01T00:00:00Z" } },
      { status: 200, body: { status: "pending", expires_at: "2999-01-01T00:00:00Z" } },
      {
        status: 200,
        body: {
          status: "confirmed",
          refresh_token: "mrt_2",
          org_identity: "mri:org:io.macula/rgfaber",
          cert_pem: "PEM",
          oauth_account: "a@b",
          oauth_provider: "hanko",
          citizen_did: NODE,
          ucan: "eyJ.fake.token",
        },
      },
    ]);
    await realm.begin({ fetchImpl: server.fetchImpl });
    const after = await realm.waitForOutcome(NODE, 30, server.fetchImpl);
    expect(after.joined).toBe(true);
    expect(after.org_identity).toBe("mri:org:io.macula/rgfaber");
    expect(after.citizen_did).toBe(NODE);
    expect(after.has_ucan).toBe(true);
    expect(after.tier).toBe("citizen");
    expect(realm.loadCredential(NODE)?.cert_pem).toBe("PEM");
    expect(realm.loadCredential(NODE)?.ucan).toBe("eyJ.fake.token");
    expect(realm.status(NODE).pending).toBeUndefined();
  });

  it("waitForOutcome against an older realm (no citizen_did/ucan in the confirm body) still joins cleanly", async () => {
    const server = fakeRealm([
      { status: 201, body: { session_id: "s2b", join_url: "https://realm.test/join/s2b", expires_at: "2999-01-01T00:00:00Z" } },
      { status: 200, body: { status: "confirmed", refresh_token: "mrt_2b", org_identity: "mri:org:io.macula/rgfaber" } },
    ]);
    await realm.begin({ fetchImpl: server.fetchImpl });
    const after = await realm.waitForOutcome(NODE, 30, server.fetchImpl);
    expect(after.joined).toBe(true);
    expect(after.has_ucan).toBe(false);
    expect(realm.loadCredential(NODE)?.ucan).toBeUndefined();
  });

  it("an expired session is reported, not silently retried forever", async () => {
    const server = fakeRealm([
      { status: 201, body: { session_id: "s3", join_url: "https://realm.test/join/s3", expires_at: "2999-01-01T00:00:00Z" } },
      { status: 410, body: { error: "session_expired" } },
    ]);
    await realm.begin({ fetchImpl: server.fetchImpl });
    const after = await realm.waitForOutcome(NODE, 5, server.fetchImpl);
    expect(after.joined).toBe(false);
    expect(after.pending).toBeUndefined();
    expect(after.error).toMatch(/expired/);
  });
});
