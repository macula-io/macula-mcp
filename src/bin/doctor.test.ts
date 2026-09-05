// Regression test for a real bug found while adding the Goose adapter:
// readMaculaEntry() hardcoded JSON.parse and a `mcpServers.macula`
// lookup, so it silently read back `undefined` for opencode (a
// different container key, `mcp`, and a `command: string[]` entry
// shape) even when opencode was correctly configured and would have
// worked -- `macula-mcp-doctor` reported "not configured, skipping" for
// a working install. Reproduced directly against the original function
// before fixing it (see the session that added this file); this test
// pins the fixed behavior for every registered client, not just
// opencode, so a future client with yet another shape trips this
// immediately instead of silently mis-reporting.
//
// Same homedir() mocking approach as mcp_clients/index.test.ts, for the
// same reason -- see that file's header for why process.env.HOME alone
// does not work here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL } from "../install/mcp_clients/index.js";
import { readMaculaEntry } from "./doctor.js";

let fakeHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

describe("doctor's readMaculaEntry", () => {
  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), "macula-mcp-doctor-test-"));
  });

  afterEach(async () => {
    await rm(fakeHome, { recursive: true, force: true });
    fakeHome = "";
  });

  for (const client of ALL) {
    it(`reads back a real, spawnable {command, args} for ${client.CLIENT_LABEL} after install()`, async () => {
      await client.install();
      const entry = await readMaculaEntry(client);
      expect(entry).toBeDefined();
      expect(typeof entry?.command).toBe("string");
      expect(entry?.command.length).toBeGreaterThan(0);
      expect(Array.isArray(entry?.args)).toBe(true);
      // Every adapter's real entry launches via npx -p @macula-io/mcp -- a
      // wrong container key or unhandled entry shape would either throw
      // (caught, returns undefined) or return garbage instead of this.
      expect(entry?.command).toBe("npx");
      expect(entry?.args).toContain("@macula-io/mcp");
    });

    it(`readMaculaEntry returns undefined for ${client.CLIENT_LABEL} before install (no config file yet)`, async () => {
      const entry = await readMaculaEntry(client);
      expect(entry).toBeUndefined();
    });
  }
});
