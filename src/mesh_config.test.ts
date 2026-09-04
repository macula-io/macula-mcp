import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultIdentityPath, defaultStation, defaultStations, serveIdentityPath, stationArgs, ucanPath, watchIdentityPath } from "./mesh_config.js";

describe("identity paths", () => {
  // Guards the 2026-08-29 fix: every non-watch tool used to share one
  // machine-wide identity, which failed 5/6 of the time under real
  // concurrent use (see mesh_config.ts's comment above mintIdentityPath).
  afterEach(() => {
    delete process.env.MACULA_MCP_IDENTITY;
    delete process.env.MACULA_MCP_WATCH_IDENTITY;
    delete process.env.MACULA_MCP_SERVE_IDENTITY;
  });

  it("mints a stable path across repeated calls in one process", () => {
    expect(defaultIdentityPath()).toBe(defaultIdentityPath());
  });

  it("keeps the default and watch identities separate, so a watch survives other calls", () => {
    expect(defaultIdentityPath()).not.toBe(watchIdentityPath());
  });

  it("MACULA_MCP_IDENTITY pins the default identity to a fixed path", () => {
    process.env.MACULA_MCP_IDENTITY = "/tmp/pinned-identity.seed";
    expect(defaultIdentityPath()).toBe("/tmp/pinned-identity.seed");
  });

  it("MACULA_MCP_WATCH_IDENTITY pins the watch identity to a fixed path", () => {
    process.env.MACULA_MCP_WATCH_IDENTITY = "/tmp/pinned-watch-identity.seed";
    expect(watchIdentityPath()).toBe("/tmp/pinned-watch-identity.seed");
  });

  it("keeps the serve identity separate from default and watch, so a served daemon survives other calls", () => {
    expect(serveIdentityPath()).not.toBe(defaultIdentityPath());
    expect(serveIdentityPath()).not.toBe(watchIdentityPath());
  });

  it("MACULA_MCP_SERVE_IDENTITY pins the serve identity to a fixed path", () => {
    process.env.MACULA_MCP_SERVE_IDENTITY = "/tmp/pinned-serve-identity.seed";
    expect(serveIdentityPath()).toBe("/tmp/pinned-serve-identity.seed");
  });

  // Guards the 2026-09-02 fix: a minted identity used to live in tmpdir()
  // and be deleted on exit, so it churned on every process restart, not
  // just across genuinely concurrent sessions -- indistinguishable to a
  // mesh peer from meeting a stranger every time. It now persists under
  // a scope key (CLAUDE_CODE_SESSION_ID, or this process's own PPID)
  // that survives a restart of just this session's macula-mcp child
  // while still differing from any other concurrent session's.
  it("persists under the scope key actually active in this process, not a fresh random one", () => {
    const path = defaultIdentityPath();
    const expectedScopeKey = process.env.CLAUDE_CODE_SESSION_ID ?? `ppid-${process.ppid}`;
    expect(path).toContain(`default-${expectedScopeKey}.seed`);
  });

  it("lives under a persistent config directory, not the OS temp dir", () => {
    const path = defaultIdentityPath();
    expect(path.startsWith(join(homedir(), ".config", "macula-mcp"))).toBe(true);
    expect(path.startsWith(tmpdir())).toBe(false);
  });
});

describe("defaultStations / stationArgs", () => {
  const saved = { list: process.env.MACULA_MESH_STATIONS, single: process.env.MACULA_MESH_STATION };
  afterEach(() => {
    for (const [k, v] of [["MACULA_MESH_STATIONS", saved.list], ["MACULA_MESH_STATION", saved.single]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("falls back to the built-in 3-station default when neither env var is set", () => {
    delete process.env.MACULA_MESH_STATIONS;
    delete process.env.MACULA_MESH_STATION;
    const stations = defaultStations();
    expect(stations).toHaveLength(3);
    expect(stations[0]).toBe("station-de-frankfurt.macula.io:4433");
    expect(defaultStation()).toBe(stations[0]);
  });

  it("MACULA_MESH_STATIONS (comma-separated) is preferred and parsed in order", () => {
    process.env.MACULA_MESH_STATIONS = "a.example:4433, b.example:4433 ,c.example:4433";
    delete process.env.MACULA_MESH_STATION;
    expect(defaultStations()).toEqual(["a.example:4433", "b.example:4433", "c.example:4433"]);
    expect(defaultStation()).toBe("a.example:4433");
  });

  it("the older singular MACULA_MESH_STATION still works as a one-element list", () => {
    delete process.env.MACULA_MESH_STATIONS;
    process.env.MACULA_MESH_STATION = "legacy.example:4433";
    expect(defaultStations()).toEqual(["legacy.example:4433"]);
    expect(defaultStation()).toBe("legacy.example:4433");
  });

  it("MACULA_MESH_STATIONS takes priority over the older singular var when both are set", () => {
    process.env.MACULA_MESH_STATIONS = "a.example:4433,b.example:4433";
    process.env.MACULA_MESH_STATION = "legacy.example:4433";
    expect(defaultStations()).toEqual(["a.example:4433", "b.example:4433"]);
  });

  it("an empty MACULA_MESH_STATIONS falls through to MACULA_MESH_STATION rather than resolving to []", () => {
    process.env.MACULA_MESH_STATIONS = "";
    process.env.MACULA_MESH_STATION = "legacy.example:4433";
    expect(defaultStations()).toEqual(["legacy.example:4433"]);
  });

  it("stationArgs with no explicit host resolves to the primary configured station", () => {
    process.env.MACULA_MESH_STATIONS = "a.example:4433,b.example:4433,c.example:4433";
    delete process.env.MACULA_MESH_STATION;
    expect(stationArgs(undefined)).toEqual({ host: "a.example:4433" });
  });

  it("stationArgs with an explicit host override reports it unchanged, even with multiple stations configured", () => {
    process.env.MACULA_MESH_STATIONS = "a.example:4433,b.example:4433,c.example:4433";
    expect(stationArgs("explicit.example:4433")).toEqual({ host: "explicit.example:4433" });
  });
});

describe("ucanPath", () => {
  afterEach(() => {
    delete process.env.MACULA_MCP_UCAN;
  });

  it("is undefined when unset -- nothing attached to a call", () => {
    delete process.env.MACULA_MCP_UCAN;
    expect(ucanPath()).toBeUndefined();
  });

  it("treats an empty string the same as unset, matching every other env var in this file", () => {
    process.env.MACULA_MCP_UCAN = "";
    expect(ucanPath()).toBeUndefined();
  });

  it("returns the pinned path when set", () => {
    process.env.MACULA_MCP_UCAN = "/tmp/agent-delegation.ucan";
    expect(ucanPath()).toBe("/tmp/agent-delegation.ucan");
  });
});
