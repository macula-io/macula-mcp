// Tool: mesh_list_stations — a convenience composition of two existing
// primitives (mesh_find_records_by_type + mesh_call), not a new
// macula-cli subcommand or wire capability. Closes a real ergonomics
// gap: "which stations can you connect to?" was technically answerable
// via mesh_find_records_by_type(station_endpoint), or by discovering
// hecate_stations.list_stations's realm and calling it directly, but
// neither was a single obvious tool call for an agent to reach for.
//
// hecate_stations.list_stations (hecate-services/hecate-stations) is
// the one canonical, intended station-directory service in this
// ecosystem -- see its own README: "so clients never hand-maintain a
// station list." This tool hardcodes awareness of that ONE specific
// service on purpose, unlike mesh_find_records_by_type (which stays
// app-agnostic); if a second, different station-directory service ever
// exists, this tool would need to pick one or learn to merge them, not
// today's problem.
//
// Two real calls happen here, not one: the DHT lookup finds which
// realm hecate_stations is currently advertised under (never the
// default all-zero realm -- there is no way to know its realm without
// asking the DHT first), then the actual list_stations call uses it.
// If hecate_stations isn't advertised at all right now, this fails
// with a clear, specific error rather than macula-cli's own opaque
// unknown_next_peer -- found live 2026-08-31 diagnosing exactly that
// failure mode end to end (see CHANGELOG).
//
// station_endpoint/node_record fields meant to be human-readable text
// (city/continent/country/hostname/kind/version, and each entry in
// host_advertised) arrive over the wire as CBOR byte strings, not CBOR
// text -- a wire-encoding characteristic of how a service's own ad hoc
// RPC reply payload gets built, upstream of this server and not this
// server's concern to fix. macula-cli's --json renders any CBOR bytes
// as a "0x"-prefixed hex string (its own documented, deliberate
// convention, unambiguous against a real text value). Decoded back to
// plain UTF-8 here, by field name, for exactly the fields known to
// actually be text -- never node_id/id/_rev, which are genuinely
// opaque identifiers and stay hex on purpose.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { call, defaultStation, findRecordsByType } from "./macula_cli.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";
import { ensurePresence } from "./presence.js";

const LIST_STATIONS_PROCEDURE = "hecate_stations.list_stations";
const TEXT_FIELDS = ["city", "continent", "country", "hostname", "kind", "version"];

function hexDecode(value: unknown): unknown {
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) {
    try {
      return Buffer.from(value.slice(2), "hex").toString("utf8");
    } catch {
      return value;
    }
  }
  return value;
}

function decodeStation(station: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...station };
  for (const field of TEXT_FIELDS) {
    if (field in out) out[field] = hexDecode(out[field]);
  }
  if (Array.isArray(out.host_advertised)) {
    out.host_advertised = out.host_advertised.map(hexDecode);
  }
  return out;
}

export function registerMeshListStations(server: McpServer): void {
  server.tool(
    "mesh_list_stations",
    "List macula stations via hecate_stations.list_stations, the mesh's canonical station directory -- " +
      "so an agent never has to hand-maintain a station list. Auto-discovers which realm hecate_stations " +
      "is currently advertised under (never the default all-zero realm) via a DHT lookup, then calls it. " +
      "Optional near (nearest-first by great-circle distance) or continent/country/city filters, matching " +
      `the service's own filter API -- omit all filters to list every known station. Defaults to ${defaultStation()} if host isn't given.`,
    {
      near: z
        .object({
          lat: z.number(),
          lng: z.number(),
          limit: z.number().int().positive().optional(),
        })
        .optional()
        .describe("Sort nearest-first by great-circle distance from (lat, lng); limit caps the result count."),
      continent: z.string().optional().describe("Exact match, e.g. \"Europe\"."),
      country: z.string().optional().describe("Exact match, e.g. \"FR\"."),
      city: z.string().optional().describe("Exact match, e.g. \"paris\"."),
      host: z
        .string()
        .optional()
        .describe(
          `Station to connect through for both the discovery lookup and the call, "host[:port]". Defaults to ${defaultStation()}.`,
        ),
    },
    async ({ near, continent, country, city, host }) => {
      ensurePresence(server);
      try {
        const discovered = await findRecordsByType({ host, recordType: "procedure_advertisement" });
        const match = discovered.records.find(
          (r) => r.procedure_advertisement?.procedure === LIST_STATIONS_PROCEDURE,
        );
        if (!match?.procedure_advertisement?.realm) {
          return errorContent(
            `${LIST_STATIONS_PROCEDURE} is not currently advertised on the mesh (checked ${discovered.count} ` +
              `procedure_advertisement record(s) visible from ${host ?? defaultStation()}) -- hecate_stations ` +
              "may be down or unreachable from this station right now.",
          );
        }
        const res = await call({
          host,
          procedure: LIST_STATIONS_PROCEDURE,
          callArgs: { near, continent, country, city },
          realm: match.procedure_advertisement.realm,
        });
        const payload = res.payload as { stations?: Record<string, unknown>[] } | undefined;
        const stations = (payload?.stations ?? []).map(decodeStation);
        return jsonContent({ realm: match.procedure_advertisement.realm, count: stations.length, stations });
      } catch (e) {
        return errorContent(describeCliError("mesh_list_stations failed", e));
      }
    },
  );
}
