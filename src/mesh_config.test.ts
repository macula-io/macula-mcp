import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SEEDS,
  IO_MACULA_REALM_ID,
  IO_MACULA_REALM_KEY,
  MeshError,
  nodeKeyPath,
  realmIdOf,
  realmTrust,
  seeds,
  splitRealmPrefix,
} from "./mesh_config.js";

function restoring(...names: string[]): () => void {
  const saved = names.map((n) => [n, process.env[n]] as const);
  return () => {
    for (const [n, v] of saved) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  };
}

describe("nodeKeyPath", () => {
  const restore = restoring("MACULA_MCP_IDENTITY");
  afterEach(restore);

  it("is one key per session scope, persisted under the config directory, never the temp dir", () => {
    delete process.env.MACULA_MCP_IDENTITY;
    const path = nodeKeyPath();
    const scope = process.env.CLAUDE_CODE_SESSION_ID ?? `ppid-${process.ppid}`;
    expect(path).toBe(join(homedir(), ".config", "macula-mcp", "keys", `${scope}.key`));
    expect(path.startsWith(tmpdir())).toBe(false);
  });

  it("MACULA_MCP_IDENTITY pins the key file", () => {
    process.env.MACULA_MCP_IDENTITY = "/tmp/pinned.key";
    expect(nodeKeyPath()).toBe("/tmp/pinned.key");
  });
});

describe("seeds", () => {
  const restore = restoring("MACULA_MESH_STATIONS");
  afterEach(restore);

  it("defaults to the six fleet stations, each pinned by its node_id", () => {
    delete process.env.MACULA_MESH_STATIONS;
    const s = seeds();
    expect(s).toEqual(DEFAULT_SEEDS);
    expect(s).toHaveLength(6);
    for (const seed of s) {
      expect(seed.port).toBe(4433);
      expect(seed.nodeId).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("reads host:port@node_id entries, comma separated", () => {
    process.env.MACULA_MESH_STATIONS = ` a.example:4433@${"ab".repeat(32)} , [::1]:5000@${"CD".repeat(32)}`;
    expect(seeds()).toEqual([
      { host: "a.example", port: 4433, nodeId: "ab".repeat(32) },
      { host: "::1", port: 5000, nodeId: "cd".repeat(32) },
    ]);
  });

  it("refuses an entry without a node_id, naming it: a station is only trusted by the node_id it proves", () => {
    process.env.MACULA_MESH_STATIONS = "a.example:4433";
    expect(() => seeds()).toThrow(/a\.example:4433.*node_id/);
  });

  it("refuses an entry without a port or with a malformed node_id", () => {
    process.env.MACULA_MESH_STATIONS = `a.example@${"ab".repeat(32)}`;
    expect(() => seeds()).toThrow(/port/);
    process.env.MACULA_MESH_STATIONS = "a.example:4433@abcd";
    expect(() => seeds()).toThrow(/node_id/);
  });
});

describe("realms", () => {
  const restore = restoring("MACULA_MESH_REALMS");
  afterEach(restore);

  it("names a realm by sha256 of its name", () => {
    expect(realmIdOf("io.macula")).toBe(createHash("sha256").update("io.macula").digest("hex"));
    expect(IO_MACULA_REALM_ID).toBe(realmIdOf("io.macula"));
  });

  it("trusts io.macula's key by default: a pq_hybrid carried key", () => {
    delete process.env.MACULA_MESH_REALMS;
    expect(realmTrust()).toEqual([{ realm: IO_MACULA_REALM_ID, key: IO_MACULA_REALM_KEY }]);
    expect(IO_MACULA_REALM_KEY).toMatch(/^[0-9a-f]{6236}$/);
  });

  it("adds realm=key entries from MACULA_MESH_REALMS", () => {
    process.env.MACULA_MESH_REALMS = `${"11".repeat(32)}=${"aa".repeat(40)}`;
    expect(realmTrust()).toContainEqual({ realm: "11".repeat(32), key: "aa".repeat(40) });
    expect(realmTrust()).toHaveLength(2);
  });

  it("refuses a malformed MACULA_MESH_REALMS entry", () => {
    process.env.MACULA_MESH_REALMS = "io.macula=abcd";
    expect(() => realmTrust()).toThrow(/MACULA_MESH_REALMS/);
  });
});

describe("splitRealmPrefix", () => {
  it("splits the realm-prefixed form a DHT listing prints", () => {
    expect(splitRealmPrefix(`${"ab".repeat(32)}/mcl-echo/echo`)).toEqual({ procedure: "mcl-echo/echo", realm: "ab".repeat(32) });
  });

  it("refuses a prefix that disagrees with the realm passed alongside", () => {
    expect(() => splitRealmPrefix(`${"ab".repeat(32)}/mcl-echo/echo`, "cd".repeat(32))).toThrow(MeshError);
  });

  it("passes a bare procedure through", () => {
    expect(splitRealmPrefix("mcl-echo/echo", "cd".repeat(32))).toEqual({ procedure: "mcl-echo/echo", realm: "cd".repeat(32) });
  });
});
