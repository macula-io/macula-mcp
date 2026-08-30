// Tools: mesh_find_record / mesh_find_records / mesh_find_records_by_type
// — read the mesh's signed DHT record store.
//
// A one-shot subprocess like every other tool here, NOT a standing peer
// registry: this reads whatever the connected station's own DHT already
// holds, point-in-time, same shape as mesh_call/mesh_get. The "no peer
// listing" line in macula_cli.ts's header comment was about macula-mcp
// itself never accumulating its own directory (the old hecate-daemon did,
// and it's gone) -- these tools accumulate nothing; the mesh already does.
//
// mesh_find_records_by_type is the discovery entry point: list every
// record of a type (e.g. procedure_advertisement, the DHT record every
// direct-dial-advertised capability publishes) currently visible from the
// connecting station. A capability's realm is embedded in its
// procedure_uri (hex(realm) + "/" + procedure, macula-go's DiscoveryURI
// convention), decoded here into procedure_advertisement.realm/.procedure
// rather than left for the caller to parse. Every record's signature is
// checked by `macula-cli` and reported as `verified`/`verify_error` --
// never treat a record with `verified: false` as trustworthy.
//
// Requires macula-cli's `dht` subcommand (added alongside these tools;
// not yet in a tagged macula-cli release as of this writing -- these
// tools will fail with an "unknown command" style error against an
// older macula-cli until one is cut and MIN_MACULA_CLI_VERSION here is
// bumped to match).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultStation, findRecord, findRecords, findRecordsByType } from "./macula_cli.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";

const KEY_DESCRIPTION =
  "32-byte DHT storage key as hex (64 chars) -- e.g. from ProcedureKey(procedure_uri) " +
  "on the publishing side, or a key already seen in a mesh_find_records_by_type result. " +
  "This is NOT the same as a record's own advertiser/signer key.";

export function registerMeshDht(server: McpServer): void {
  server.tool(
    "mesh_find_record",
    "Fetch one DHT record by its 32-byte storage key. Always the DHT's own all-zero realm " +
      `(no realm parameter -- DHT storage is protocol-internal). Defaults to ${defaultStation()} if host isn't given.`,
    {
      key_hex: z.string().length(64).regex(/^[0-9a-fA-F]+$/, "must be hex").describe(KEY_DESCRIPTION),
      host: z
        .string()
        .optional()
        .describe(`Station to connect through, "host[:port]". Defaults to ${defaultStation()}.`),
    },
    async ({ key_hex, host }) => {
      try {
        const res = await findRecord({ host, keyHex: key_hex });
        return jsonContent({ host: res.host, found: res.found, record: res.record });
      } catch (e) {
        return errorContent(describeCliError("mesh_find_record failed", e));
      }
    },
  );

  server.tool(
    "mesh_find_records",
    "Fetch EVERY record stored at a DHT key -- the full signer-deduped multiset (e.g. every " +
      "procedure_advertisement one procedure has from different providers). Always the DHT's own " +
      `all-zero realm. Defaults to ${defaultStation()} if host isn't given.`,
    {
      key_hex: z.string().length(64).regex(/^[0-9a-fA-F]+$/, "must be hex").describe(KEY_DESCRIPTION),
      host: z
        .string()
        .optional()
        .describe(`Station to connect through, "host[:port]". Defaults to ${defaultStation()}.`),
    },
    async ({ key_hex, host }) => {
      try {
        const res = await findRecords({ host, keyHex: key_hex });
        return jsonContent({ host: res.host, count: res.count, records: res.records });
      } catch (e) {
        return errorContent(describeCliError("mesh_find_records failed", e));
      }
    },
  );

  server.tool(
    "mesh_find_records_by_type",
    "List every DHT record of one type currently visible from the connecting station -- the " +
      "discovery entry point. Pass record_type \"procedure_advertisement\" to see every capability " +
      "this station knows about (each record's realm and plain procedure name decoded out of its " +
      "procedure_uri). Coverage depends on that station's own view of the DHT, not the whole mesh. " +
      `Always the DHT's own all-zero realm. Defaults to ${defaultStation()} if host isn't given.`,
    {
      record_type: z
        .string()
        .describe(
          "\"procedure_advertisement\", \"content_announcement\", \"station_endpoint\", or a raw " +
            "type number 0-255.",
        ),
      host: z
        .string()
        .optional()
        .describe(`Station to connect through, "host[:port]". Defaults to ${defaultStation()}.`),
    },
    async ({ record_type, host }) => {
      try {
        const res = await findRecordsByType({ host, recordType: record_type });
        return jsonContent({ host: res.host, type: res.type, count: res.count, records: res.records });
      } catch (e) {
        return errorContent(describeCliError("mesh_find_records_by_type failed", e));
      }
    },
  );
}
