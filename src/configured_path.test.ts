import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredPath, validateConfiguredPaths } from "./configured_path.js";
import { nodeKeyPath } from "./mesh_config.js";
import { machineDb, closeMachineDb } from "./machine_transcript.js";
import { listAgents, closeRoster } from "./be_present/roster.js";
import { recentFacts, closeTranscript } from "./converse_in_rooms/lobby_transcript.js";
import { realmDir } from "./realm.js";
import { policyFilePath } from "./policy.js";

const names = [
  "MACULA_MCP_IDENTITY", "MACULA_MCP_RINGS_DB", "MACULA_MCP_ROSTER_DB",
  "MACULA_MCP_LOBBY_TRANSCRIPT_DB", "MACULA_MCP_REALM_DIR",
  "MACULA_MCP_CONTACT_POLICY_FILE", "MACULA_MCP_BANNER_FILE",
];
const dirs: string[] = [];

afterEach(() => {
  closeMachineDb();
  closeRoster();
  closeTranscript();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("configured paths", () => {
  it("expands home prefixes while preserving other paths and SQLite memory", () => {
    const home = mkdtempSync(join(tmpdir(), "macula-home-"));
    dirs.push(home);
    vi.stubEnv("HOME", home);
    for (const prefix of ["~", "$HOME"]) {
      expect(configuredPath("TEST", `${prefix}/nested/file`)).toBe(join(home, "nested", "file"));
      expect(configuredPath("TEST", prefix)).toBe(home);
    }
    expect(configuredPath("TEST", ":memory:")).toBe(":memory:");
    expect(configuredPath("TEST", "relative/file")).toBe("relative/file");
    expect(configuredPath("TEST", join(home, "absolute"))).toBe(join(home, "absolute"));
    expect(() => configuredPath("TEST", "~another/file")).toThrow(/TEST/);
  });

  it.each(names)("rejects %s by name when HOME is unavailable", (name) => {
    for (const variable of names) vi.stubEnv(variable, undefined);
    vi.stubEnv("HOME", undefined);
    vi.stubEnv(name, "~/file");
    expect(() => validateConfiguredPaths()).toThrow(name);
    vi.stubEnv("HOME", "relative");
    expect(() => validateConfiguredPaths()).toThrow(name);
  });

  it("routes identity, state databases, realm and policy to HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "macula-home-"));
    dirs.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("MACULA_MCP_AGENT", undefined);
    vi.stubEnv("MACULA_MCP_IDENTITY", "~/keys/key");
    vi.stubEnv("MACULA_MCP_RINGS_DB", "~/state/rings.db");
    vi.stubEnv("MACULA_MCP_ROSTER_DB", "$HOME/state/roster.db");
    vi.stubEnv("MACULA_MCP_LOBBY_TRANSCRIPT_DB", "~/state/lobby.db");
    vi.stubEnv("MACULA_MCP_REALM_DIR", "$HOME/realm");
    vi.stubEnv("MACULA_MCP_CONTACT_POLICY_FILE", "~/policy.json");
    expect(nodeKeyPath()).toBe(join(home, "keys", "key"));
    expect(realmDir()).toBe(join(home, "realm"));
    expect(policyFilePath()).toBe(join(home, "policy.json"));
    machineDb();
    listAgents(1, 10);
    recentFacts({ limit: 1 });
    for (const file of ["rings.db", "roster.db", "lobby.db"]) {
      expect(existsSync(join(home, "state", file))).toBe(true);
    }
  });
});
