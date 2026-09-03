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
// This module calls ensurePresence(server) at its own entry point too
// (2026-08-31, same as every other genuinely mesh-touching tool -- see
// presence.ts) -- an agent that recalls or remembers something is
// present the same way one that calls or publishes is. What is
// deliberately NOT automatic is the OTHER direction: mesh_recall/
// mesh_remember themselves never fire on their own the way presence
// does. Presence's auto-trigger works because "should this agent be
// online" has one unconditional answer the moment it touches the mesh
// at all. Memory has no such unconditional trigger on either side -- a
// read needs a QUERY (context this server never has access to, only
// the calling agent does), and a write needs AUTHORED CONTENT (same
// reason: this server sees tool args/results, never the model's own
// reasoning or the human's messages, so it cannot generate "what's
// worth remembering" itself). Both stay tools an agent calls
// deliberately -- these two just remove the "which realm is hecate-rag
// on" step, the same ergonomics gap mesh_list_stations already closed
// for stations.
//
// mesh_remember calls hecate-rag's add_knowledge -- one mesh RPC, not
// two. It used to sequence ingest_document then embed_document by hand
// (the "two steps become one" bar mesh_say's own
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

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
// Same hybrid as mesh_stations.ts and for the identical reason: hecate-rag
// is ALWAYS called under a discovered non-zero realm, which @macula-io/ts's
// call() does not support yet -- the DHT discovery half (all-zero realm)
// uses macula-ts, the actual realm-scoped call stays on macula-cli.
import { call, defaultIdentityPath, defaultStation } from "./macula_cli.js";
import { findRecordsByType } from "./macula_ts_client.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";
import { ensurePresence } from "./presence.js";

const SEARCH_PROCEDURE = "hecate-rag.answer_query";
const ADD_KNOWLEDGE_PROCEDURE = "hecate-rag.add_knowledge";
const UPLOAD_KNOWLEDGE_PROCEDURE = "hecate-rag.upload_knowledge";

/** Discovers which realm hecate-rag is CURRENTLY advertised under -- never the all-zero default, matching mesh_list_stations's own reasoning. */
async function discoverHecateRagRealm(host: string | undefined): Promise<{ realm: string } | { error: string }> {
  const discovered = await findRecordsByType({
    host,
    recordType: "procedure_advertisement",
    identityPath: defaultIdentityPath(),
  });
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

export const DEFAULT_INCLUDE_EXTENSIONS = [".md", ".mdx", ".txt"];
export const DEFAULT_EXCLUDE_DIRS = [".git", "node_modules", "_build", "_build_resolved", "_checkouts", "dist", "target", ".next", "vendor"];
const SOURCE_TYPE_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown",
  ".mdx": "text/markdown",
  ".txt": "text/plain",
};

/** Exported for tests only -- registerMeshMemory is the real entry point. */
export function sourceTypeFor(ext: string): string {
  return SOURCE_TYPE_BY_EXTENSION[ext] ?? "text/plain";
}

/**
 * Stable, deterministic id from a file's relative path -- re-running
 * mesh_remember_directory on the same directory upserts the same
 * documents instead of duplicating them (rag_store:upsert_source is a
 * real upsert, keyed on document_id). Exported for tests only.
 */
export function documentIdFor(relativePath: string): string {
  return createHash("sha256").update(relativePath).digest("hex").slice(0, 16);
}

/** Exported for tests only. */
export function isExcluded(relativePath: string, excludeDirs: string[]): boolean {
  return relativePath.split(sep).some((segment) => excludeDirs.includes(segment));
}

function isDirectoryError(e: unknown): boolean {
  return e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "EISDIR";
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
      "the same caveat mesh_say and mesh_open_room already carry. Don't deposit anything " +
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

  server.tool(
    "mesh_remember_directory",
    "Recursively ingest every matching file under a LOCAL directory into the mesh's shared memory " +
      "(hecate-rag), one hecate-rag.upload_knowledge call per file -- for real documents (a corpus, a " +
      "set of notes), not conversational snippets (use mesh_remember for those). Each file's content " +
      "travels in its own mesh call, so this works regardless of where hecate-rag is physically running " +
      "-- it does NOT ask hecate-rag to read from its own filesystem (hecate-rag's seed_corpus does that, " +
      "and isn't reachable over the mesh at all). document_id is derived deterministically from each " +
      "file's relative path, so re-running this on the same directory updates existing documents instead " +
      "of duplicating them. Binary or undecodable files are skipped, not treated as errors. Processes " +
      "files sequentially, one mesh call at a time -- a large directory will take a while; the response " +
      "is a summary (counts + any per-file failures), not a per-file log.",
    {
      directory: z.string().describe("Local directory to walk, recursively. Must exist and be readable."),
      include_extensions: z
        .array(z.string())
        .optional()
        .describe(`File extensions to ingest, e.g. [".md", ".ts"]. Defaults to ${JSON.stringify(DEFAULT_INCLUDE_EXTENSIONS)}.`),
      exclude_dirs: z
        .array(z.string())
        .optional()
        .describe(`Directory names to skip anywhere in the tree. Defaults to ${JSON.stringify(DEFAULT_EXCLUDE_DIRS)}.`),
      source_prefix: z.string().optional().describe('Prepended to each file\'s relative path for source_path, e.g. "hecate-corpus".'),
      host: z
        .string()
        .optional()
        .describe(`Station to connect through for both the discovery lookup and every call, "host[:port]". Defaults to ${defaultStation()}.`),
    },
    async ({ directory, include_extensions, exclude_dirs, source_prefix, host }) => {
      ensurePresence(server);
      const includeExt = include_extensions ?? DEFAULT_INCLUDE_EXTENSIONS;
      const excludeDirs = exclude_dirs ?? DEFAULT_EXCLUDE_DIRS;

      let relativePaths: string[];
      try {
        relativePaths = await readdir(directory, { recursive: true });
      } catch (e) {
        return errorContent(`could not read directory ${directory}: ${e instanceof Error ? e.message : String(e)}`);
      }

      const discovery = await discoverHecateRagRealm(host);
      if ("error" in discovery) return errorContent(discovery.error);

      const ingested: { path: string; document_id: string; chunks: number }[] = [];
      const skipped: { path: string; reason: string }[] = [];
      const failed: { path: string; error: string }[] = [];

      for (const rel of relativePaths) {
        if (isExcluded(rel, excludeDirs)) continue;
        const ext = extname(rel);
        if (!includeExt.includes(ext)) continue;

        let content: string;
        try {
          content = await readFile(join(directory, rel), "utf8");
        } catch (e) {
          if (isDirectoryError(e)) continue; // a directory that happens to end in a matching extension
          skipped.push({ path: rel, reason: `unreadable or not valid UTF-8: ${e instanceof Error ? e.message : String(e)}` });
          continue;
        }
        if (content.trim().length === 0) {
          skipped.push({ path: rel, reason: "empty file" });
          continue;
        }

        const documentId = documentIdFor(rel);
        const sourcePath = source_prefix ? `${source_prefix}/${rel}` : rel;
        try {
          const res = await call({
            host,
            procedure: UPLOAD_KNOWLEDGE_PROCEDURE,
            callArgs: { document_id: documentId, source_path: sourcePath, source_type: sourceTypeFor(ext), raw_bytes: content },
            realm: discovery.realm,
          });
          const payload = res.payload as { chunks?: number } | undefined;
          ingested.push({ path: rel, document_id: documentId, chunks: payload?.chunks ?? 0 });
        } catch (e) {
          failed.push({ path: rel, error: describeCliError("upload_knowledge failed", e) });
        }
      }

      return jsonContent({
        realm: discovery.realm,
        directory,
        ingested_count: ingested.length,
        skipped_count: skipped.length,
        failed_count: failed.length,
        total_chunks: ingested.reduce((sum, r) => sum + r.chunks, 0),
        skipped,
        failed,
      });
    },
  );
}
