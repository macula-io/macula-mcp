import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LARGE_PAYLOAD_THRESHOLD_BYTES,
  MaculaCliError,
  binPath,
  defaultIdentityPath,
  defaultStation,
  defaultStations,
  installedCliCandidates,
  extractSemver,
  isOlder,
  parseWatchOutput,
  resolveCallArgsFlags,
  serveIdentityPath,
  stationArgs,
  watchIdentityPath,
} from "./macula_cli.js";

describe("parseWatchOutput", () => {
  it("parses one WatchEvent per NDJSON line", () => {
    const stdout =
      `{"topic":"t","publisher":"p1","seq":1,"payload":{"a":1},"delivered_via":"direct","received_at":"x"}\n` +
      `{"topic":"t","publisher":"p2","seq":2,"payload":{"a":2},"delivered_via":"direct","received_at":"y"}\n`;
    const events = parseWatchOutput(stdout);
    expect(events).toHaveLength(2);
    expect(events[0]?.seq).toBe(1);
    expect(events[1]?.seq).toBe(2);
  });

  it("ignores blank lines", () => {
    const stdout = `{"topic":"t","publisher":"p","seq":1,"payload":null,"delivered_via":"direct","received_at":"x"}\n\n\n`;
    expect(parseWatchOutput(stdout)).toHaveLength(1);
  });

  it("throws on a trailing {ok:false} error envelope instead of misparsing it as an event", () => {
    // The real bug this test guards against: JSON.parse succeeds on
    // *any* valid JSON regardless of shape, so a naive try/catch around
    // "parse as WatchEvent" never distinguishes an error envelope from
    // a real event -- it has to be an explicit shape check.
    const stdout =
      `{"topic":"t","publisher":"p","seq":1,"payload":null,"delivered_via":"direct","received_at":"x"}\n` +
      `{"ok":false,"error":{"message":"connection dropped"}}\n`;
    expect(() => parseWatchOutput(stdout)).toThrow(MaculaCliError);
    expect(() => parseWatchOutput(stdout)).toThrow(/connection dropped/);
  });

  it("returns an empty array for empty stdout", () => {
    expect(parseWatchOutput("")).toEqual([]);
  });

  it("ignores a non-JSON line rather than throwing", () => {
    const stdout = `not json at all\n{"topic":"t","publisher":"p","seq":1,"payload":null,"delivered_via":"direct","received_at":"x"}\n`;
    expect(parseWatchOutput(stdout)).toHaveLength(1);
  });
});

describe("extractSemver", () => {
  it("parses the real macula-cli --version output shape", () => {
    expect(extractSemver("macula-cli 0.1.2 (commit deadbeef, built 2026-08-29T14:22:11Z)")).toBe("0.1.2");
  });

  it("strips a leading v", () => {
    expect(extractSemver("v0.1.3")).toBe("0.1.3");
  });

  it("returns undefined for a dev build with no injected version", () => {
    expect(extractSemver("macula-cli dev (commit none, built unknown)")).toBeUndefined();
  });

  it("returns undefined for a string with no version-shaped substring at all", () => {
    expect(extractSemver("not a version")).toBeUndefined();
  });
});

describe("isOlder", () => {
  it("compares patch versions", () => {
    expect(isOlder("0.1.2", "0.1.3")).toBe(true);
    expect(isOlder("0.1.3", "0.1.2")).toBe(false);
  });

  it("compares minor versions ahead of patch", () => {
    expect(isOlder("0.1.9", "0.2.0")).toBe(true);
  });

  it("compares major versions ahead of minor and patch", () => {
    expect(isOlder("0.9.9", "1.0.0")).toBe(true);
  });

  it("is false for equal versions", () => {
    expect(isOlder("0.1.3", "0.1.3")).toBe(false);
  });
});

describe("identity paths", () => {
  // Guards the 2026-08-29 fix: every non-watch tool used to share one
  // machine-wide identity, which failed 5/6 of the time under real
  // concurrent use (see macula_cli.ts's comment above mintIdentityPath).
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

  // Guards the 2026-09-02 fix: a mined identity used to live in tmpdir()
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

describe("resolveCallArgsFlags", () => {
  // Guards PLAN_LARGE_PAYLOAD_CALLS.md: hecate-rag.upload_knowledge's
  // payload embeds a whole document's raw bytes, which can exceed a
  // safe command-line length -- this is the transparent fallback that
  // keeps call() working without the caller ever knowing the
  // difference.

  it("passes undefined callArgs through as no flags at all", async () => {
    const { flags, cleanup } = await resolveCallArgsFlags(undefined);
    expect(flags).toEqual([]);
    await expect(cleanup()).resolves.toBeUndefined();
  });

  it("passes a small payload inline via --args, unchanged from before this existed", async () => {
    const { flags, cleanup } = await resolveCallArgsFlags({ a: 1 });
    expect(flags).toEqual(["--args", JSON.stringify({ a: 1 })]);
    await expect(cleanup()).resolves.toBeUndefined();
  });

  it("writes a payload at the threshold to a temp file via --args-file", async () => {
    // Pad a field so the JSON string's byte length lands at exactly the
    // threshold -- the boundary itself must take the file path, not the
    // inline one, per resolveCallArgsFlags' own "< threshold" cutoff.
    const overhead = JSON.stringify({ raw_bytes: "" }).length;
    const payload = { raw_bytes: "x".repeat(LARGE_PAYLOAD_THRESHOLD_BYTES - overhead) };
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBe(LARGE_PAYLOAD_THRESHOLD_BYTES);

    const { flags, cleanup } = await resolveCallArgsFlags(payload);
    expect(flags[0]).toBe("--args-file");
    const filePath = flags[1] as string;
    expect(existsSync(filePath)).toBe(true);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(payload);

    await cleanup();
    expect(existsSync(filePath)).toBe(false);
  });

  it("cleanup is safe to call even when nothing was written", async () => {
    const { cleanup } = await resolveCallArgsFlags({ small: true });
    await expect(cleanup()).resolves.toBeUndefined();
    await expect(cleanup()).resolves.toBeUndefined();
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

  it("stationArgs with no explicit host uses the primary as the positional and every remaining station as a -seed flag", () => {
    process.env.MACULA_MESH_STATIONS = "a.example:4433,b.example:4433,c.example:4433";
    delete process.env.MACULA_MESH_STATION;
    expect(stationArgs(undefined)).toEqual({
      host: "a.example:4433",
      seedFlags: ["-seed", "b.example:4433", "-seed", "c.example:4433"],
    });
  });

  it("stationArgs with a single configured station attaches no -seed flags", () => {
    process.env.MACULA_MESH_STATIONS = "only.example:4433";
    expect(stationArgs(undefined)).toEqual({ host: "only.example:4433", seedFlags: [] });
  });

  it("stationArgs with an explicit host override attaches no fallback, even with multiple stations configured", () => {
    process.env.MACULA_MESH_STATIONS = "a.example:4433,b.example:4433,c.example:4433";
    expect(stationArgs("explicit.example:4433")).toEqual({ host: "explicit.example:4433", seedFlags: [] });
  });
});

describe("binPath", () => {
  const saved = { bin: process.env.MACULA_CLI_BIN, dir: process.env.MACULA_CLI_INSTALL_DIR, path: process.env.PATH };
  afterEach(() => {
    for (const [k, v] of [["MACULA_CLI_BIN", saved.bin], ["MACULA_CLI_INSTALL_DIR", saved.dir], ["PATH", saved.path]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("MACULA_CLI_BIN pins the binary outright", () => {
    process.env.MACULA_CLI_BIN = "/opt/somewhere/macula-cli";
    expect(binPath()).toBe("/opt/somewhere/macula-cli");
  });

  it("falls back to the installer's own directory when macula-cli is not on PATH", () => {
    delete process.env.MACULA_CLI_BIN;
    const dir = join(tmpdir(), `macula-mcp-binpath-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, process.platform === "win32" ? "macula-cli.exe" : "macula-cli");
    writeFileSync(bin, "");
    process.env.MACULA_CLI_INSTALL_DIR = dir;
    process.env.PATH = "";
    expect(installedCliCandidates()).toEqual([bin]);
    expect(binPath()).toBe(bin);
  });

  it("still returns the bare name when it is nowhere, so spawn's ENOENT names the fix", () => {
    delete process.env.MACULA_CLI_BIN;
    process.env.MACULA_CLI_INSTALL_DIR = join(tmpdir(), "macula-mcp-binpath-nowhere");
    process.env.PATH = "";
    expect(binPath()).toBe("macula-cli");
  });
});
