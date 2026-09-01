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
// mesh_remember calls hecate-rag's add_knowledge -- one mesh RPC, not
// two. It used to sequence ingest_document then embed_document by hand
// (the "two steps become one" bar mesh_send_chat's own
// wait_reply_seconds already established), but add_knowledge (added to
// hecate-rag the same day this file was first written) does that
// server-side AND fixes the short-text gap the old path had: content
// under ~80 chars used to produce `chunks: 0` because the chunker skips
// anything that short; add_knowledge falls back to a single raw chunk
// instead, which is exactly the "a paragraph or two" case a
// conversational deposit usually is.
//
// This is a real interface change, not just a backend swap:
// add_knowledge has no document_id (it derives its own chunk ids from a
// hash of source_label+text) and no source_type -- both dropped rather
// than faked, since nothing on the other end reads them anymore.
// source_label replaces source_path: a flat grouping label, not a
// hierarchical path, matching what the wire field actually is.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { call, defaultStation, findRecordsByType } from "./macula_cli.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";
import { ensurePresence } from "./presence.js";

const SEARCH_PROCEDURE = "hecate-rag.answer_query";
const ADD_KNOWLEDGE_PROCEDURE = "hecate-rag.add_knowledge";

/** Discovers which realm hecate-rag is CURRENTLY advertised under -- never the all-zero default, matching mesh_list_stations's own reasoning. */
async function discoverHecateRagRealm(host: string | undefined): Promise<{ realm: string } | { error: string }> {
  const discovered = await findRecordsByType({ host, recordType: "procedure_advertisement" });
  const match = discovered.records.find(
    (r) => r.procedure_advertisement?.procedure === ADD_KNOWLEDGE_PROCEDURE,
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
    "Deposit something worth remembering into the mesh's shared memory (hecate-rag) -- one mesh RPC " +
      "(add_knowledge), so it becomes searchable via mesh_recall for any agent, not just you, in future " +
      "sessions. Short deposits (a sentence or two) are fine -- unlike raw document ingestion, this is " +
      "designed for conversational snippets and won't silently produce zero chunks. Be deliberate about " +
      "what you write here: this is shared, not private to you, and this mesh doesn't encrypt payloads -- " +
      "the same caveat mesh_send_chat and mesh_open_lobby_session already carry. Don't deposit anything " +
      "you wouldn't want another agent or operator reading.",
    {
      content: z.string().describe("The text to remember, in your own words. Markdown is fine -- header-aware chunking splits it if long."),
      source_label: z.string().optional().describe("Grouping/attribution label, e.g. \"agent-notes/macula-mcp-presence\". Defaults to \"conversational\" if omitted."),
      topics: z.array(z.string()).optional().describe("Topic labels to tag this deposit with, for later topic-filtered search."),
      host: z
        .string()
        .optional()
        .describe(`Station to connect through for both the discovery lookup and the call, "host[:port]". Defaults to ${defaultStation()}.`),
    },
    async ({ content, source_label, topics, host }) => {
      ensurePresence(server);
      try {
        const discovery = await discoverHecateRagRealm(host);
        if ("error" in discovery) return errorContent(discovery.error);

        const res = await call({
          host,
          procedure: ADD_KNOWLEDGE_PROCEDURE,
          callArgs: { text: content, source_label, topics },
          realm: discovery.realm,
        });
        const payload = res.payload as { chunks?: number } | undefined;
        return jsonContent({
          realm: discovery.realm,
          source_label: source_label ?? "conversational",
          chunks: payload?.chunks ?? 0,
        });
      } catch (e) {
        return errorContent(describeCliError("mesh_remember failed", e));
      }
    },
  );
}
