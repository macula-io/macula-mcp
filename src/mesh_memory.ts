// Tools: mesh_recall / mesh_remember — a convenience composition over
// hecate-rag (hecate-services/hecate-rag), the mesh's realm-bound RAG
// service, on the exact same template mesh_stations.ts already
// established for hecate_stations: discover which realm the service
// is CURRENTLY advertised under (a DHT lookup -- never assume the
// all-zero default), then call it. This tool hardcodes awareness of
// that ONE specific service on purpose, unlike mesh_find_records_by_type
// (which stays app-agnostic) -- if a second, different memory/RAG
// service ever exists, this tool would need to pick one or learn to
// merge them, not today's problem. Generic verb names on purpose too
// (mesh_recall/mesh_remember, not mesh_rag_search/mesh_rag_ingest) --
// "this happens to be hecate-rag today" is an implementation detail,
// the same way mesh_list_stations hides "this happens to be
// hecate_stations today" behind its own name.
//
// Deliberately NOT wired into presence/ensurePresence's automatic
// start the way the mesh-touching tools were: presence's auto-trigger
// works because "should this agent be online" has one unconditional
// answer the moment it touches the mesh at all. Memory has no such
// unconditional trigger on either side -- a read needs a QUERY
// (context this server never has access to, only the calling agent
// does), and a write needs AUTHORED CONTENT (same reason: this server
// sees tool args/results, never the model's own reasoning or the
// human's messages, so it cannot generate "what's worth remembering"
// itself). Both stay tools an agent calls deliberately -- these two
// just remove the "which realm is hecate-rag on" step, the same
// ergonomics gap mesh_list_stations already closed for stations.
//
// mesh_remember composes TWO real calls (ingest_document, then
// embed_document) into one, the same "two steps become one" bar
// mesh_send_chat's own wait_reply_seconds already established --
// depositing a memory shouldn't require an agent to sequence two
// separate tool calls by hand. document_id is only auto-generated
// when the caller omits one (a random id has no unguessability
// requirement the way the lobby's session_topic does, so a caller
// wanting a stable, memorable id -- e.g. "session-2026-08-31-topic"
// -- can still supply one; nothing here forces randomness on them).
//
// Found live building/verifying hecate-rag this same session: content
// under ~80 chars produces `chunks: 0`, not an error -- barrel's own
// minimum-chunk-size filter, not a bug. mesh_remember surfaces that
// plainly rather than treating it as a failure.

import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { call, defaultStation, findRecordsByType } from "./macula_cli.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";
import { ensurePresence } from "./presence.js";

const SEARCH_PROCEDURE = "hecate-rag.answer_query";
const INGEST_PROCEDURE = "hecate-rag.ingest_document";
const EMBED_PROCEDURE = "hecate-rag.embed_document";

/** Discovers which realm hecate-rag is CURRENTLY advertised under -- never the all-zero default, matching mesh_list_stations's own reasoning. */
async function discoverHecateRagRealm(host: string | undefined): Promise<{ realm: string } | { error: string }> {
  const discovered = await findRecordsByType({ host, recordType: "procedure_advertisement" });
  const match = discovered.records.find(
    (r) => r.procedure_advertisement?.procedure === INGEST_PROCEDURE,
  );
  if (!match?.procedure_advertisement?.realm) {
    return {
      error:
        `hecate-rag is not currently advertised on the mesh (checked ${discovered.count} ` +
        `procedure_advertisement record(s) visible from ${host ?? defaultStation()}) -- it may not be ` +
        "deployed, or is unreachable from this station right now.",
    };
  }
  return { realm: match.procedure_advertisement.realm };
}

export function registerMeshMemory(server: McpServer): void {
  server.tool(
    "mesh_recall",
    "Query the mesh's shared memory (hecate-rag, a realm-bound RAG service) for anything relevant to " +
      "query_text -- semantic retrieval, not keyword match. Auto-discovers which realm hecate-rag is " +
      "currently advertised under, then calls its answer_query capability. Returns whatever chunks other " +
      "agents (or you, earlier) deposited via mesh_remember that are semantically close to the query, " +
      "each with a similarity score, source_path, and chunk metadata. Empty results mean nothing relevant " +
      "has been deposited yet, not an error. Not automatic -- call this deliberately when you actually " +
      "want to check shared memory, e.g. early in a session working on a repo others may have touched.",
    {
      query_text: z.string().describe("What to search for, in natural language."),
      top_k: z.number().int().positive().max(100).optional().describe("Max results (default 10)."),
      host: z
        .string()
        .optional()
        .describe(`Station to connect through for both the discovery lookup and the call, "host[:port]". Defaults to ${defaultStation()}.`),
    },
    async ({ query_text, top_k, host }) => {
      ensurePresence(server);
      try {
        const discovery = await discoverHecateRagRealm(host);
        if ("error" in discovery) return errorContent(discovery.error);
        const res = await call({
          host,
          procedure: SEARCH_PROCEDURE,
          callArgs: { query_text, top_k },
          realm: discovery.realm,
        });
        const payload = res.payload as { hits?: unknown[] } | undefined;
        return jsonContent({ realm: discovery.realm, hits: payload?.hits ?? [] });
      } catch (e) {
        return errorContent(describeCliError("mesh_recall failed", e));
      }
    },
  );

  server.tool(
    "mesh_remember",
    "Deposit something worth remembering into the mesh's shared memory (hecate-rag) -- ingests and embeds " +
      "content in one call (two mesh RPCs sequenced for you: ingest_document then embed_document), so it " +
      "becomes searchable via mesh_recall for any agent, not just you, in future sessions. document_id is " +
      "auto-generated if you omit one; supply your own if you want a stable, memorable id (e.g. " +
      "\"session-2026-08-31-topic\") instead of a random one. Content under ~80 characters produces " +
      "chunks: 0 -- too short to index, not an error. Be deliberate about what you write here: this is " +
      "shared, not private to you, and this mesh doesn't encrypt payloads -- the same caveat mesh_send_chat " +
      "and mesh_open_lobby_session already carry. Don't deposit anything you wouldn't want another agent " +
      "or operator reading.",
    {
      content: z.string().describe("The text to remember, in your own words. Markdown is fine -- header-aware chunking splits on it."),
      document_id: z.string().optional().describe("Stable id for this memory. Auto-generated (random) if omitted."),
      source_path: z.string().optional().describe("Attribution/grouping path, e.g. \"agent-notes/macula-mcp-presence.md\". Auto-generated if omitted."),
      source_type: z.string().optional().describe("MIME-ish type, default \"text/markdown\"."),
      host: z
        .string()
        .optional()
        .describe(`Station to connect through for both the discovery lookup and the calls, "host[:port]". Defaults to ${defaultStation()}.`),
    },
    async ({ content, document_id, source_path, source_type, host }) => {
      ensurePresence(server);
      try {
        const discovery = await discoverHecateRagRealm(host);
        if ("error" in discovery) return errorContent(discovery.error);
        const docId = document_id ?? `mesh-remember-${Date.now()}-${randomBytes(4).toString("hex")}`;
        const srcPath = source_path ?? `mesh-memory/${docId}.md`;
        const srcType = source_type ?? "text/markdown";

        await call({
          host,
          procedure: INGEST_PROCEDURE,
          callArgs: { document_id: docId, source_path: srcPath, source_type: srcType, raw_bytes: content },
          realm: discovery.realm,
        });
        const embedRes = await call({
          host,
          procedure: EMBED_PROCEDURE,
          callArgs: { document_id: docId },
          realm: discovery.realm,
        });
        const payload = embedRes.payload as { chunks?: number } | undefined;
        return jsonContent({
          realm: discovery.realm,
          document_id: docId,
          source_path: srcPath,
          chunks: payload?.chunks ?? 0,
        });
      } catch (e) {
        return errorContent(describeCliError("mesh_remember failed", e));
      }
    },
  );
}
