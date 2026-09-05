// Regression test for the same bug fixed in doctor.test.ts, in status.ts's
// own copy of the same logic: hasMaculaEntry() hardcoded JSON.parse and
// a `mcpServers.macula` lookup, so `macula-mcp-status` reported opencode
// as "✗ macula NOT registered" even when correctly configured, and would
// have done the same (or thrown, caught -> false) for Goose's YAML file.
//
// Same homedir() mocking approach as mcp_clients/index.test.ts -- see
// that file's header for why process.env.HOME alone does not work here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL } from "../install/mcp_clients/index.js";
import { hasMaculaEntry } from "./status.js";

let fakeHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

describe("status's hasMaculaEntry", () => {
  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), "macula-mcp-status-test-"));
  });

  afterEach(async () => {
    await rm(fakeHome, { recursive: true, force: true });
    fakeHome = "";
  });

  for (const client of ALL) {
    it(`reports true for ${client.CLIENT_LABEL} after install()`, async () => {
      await client.install();
      expect(await hasMaculaEntry(client)).toBe(true);
    });

    it(`reports false for ${client.CLIENT_LABEL} before install (no config file yet)`, async () => {
      expect(await hasMaculaEntry(client)).toBe(false);
    });

    it(`reports false for ${client.CLIENT_LABEL} after install() then uninstall()`, async () => {
      await client.install();
      await client.uninstall();
      expect(await hasMaculaEntry(client)).toBe(false);
    });
  }
});
