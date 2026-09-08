import { describe, expect, it, vi } from "vitest";
import { emit, membershipEvent, parseArgs } from "./realm.js";
import type { RealmCredential } from "../realm.js";

describe("parseArgs", () => {
  it("join <realm>", () => {
    expect(parseArgs(["join", "io.macula"])).toMatchObject({ subcommand: "join", realmName: "io.macula", json: false, help: false });
  });

  it("--json and --wait-seconds, in either order relative to the positionals", () => {
    expect(parseArgs(["join", "io.macula", "--json", "--wait-seconds", "30"])).toMatchObject({
      subcommand: "join",
      realmName: "io.macula",
      json: true,
      waitSeconds: 30,
    });
    expect(parseArgs(["--wait-seconds", "30", "join", "io.macula"])).toMatchObject({ waitSeconds: 30, subcommand: "join", realmName: "io.macula" });
  });

  it("--help/-h", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["join", "io.macula"]).help).toBe(false);
  });

  it("no subcommand at all", () => {
    expect(parseArgs([]).subcommand).toBeUndefined();
  });
});

describe("membershipEvent", () => {
  it("derives handle from org_identity's own last path segment, and carries no bearer credential", () => {
    const cred: RealmCredential = {
      node_id: "n",
      portal: "https://realm.macula.io",
      org_identity: "mri:org:io.macula/rgfaber",
      refresh_token: "mrt_secret",
      cert_pem: "PEM_SECRET",
      joined_at: "2026-09-08T00:00:00Z",
      tier: "citizen",
    };
    const ev = membershipEvent("io.macula", cred);
    expect(ev.handle).toBe("rgfaber");
    expect(ev.realm).toBe("io.macula");
    expect(ev.joined_at).toBe("2026-09-08T00:00:00Z");
    // Never echoes the bearer credential -- same posture as realm.ts's
    // own status()/RealmStatus (refresh_token/cert_pem stay file-only).
    expect(JSON.stringify(ev)).not.toContain("mrt_secret");
    expect(JSON.stringify(ev)).not.toContain("PEM_SECRET");
  });
});

describe("emit", () => {
  it("--json emits exactly one line of valid JSON matching the event", () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s: string) => {
      logs.push(s);
    });
    try {
      emit(true, { event: "confirmed", realm: "io.macula", handle: "rgfaber" });
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!)).toEqual({ event: "confirmed", realm: "io.macula", handle: "rgfaber" });
    } finally {
      spy.mockRestore();
    }
  });

  it("human mode never emits raw JSON -- readable text instead, for every event kind", () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s: string) => {
      logs.push(s);
    });
    try {
      for (const ev of [
        { event: "already_joined" as const, realm: "io.macula", handle: "rgfaber", joined_at: "2026-09-08T00:00:00Z" },
        { event: "session" as const, realm: "io.macula", join_url: "https://realm.macula.io/join/s1", expires_at: "2026-09-08T00:10:00Z", qr_terminal: "██" },
        { event: "confirmed" as const, realm: "io.macula", handle: "rgfaber" },
        { event: "expired" as const, realm: "io.macula" },
        { event: "timeout" as const, realm: "io.macula", waited_seconds: 30 },
        { event: "error" as const, realm: "io.macula", message: "boom" },
      ]) {
        logs.length = 0;
        emit(false, ev);
        const out = logs.join("\n");
        expect(() => JSON.parse(out)).toThrow(); // human text, not a JSON blob
        expect(out.length).toBeGreaterThan(0);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
