import { describe, expect, it } from "vitest";
import { assertNoLikelySecret, findLikelySecret } from "./secret_scan.js";

// A genuine UCAN issued live 2026-09-04 (device auto-join verification
// against io.macula) -- not a fabricated example. Bearer tokens by design
// (see reference_macula_ucan_bearer_not_audience_bound), returned raw
// (ucan: <jwt>) from issue_membership_ucan_v1 replies constantly; must
// never trip the scanner on its own.
const REAL_UCAN =
  "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsInVjdiI6IjAuMTAuMCJ9." +
  "eyJpc3MiOiIwNzljZjFlNTQxMmI1ZTIyNzc5M2JjYzk0YmRjNGExNjJhZDM2YzEwYzZmODYxMjc2ZmJiMjE0MDIxOWNhN2YxIiwiYXVkIjoiMTgyYzczMjBkZWQzY2U1ZjRiYTU0ZmFmNjhlYWNjN2IyZTA0NzZhYTNhMDE0OGRkMzNlOTk2Y2IzYzY3NmUwOSIsImV4cCI6MTc4ODU0MzU5MCwiY2FwIjpbeyJjYW4iOiJtZW1iZXIvZW1haWwtdmVyaWZpZWQiLCJ3aXRoIjoibXJpOnJlYWxtOmlvLm1hY3VsYSJ9XSwicHJmIjpbXX0." +
  "8Bb--v6-bx9cZaEIi6iUjwwM9tPntxc1gYmMez5urBqy9aSodueWt5Mu6FpZZlSSJ4arEbwKxJne-T9ml6PeBw";

// Realistically-shaped (not cryptographically real, doesn't need to be)
// X.509 blocks -- exactly what macula-realm's CertificateRpcHandlers
// (issue_app_cert/issue_ed25519_app_cert) returns as cert_pem/org_ca_pem/
// realm_ca_pem, already-shipped legitimate mesh traffic.
const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBhTCCASugAwIBAgIUD3xk9FakeCertForTestingPurposesOnlyNotReal
Y2VydGlmaWNhdGUgZGF0YSBnb2VzIGhlcmUgZm9yIHRlc3RpbmcgcHVycG9zZXM=
-----END CERTIFICATE-----`;

const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFakePublicKeyDataForTestingOnly
-----END PUBLIC KEY-----`;

const PRIVATE_KEY_PEM = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAFakePrivateKeyDataThatShouldNeverBePublishedOnMesh
-----END RSA PRIVATE KEY-----`;

describe("findLikelySecret", () => {
  describe("things that MUST pass clean (real, legitimate mesh traffic)", () => {
    it("a real UCAN JWT, on its own, is not flagged", () => {
      expect(findLikelySecret(REAL_UCAN, "ucan")).toBeUndefined();
    });

    it("a real UCAN inside a realistic issue_membership_ucan_v1 reply shape passes clean", () => {
      const reply = { citizen_did: "7db4c40dd40e0d914b17af10d2513f4f11f539cc059a5f95850f488e9f7f10c9", ucan: REAL_UCAN };
      expect(findLikelySecret(reply, "result")).toBeUndefined();
    });

    it("a certificate PEM block (issue_app_cert's cert_pem) passes clean", () => {
      expect(findLikelySecret(CERT_PEM, "cert_pem")).toBeUndefined();
    });

    it("a public key PEM block passes clean", () => {
      expect(findLikelySecret(PUBLIC_KEY_PEM, "pubkey")).toBeUndefined();
    });

    it("a realistic issue_app_cert reply (cert_pem + org_ca_pem + realm_ca_pem) passes clean", () => {
      const reply = { cert_pem: CERT_PEM, org_ca_pem: CERT_PEM, realm_ca_pem: CERT_PEM };
      expect(findLikelySecret(reply, "result")).toBeUndefined();
    });

    it("ordinary mesh fields (long hex ids, node ids, MCIDs) pass clean", () => {
      expect(
        findLikelySecret(
          {
            citizen_did: "7db4c40dd40e0d914b17af10d2513f4f11f539cc059a5f95850f488e9f7f10c9",
            mcid_hex: "a".repeat(68),
            realm: "ABB81B5A614B63551B400B810648C0C8A78EFAD845442630C94B46CC95D2FCD1",
            auth_token_type: "bearer",
          },
          "args",
        ),
      ).toBeUndefined();
    });

    it("an empty/undefined-heavy object passes clean", () => {
      expect(findLikelySecret({ a: undefined, b: null, c: 42, d: [1, 2, 3] }, "args")).toBeUndefined();
    });
  });

  describe("things that MUST be caught", () => {
    it("an AWS access key ID", () => {
      const m = findLikelySecret("here's my key AKIAIOSFODNN7EXAMPLE for the demo", "text");
      expect(m?.patternName).toBe("AWS access key ID");
    });

    it("a PEM private key block", () => {
      const m = findLikelySecret(PRIVATE_KEY_PEM, "content");
      expect(m?.patternName).toBe("PEM private key block");
    });

    it("an OPENSSH private key block", () => {
      const m = findLikelySecret("-----BEGIN OPENSSH PRIVATE KEY-----\nfakekeydata\n-----END OPENSSH PRIVATE KEY-----", "content");
      expect(m?.patternName).toBe("PEM private key block");
    });

    it("a GitHub personal access token", () => {
      const m = findLikelySecret("token: ghp_" + "A".repeat(36), "text");
      expect(m?.patternName).toBe("GitHub token");
    });

    it("a Slack token", () => {
      const m = findLikelySecret("xoxb-1234567890-abcdefghij", "text");
      expect(m?.patternName).toBe("Slack token");
    });

    it("a Stripe live secret key", () => {
      const m = findLikelySecret("sk_live_" + "a".repeat(24), "text");
      expect(m?.patternName).toBe("Stripe secret key");
    });

    it("an OpenAI API key", () => {
      const m = findLikelySecret("sk-" + "a".repeat(24), "text");
      expect(m?.patternName).toBe("OpenAI API key");
    });

    it("an Anthropic API key", () => {
      const m = findLikelySecret("sk-ant-" + "a".repeat(24), "text");
      expect(m?.patternName).toBe("Anthropic API key");
    });

    it("a literal Authorization: Bearer header", () => {
      const m = findLikelySecret("Authorization: Bearer " + REAL_UCAN, "text");
      expect(m?.patternName).toBe("Authorization: Bearer header");
    });

    it("a .env-style secret KEY=value line", () => {
      const m = findLikelySecret("DB_PASSWORD=hunter2", "text");
      expect(m?.patternName).toBe("secret-looking KEY=value");
    });

    it("an AWS_SECRET_ACCESS_KEY=value line", () => {
      const m = findLikelySecret("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "text");
      expect(m?.patternName).toBe("secret-looking KEY=value");
    });

    it("a YAML-style KEY: value line (colon separator, not just =)", () => {
      const m = findLikelySecret("DB_PASSWORD: hunter2", "text");
      expect(m?.patternName).toBe("secret-looking KEY=value");
    });

    it("an ENCRYPTED PRIVATE KEY block (PKCS#8 with a passphrase)", () => {
      const m = findLikelySecret("-----BEGIN ENCRYPTED PRIVATE KEY-----\nfakedata\n-----END ENCRYPTED PRIVATE KEY-----", "content");
      expect(m?.patternName).toBe("PEM private key block");
    });

    it("a real PGP private key armor block (BEGIN PGP PRIVATE KEY BLOCK, not just PGP PRIVATE KEY)", () => {
      const m = findLikelySecret("-----BEGIN PGP PRIVATE KEY BLOCK-----\nfakedata\n-----END PGP PRIVATE KEY BLOCK-----", "content");
      expect(m?.patternName).toBe("PEM private key block");
    });

    it("a secret restructured into a JSON object property -- the key name alone carries the signal, found by adversarial review as the most realistic bypass", () => {
      const m = findLikelySecret({ AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" }, "fact");
      expect(m?.patternName).toBe("secret-looking KEY=value");
      expect(m?.path).toBe("fact.AWS_SECRET_ACCESS_KEY");
    });

    it("a JSON-structured DB_PASSWORD, value alone has no distinctive shape at all", () => {
      const m = findLikelySecret({ config: { DB_PASSWORD: "hunter2" } }, "args");
      expect(m?.patternName).toBe("secret-looking KEY=value");
      expect(m?.path).toBe("args.config.DB_PASSWORD");
    });
  });

  describe("path reporting", () => {
    it("reports the dotted path to a nested match", () => {
      const m = findLikelySecret({ config: { apiKey: "sk-" + "a".repeat(24) } }, "fact");
      expect(m?.path).toBe("fact.config.apiKey");
    });

    it("reports the bracketed path to a match inside an array", () => {
      const m = findLikelySecret({ items: ["fine", "AKIAIOSFODNN7EXAMPLE"] }, "args");
      expect(m?.path).toBe("args.items[1]");
    });

    it("returns undefined, not a match, for the first clean value when a later one is dirty -- finds ANY match, order aside", () => {
      const m = findLikelySecret({ a: "clean", b: "AKIAIOSFODNN7EXAMPLE" }, "args");
      expect(m).toBeDefined();
    });
  });
});

describe("assertNoLikelySecret", () => {
  it("does not throw on clean content", () => {
    expect(() => assertNoLikelySecret({ text: "just a normal message" }, "text")).not.toThrow();
  });

  it("does not throw on a real UCAN or a real cert_pem", () => {
    expect(() => assertNoLikelySecret(REAL_UCAN, "ucan")).not.toThrow();
    expect(() => assertNoLikelySecret(CERT_PEM, "cert_pem")).not.toThrow();
  });

  it("throws a clear, actionable error naming the pattern and path", () => {
    expect(() => assertNoLikelySecret({ config: { apiKey: "AKIAIOSFODNN7EXAMPLE" } }, "fact")).toThrow(
      /fact looks like it contains a AWS access key ID \(at fact\.config\.apiKey\)/,
    );
  });
});
