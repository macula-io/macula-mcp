// Prompts: role -- load a role's system-prompt body VERBATIM from the shared
// mesh corpus: a HUMAN's /mcp__macula__role devops injects that role's exact
// file, fetched live through mcl-rag's get_document_verbatim, not pasted from
// a local file and not a semantic approximation (that's mesh_recall's job).
//
// Unlike the static help prompts in mesh_help.ts, this one does real mesh
// I/O: it discovers which realm mcl-rag is advertised in (a DHT lookup, as
// mesh_recall does -- never assume a realm), then fetches the file. So it
// calls ensurePresence(server) at its own entry, the same way every
// genuinely mesh-touching entry here does (see presence.ts), and it carries
// an argument schema.
//
// `role` is REQUIRED on purpose. A prompt whose arguments are all optional
// trips the SDK's request parsing on a bare invocation (the bug mesh_help.ts
// documents); a required argument cannot be the all-optional case, and
// /mcp__macula__role devops always carries the one value this prompt needs.
//
// Role files live in the mcl-corpus repo of the shared corpus, under roles/;
// get_document_verbatim takes "<repo-id>/<relative-path>".

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { call, discoverProcedureRealm } from "./connect_to_mesh.js";
import { MeshError } from "./mesh_config.js";
import { describeMeshError } from "./reply.js";
import { ensurePresence } from "./be_present/presence.js";

const VERBATIM_PROCEDURE = "mcl-rag/get_document_verbatim";
const ROLE_PATH_PREFIX = "mcl-corpus/roles/";

/** The corpus path mcl-rag's get_document_verbatim takes for a role: `mcl-corpus/roles/<name>.md`. */
export function roleSourcePath(role: string): string {
  return `${ROLE_PATH_PREFIX}${role.trim()}.md`;
}

/** The reply's document bytes as text: raw_bytes arrives tagged (`{"$bytes": base64}`). */
function documentText(payload: unknown): string | undefined {
  const tagged = (payload as { raw_bytes?: { $bytes?: unknown } } | null)?.raw_bytes?.$bytes;
  return typeof tagged === "string" ? Buffer.from(tagged, "base64").toString("utf8") : undefined;
}

export function registerRole(server: McpServer): void {
  server.registerPrompt(
    "role",
    {
      description:
        "Load a role's system-prompt body verbatim from the shared mesh corpus " +
        "(mcl-corpus/roles/<role>.md, fetched live via mcl-rag), so a person can adopt that role in this conversation.",
      argsSchema: { role: z.string().describe("Role name, e.g. devops") },
    },
    async ({ role }) => {
      ensurePresence(server);
      const name = role.trim();
      if (name === "") throw new Error("role is required: pass a role name, e.g. /mcp__macula__role devops");
      const sourcePath = roleSourcePath(name);

      let realm: string;
      try {
        realm = await discoverProcedureRealm(VERBATIM_PROCEDURE);
      } catch (e) {
        throw new Error(`mcl-rag cannot be reached: ${e instanceof Error ? e.message : String(e)}`);
      }

      let payload: unknown;
      try {
        ({ payload } = await call({
          procedure: VERBATIM_PROCEDURE,
          callArgs: { source_path: sourcePath },
          realm,
          bytes: "tagged",
        }));
      } catch (e) {
        if (e instanceof MeshError && e.code === "handler_error" && e.message.includes("not_found")) {
          throw new Error(`unknown role "${name}": the shared corpus has no ${sourcePath}`);
        }
        throw new Error(describeMeshError(`could not load role "${name}"`, e));
      }

      const text = documentText(payload);
      if (text === undefined) throw new Error(`could not load role "${name}": the reply carried no document bytes`);
      return { messages: [{ role: "user", content: { type: "text", text } }] };
    },
  );
}
