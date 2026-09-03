import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// begin()/waitForOutcome() talk to macula-cli for the identity and the
// proof; both are the seam every other suite mocks the same way.
vi.mock("./macula_cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./macula_cli.js")>();
  return {
    ...actual,
    identity: async () => ({ node_id: NODE, path: "/tmp/fake-identity.seed", generated: false }),
    identitySign: async ({ procedure }: { procedure: string }) => ({ node_id: NODE, timestamp: 1788352709318, signature: `sig-for-${procedure}` }),
  };
});

import * as realm from "./realm.js";

const NODE = "4f769c4e76402f3a0114f00f81a6b255f8f3298a1a9029ea5cf8a25c1463d7a0";
let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "macula-mcp-realm-test-"));
  process.env.MACULA_MCP_REALM_DIR = dir;
  process.env.MACULA_MCP_PORTAL_URL = "https://portal.test/";
  realm.abandon();
});

afterEach(async () => {
  realm.abandon();
  delete process.env.MACULA_MCP_REALM_DIR;
  delete process.env.MACULA_MCP_PORTAL_URL;
  await rm(dir, { recursive: true, force: true });
});

describe("pure shapes", () => {
  it("agentMri names this server and the identity's first bytes", () => {
    expect(realm.agentMri(NODE)).toBe("mri:agent:io.macula/anonymous/macula-mcp-4f769c4e");
  });

  it("joinRequest sends the key base64 (as the portal decodes it), the agent info, and the proof", () => {
    const req = realm.joinRequest({ nodeId: NODE, proof: { timestamp: 7, signature: "ab" }, connectedVia: "opencode 1.18.25" });
    expect(Buffer.from(req.public_key as string, "base64").toString("hex")).toBe(NODE);
    expect(req.agent_mri).toBe(realm.agentMri(NODE));
    expect(req.proof).toEqual({ timestamp: 7, signature: "ab" });
    const info = req.agent_info as Record<string, unknown>;
    expect(typeof info.hostname).toBe("string");
    expect(info.client).toBe("opencode 1.18.25");
    expect(String(info.version)).toMatch(/^macula-mcp \d+\.\d+\.\d+/);
  });

  it("parseCreated accepts the portal's 201 and throws with the portal's error text otherwise", () => {
    expect(realm.parseCreated(201, { session_id: "s1", join_url: "https://portal.test/join/s1", expires_at: "2026-09-02T14:00:00Z" })).toEqual({
      session_id: "s1",
      join_url: "https://portal.test/join/s1",
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

  it("parseSessionStatus picks up citizen_did/ucan when the portal sends them", () => {
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
    const ascii = await realm.qrTerminal("https://portal.test/join/s1");
    expect(ascii.split("\n").length).toBeGreaterThan(8);
    // plain glyphs only: no ANSI escapes, nothing but blocks, half-blocks and spaces
    expect(ascii).not.toMatch(/\u001b\[/);
    expect(ascii.replace(/[\u2588\u2580\u2584 \n]/g, "")).toBe("");
    const png = Buffer.from(await realm.qrPngBase64("https://portal.test/join/s1"), "base64");
    expect(png.subarray(0, 4).toString("hex")).toBe("89504e47");
  });
});

describe("credential store", () => {
  it("round-trips a credential, 0600, keyed by node_id, and reports it as joined", async () => {
    const path = realm.storeCredential({
      node_id: NODE,
      portal: "https://portal.test",
      org_identity: "mri:org:io.macula/rgfaber",
      account: "a@b",
      cert_pem: "PEM",
      refresh_token: "mrt_1",
      joined_at: "2026-09-02T14:00:00Z",
      citizen_did: NODE,
      ucan: "eyJ.fake.token",
    });
    expect(path).toBe(join(dir, `${NODE}.json`));
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

  it("a credential from an older/unconfigured portal (no citizen_did/ucan) still reports joined, just without them", async () => {
    realm.storeCredential({
      node_id: NODE,
      portal: "https://portal.test",
      org_identity: "mri:org:io.macula/rgfaber",
      refresh_token: "mrt_1",
      joined_at: "2026-09-02T14:00:00Z",
    });
    const s = realm.status(NODE);
    expect(s.joined).toBe(true);
    expect(s.citizen_did).toBeUndefined();
    expect(s.has_ucan).toBe(false);
  });

  it("an absent or unreadable credential is simply not joined", () => {
    expect(realm.loadCredential(NODE)).toBeUndefined();
    expect(realm.status(NODE)).toEqual({ portal: "https://portal.test", joined: false });
    expect(realm.status(undefined).joined).toBe(false);
  });
});

describe("join flow against a fake portal", () => {
  function fakePortal(script: Array<{ status: number; body: unknown }>) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: realm.FetchLike = async (url, init) => {
      calls.push({ url, init });
      const next = script.shift() ?? { status: 500, body: { error: "script exhausted" } };
      return { status: next.status, json: async () => next.body };
    };
    return { fetchImpl, calls };
  }

  it("begin creates the session with a proof bound to the join procedure and returns link + QR", async () => {
    const portal = fakePortal([{ status: 201, body: { session_id: "s1", join_url: "https://portal.test/join/s1", expires_at: "2999-01-01T00:00:00Z" } }]);
    const began = await realm.begin({ connectedVia: "opencode 1.18.25", fetchImpl: portal.fetchImpl });
    expect(began.reused).toBe(false);
    expect(began.join_url).toBe("https://portal.test/join/s1");
    expect(began.qr_terminal.length).toBeGreaterThan(0);
    expect(portal.calls[0].url).toBe("https://portal.test/api/v1/join/sessions");
    const sent = JSON.parse(String(portal.calls[0].init?.body));
    expect(sent.proof).toEqual({ timestamp: 1788352709318, signature: `sig-for-${realm.JOIN_PROOF_PROCEDURE}` });
    expect(realm.status(NODE).pending?.session_id).toBe("s1");
    // a second begin while pending reuses the same session rather than spamming the portal
    const again = await realm.begin({ fetchImpl: portal.fetchImpl });
    expect(again.reused).toBe(true);
    expect(again.session_id).toBe("s1");
    expect(portal.calls.length).toBe(1);
  });

  it("waitForOutcome stores the credential once the person confirms, including the membership UCAN", async () => {
    const portal = fakePortal([
      { status: 201, body: { session_id: "s2", join_url: "https://portal.test/join/s2", expires_at: "2999-01-01T00:00:00Z" } },
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
    await realm.begin({ fetchImpl: portal.fetchImpl });
    const after = await realm.waitForOutcome(NODE, 30, portal.fetchImpl);
    expect(after.joined).toBe(true);
    expect(after.org_identity).toBe("mri:org:io.macula/rgfaber");
    expect(after.citizen_did).toBe(NODE);
    expect(after.has_ucan).toBe(true);
    expect(realm.loadCredential(NODE)?.cert_pem).toBe("PEM");
    expect(realm.loadCredential(NODE)?.ucan).toBe("eyJ.fake.token");
    expect(realm.status(NODE).pending).toBeUndefined();
  });

  it("waitForOutcome against an older portal (no citizen_did/ucan in the confirm body) still joins cleanly", async () => {
    const portal = fakePortal([
      { status: 201, body: { session_id: "s2b", join_url: "https://portal.test/join/s2b", expires_at: "2999-01-01T00:00:00Z" } },
      { status: 200, body: { status: "confirmed", refresh_token: "mrt_2b", org_identity: "mri:org:io.macula/rgfaber" } },
    ]);
    await realm.begin({ fetchImpl: portal.fetchImpl });
    const after = await realm.waitForOutcome(NODE, 30, portal.fetchImpl);
    expect(after.joined).toBe(true);
    expect(after.has_ucan).toBe(false);
    expect(realm.loadCredential(NODE)?.ucan).toBeUndefined();
  });

  it("an expired session is reported, not silently retried forever", async () => {
    const portal = fakePortal([
      { status: 201, body: { session_id: "s3", join_url: "https://portal.test/join/s3", expires_at: "2999-01-01T00:00:00Z" } },
      { status: 410, body: { error: "session_expired" } },
    ]);
    await realm.begin({ fetchImpl: portal.fetchImpl });
    const after = await realm.waitForOutcome(NODE, 5, portal.fetchImpl);
    expect(after.joined).toBe(false);
    expect(after.pending).toBeUndefined();
    expect(after.error).toMatch(/expired/);
  });
});
