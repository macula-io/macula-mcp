// Tool: mesh_list_stations — a convenience composition of two existing
// primitives (mesh_find_records_by_type + mesh_call), not a new wire
// capability. "Which stations can you connect to?" is answerable via
// mesh_find_records_by_type(station_endpoint), or by discovering
// mcl-stations/list_stations's realm and calling it directly, but neither
// is a single obvious tool call for an agent to reach for.
//
// mcl-stations/list_stations (macula-services/mcl-stations) is the mesh's
// station directory, so clients never hand-maintain a station list. This
// tool hardcodes awareness of that ONE service on purpose, unlike
// mesh_find_records_by_type, which stays app-agnostic.
//
// Two calls happen here, not one: the DHT lookup finds which realm
// mcl-stations is currently advertised under (never the default all-zero
// realm; there is no way to know it without asking the DHT first), then
// list_stations is called in it. The advertisement's `procedure' is the
// org-namespaced name the provider advertised, `mcl-stations/list_stations'
// (mcl_om advertises `Org/Name'). If nothing advertises it, this fails with
// a clear, specific error rather than an opaque unknown_next_peer.
//
// The reply is `{stations: [Row]}`. mcl-stations sends every text field as
// CBOR text, so they arrive as plain strings and are passed through as-is.
// `node_id' is the station's 32-byte key id, CBOR bytes, which @macula-io/ts
// renders as "0x"-prefixed hex; it is given back as the plain 64-hex every
// other tool here takes.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
// Both the DHT lookup (all-zero realm) and the actual list_stations call
// go through @macula-io/ts now -- realm support on Session.call (landed
// in @macula-io/ts 0.12.0) closed the one gap that used to force the
// second half onto a macula-cli subprocess. See README.md/CHANGELOG.md.
import { defaultIdentityPath, defaultStation } from "./mesh_config.js";
import { call, findRecordsByType } from "./macula_ts_client.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";
import { ensurePresence } from "./presence.js";
import { toolDescription } from "./tool_description.js";

const LIST_STATIONS_PROCEDURE = "mcl-stations/list_stations";

/** A station row with its node_id as plain 64-hex; every other field passes through. */
function withPlainNodeId(station: Record<string, unknown>): Record<string, unknown> {
  const nodeId = station.node_id;
  if (typeof nodeId === "string" && /^0x[0-9a-fA-F]{64}$/.test(nodeId)) {
    return { ...station, node_id: nodeId.slice(2).toLowerCase() };
  }
  return station;
}

const DESCRIPTION_FULL =
  "List macula stations via mcl-stations/list_stations, the mesh's canonical station directory -- " +
  "so an agent never has to hand-maintain a station list. Auto-discovers which realm mcl-stations " +
  "is currently advertised under (never the default all-zero realm) via a DHT lookup, then calls it. " +
  "Optional near (nearest-first by great-circle distance) or continent/country/city filters, matching " +
  `the service's own filter API -- omit all filters to list every known station. Defaults to ${defaultStation()} if host isn't given.`;
/** MACULA_MCP_TERSE_TOOLS=1 variant -- see tool_description.ts. */
const DESCRIPTION_TERSE = `List macula stations via mcl-stations/list_stations (auto-discovers its realm via DHT). Optional near/continent/country/city filters -- omit all to list everything. Defaults to ${defaultStation()} if host isn't given.`;

export function registerMeshListStations(server: McpServer): void {
  server.tool(
    "mesh_list_stations",
    toolDescription(DESCRIPTION_FULL, DESCRIPTION_TERSE),
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
        const discovered = await findRecordsByType({
          host,
          recordType: "procedure_advertisement",
          identityPath: defaultIdentityPath(),
        });
        const match = discovered.records.find(
          (r) => r.procedure_advertisement?.procedure === LIST_STATIONS_PROCEDURE,
        );
        if (!match?.procedure_advertisement?.realm) {
          return errorContent(
            `${LIST_STATIONS_PROCEDURE} is not currently advertised on the mesh (checked ${discovered.count} ` +
              `procedure_advertisement record(s) visible from ${host ?? defaultStation()}) -- mcl-stations ` +
              "may be down or unreachable from this station right now.",
          );
        }
        const res = await call({
          host,
          procedure: LIST_STATIONS_PROCEDURE,
          callArgs: { near, continent, country, city },
          realm: match.procedure_advertisement.realm,
          identityPath: defaultIdentityPath(),
        });
        const payload = res.payload as { stations?: Record<string, unknown>[] } | undefined;
        const stations = (payload?.stations ?? []).map(withPlainNodeId);
        return jsonContent({ realm: match.procedure_advertisement.realm, count: stations.length, stations });
      } catch (e) {
        return errorContent(describeCliError("mesh_list_stations failed", e));
      }
    },
  );
}
