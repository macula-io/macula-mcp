// The role prompt: a HUMAN's /mcp__macula__role <name> loads that role's
// system-prompt body VERBATIM from the shared mesh corpus -- mcl-rag's
// get_document_verbatim, not a local file and not a semantic approximation.
// Boundary mocks, same pattern as mesh_memory.test.ts: the one module this
// talks to the mesh through (macula_ts_client.js -- realm discovery and the
// call both go through it) plus presence.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MeshError } from "./mesh_config.js";

const REALM = "a1".repeat(32);

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  discoverProcedureRealm: vi.fn(),
  ensurePresence: vi.fn(),
}));
vi.mock("./macula_ts_client.js", () => ({
  call: mocks.call,
  discoverProcedureRealm: mocks.discoverProcedureRealm,
}));
vi.mock("./be_present/presence.js", () => ({ ensurePresence: mocks.ensurePresence }));

interface CapturedPrompt {
  config: { description?: string; argsSchema?: { role: { safeParse: (v: unknown) => { success: boolean } } } };
  cb: (args: { role: string }) => Promise<{ messages: { role: string; content: { type: string; text: string } }[] }>;
}

/** Captures registerPrompt(name, config, cb) instead of a real McpServer. */
function fakeServer(): { server: McpServer; prompts: Map<string, CapturedPrompt> } {
  const prompts = new Map<string, CapturedPrompt>();
  const server = {
    registerPrompt: (name: string, config: CapturedPrompt["config"], cb: CapturedPrompt["cb"]) => {
      prompts.set(name, { config, cb });
    },
  } as unknown as McpServer;
  return { server, prompts };
}

function promptOf(prompts: Map<string, CapturedPrompt>): CapturedPrompt {
  const prompt = prompts.get("role");
  if (!prompt) throw new Error("role prompt was never registered");
  return prompt;
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("roleSourcePath", () => {
  it("is the path mcl-rag's get_document_verbatim takes: <repo-id>/<relative-path>", async () => {
    const { roleSourcePath } = await import("./mesh_role.js");
    expect(roleSourcePath("devops")).toBe("mcl-corpus/roles/devops.md");
  });
});

describe("registerRole", () => {
  it("registers one prompt, role, whose role argument is required", async () => {
    const { registerRole } = await import("./mesh_role.js");
    const { server, prompts } = fakeServer();
    registerRole(server);

    expect([...prompts.keys()]).toEqual(["role"]);
    const { config } = promptOf(prompts);
    expect(config.description).toMatch(/verbatim/);
    expect(config.argsSchema?.role.safeParse(undefined).success).toBe(false);
    expect(config.argsSchema?.role.safeParse("devops").success).toBe(true);
  });

  it("discovers mcl-rag's realm, fetches the role's file and returns it byte for byte", async () => {
    const role = [
      "---",
      "id: devops",
      "name: DevOps",
      "---",
      "",
      "# DevOps",
      "",
      "You build it, you run it - with ünïcøde, ✓ and a trailing newline.",
      "",
    ].join("\n");
    mocks.discoverProcedureRealm.mockResolvedValue(REALM);
    mocks.call.mockResolvedValue({
      procedure: "mcl-rag/get_document_verbatim",
      // The reply as @macula-io/ts renders it with bytes "tagged": raw_bytes
      // is {"$bytes": base64}, text fields are plain strings.
      payload: {
        source_path: "mcl-corpus/roles/devops.md",
        provenance: { repo_id: "mcl-corpus", path: "roles/devops.md" },
        raw_bytes: { $bytes: Buffer.from(role, "utf8").toString("base64") },
      },
      duration_ms: 11,
    });

    const { registerRole } = await import("./mesh_role.js");
    const { server, prompts } = fakeServer();
    registerRole(server);
    const res = await promptOf(prompts).cb({ role: "devops" });

    expect(mocks.ensurePresence).toHaveBeenCalledWith(server);
    expect(mocks.discoverProcedureRealm).toHaveBeenCalledWith("mcl-rag/get_document_verbatim");
    expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({
      procedure: "mcl-rag/get_document_verbatim",
      callArgs: { source_path: "mcl-corpus/roles/devops.md" },
      realm: REALM,
      bytes: "tagged",
    }));
    expect(res.messages).toEqual([{ role: "user", content: { type: "text", text: role } }]);
  });

  it("answers an unknown role with a clear error, not an empty prompt", async () => {
    mocks.discoverProcedureRealm.mockResolvedValue(REALM);
    mocks.call.mockRejectedValue(new MeshError("macula-ts: the provider answered handler_error: not_found", "handler_error", "provider"));

    const { registerRole } = await import("./mesh_role.js");
    const { server, prompts } = fakeServer();
    registerRole(server);
    await expect(promptOf(prompts).cb({ role: "nope" })).rejects.toThrow(
      'unknown role "nope": the shared corpus has no mcl-corpus/roles/nope.md');
  });

  it("says mcl-rag cannot be reached when the realm discovery fails", async () => {
    mocks.discoverProcedureRealm.mockRejectedValue(new Error("nothing advertised"));

    const { registerRole } = await import("./mesh_role.js");
    const { server, prompts } = fakeServer();
    registerRole(server);
    await expect(promptOf(prompts).cb({ role: "devops" })).rejects.toThrow(/mcl-rag cannot be reached/);
  });

  it("rejects an empty role name with a clear error", async () => {
    const { registerRole } = await import("./mesh_role.js");
    const { server, prompts } = fakeServer();
    registerRole(server);
    await expect(promptOf(prompts).cb({ role: "  " })).rejects.toThrow(/role is required/);
  });
});
