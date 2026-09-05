// Regression test for the two real bugs this project shipped and only
// caught by running the real installer against a real client: a wrong
// hardcoded config path (Claude Code reads ~/.claude.json, not
// ~/.claude/mcp.json -- v0.3.2), and a bare `npx -y @macula-io/mcp`
// launch command that fails outright because this package has 4 bin
// entries and none is literally "mcp" (v0.3.0). Neither was caught by
// `npm publish` succeeding or CI passing on typecheck/unit tests alone.
//
// This exercises the real configPath() + install()/uninstall() of every
// registered client against a temp directory standing in for $HOME,
// asserting the actual file on disk has the shape a real client would
// need -- not a mock of mergeMcpServer, the real thing.
//
// Isolation is done by mocking node:os's homedir(), NOT by mutating
// process.env.HOME. That was tried first and is NOT safe: vitest's
// default worker-thread pool gives each worker its own JS-level
// process.env, but os.homedir() resolves through a native/libuv call
// that reads the real process environment, not the per-worker JS copy --
// so process.env.HOME = tmpDir silently has no effect and every adapter
// call falls through to the REAL home directory. Confirmed live, the
// hard way: an early version of this test using that technique wrote a
// fake "someone-elses-server" entry into this machine's real
// ~/.claude.json and stripped the real macula entry, because every
// assertion here checks RELATIVE behavior (idempotency, non-destructive
// removal) that passes identically whether it's operating on a temp file
// or the real one. Fixed by mocking node:os directly (a JS-level
// intercept that works regardless of pool/thread model) and by adding
// the "actually resolves under the fake home" assertion below, which
// would have caught the isolation failure immediately instead of
// silently passing against real data.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ALL, type ClientAdapter } from "./index.js";

// Read/write a client's config file in its own real format -- YAML for
// Goose, JSON for everyone else. Using the wrong parser here would
// either throw immediately (JSON.parse on YAML) or silently succeed on
// nonsense, neither of which is what "matches index.test.ts's existing
// coverage shape" means for a client whose file format actually differs.
function readConfigFile(client: ClientAdapter, raw: string): Record<string, unknown> {
  return client.CONFIG_FORMAT === "yaml"
    ? (parseYaml(raw) as Record<string, unknown>)
    : (JSON.parse(raw) as Record<string, unknown>);
}

function stringifyConfigFile(client: ClientAdapter, data: Record<string, unknown>): string {
  return client.CONFIG_FORMAT === "yaml" ? stringifyYaml(data) : JSON.stringify(data);
}

let fakeHome = "";
// Hoisted above the imports above by vitest's transform, so every
// adapter's `import { homedir } from "node:os"` sees this, not the real
// one -- see the file header for why process.env.HOME doesn't work here.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

describe("MCP client adapters", () => {
  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), "macula-mcp-install-test-"));
  });

  afterEach(async () => {
    await rm(fakeHome, { recursive: true, force: true });
    fakeHome = "";
  });

  for (const client of ALL) {
    describe(client.CLIENT_LABEL, () => {
      it("resolves configPath() under the fake home, not the real one", () => {
        // The load-bearing isolation check -- see the file header. If
        // node:os's mock above ever stops working, this fails loudly
        // instead of every other test silently operating on real files.
        expect(client.configPath().startsWith(fakeHome)).toBe(true);
      });

      it("writes the macula entry, with the -p bin workaround, at the real configPath()", async () => {
        const result = await client.install();
        expect(result.outcome).toBe("added");
        expect(result.configPath).toBe(client.configPath());

        const raw = await readFile(client.configPath(), "utf8");
        const parsed = readConfigFile(client, raw);
        const container = client.CONTAINER_KEY ?? "mcpServers";
        expect((parsed[container] as Record<string, unknown>).macula).toEqual(
          client.EXPECTED_ENTRY ?? {
            command: "npx",
            args: ["-y", "-p", "@macula-io/mcp", "macula-mcp"],
          },
        );
      });

      it("is idempotent: installing twice is a no-op the second time", async () => {
        await client.install();
        const second = await client.install();
        expect(second.outcome).toBe("unchanged");
      });

      it("uninstall removes the entry without touching the rest of the file", async () => {
        await client.install();
        // Something else's entry must survive uninstall -- proves this
        // isn't just truncating the file.
        const container = client.CONTAINER_KEY ?? "mcpServers";
        const before = readConfigFile(client, await readFile(client.configPath(), "utf8")) as Record<
          string,
          Record<string, unknown>
        >;
        before[container]["someone-elses-server"] = { command: "whatever" };
        await writeFile(client.configPath(), stringifyConfigFile(client, before));

        const result = await client.uninstall();
        expect(result.outcome).toBe("replaced");

        const after = readConfigFile(client, await readFile(client.configPath(), "utf8")) as Record<
          string,
          Record<string, unknown>
        >;
        expect(after[container].macula).toBeUndefined();
        expect(after[container]["someone-elses-server"]).toEqual({ command: "whatever" });
      });
    });
  }

  it("every registered client has a distinct configPath() (catches two clients silently sharing one file)", () => {
    const paths = ALL.map((c) => c.configPath());
    expect(new Set(paths).size).toBe(paths.length);
  });
});
