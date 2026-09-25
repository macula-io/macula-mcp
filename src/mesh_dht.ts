// Tools: mesh_find_record / mesh_find_records / mesh_find_records_by_type
// — read the mesh's signed DHT record store.
//
// Point-in-time reads of what the stations' DHT holds, not a peer registry
// macula-mcp keeps. Every record returned has been verified (signature,
// signer, expiry) by the client before it reaches the tool; `dropped` says
// how many did not verify and were left out.
//
// mesh_find_records_by_type is the discovery entry point: every record of
// a type, e.g. procedure_advertisement, each advertisement's realm,
// procedure, advertiser and serving station decoded.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findRecord, findRecords, findRecordsByType, RECORD_TYPE_NAMES } from "./macula_ts_client.js";
import { describeMeshError, errorContent, jsonContent } from "./reply.js";
import { ensurePresence } from "./presence.js";
import { toolDescription } from "./tool_description.js";

const KEY_DESCRIPTION =
  "32-byte DHT storage key as hex (64 chars) -- e.g. a procedure's key, or a key already seen in a " +
  "mesh_find_records_by_type result. NOT the same as a record's own signer (key_id).";

const FIND_RECORD_DESCRIPTION_FULL =
  "Fetch one verified DHT record by its 32-byte storage key: its type, signer (key_id), times and payload, " +
  "a procedure advertisement's fields decoded. found: false when the stations hold none.";
const FIND_RECORD_DESCRIPTION_TERSE = "Fetch one verified DHT record by its 32-byte storage key.";

const FIND_RECORDS_DESCRIPTION_FULL =
  "Fetch EVERY verified record stored at a DHT key (e.g. every procedure_advertisement one procedure " +
  "has from different providers), and how many did not verify.";
const FIND_RECORDS_DESCRIPTION_TERSE = "Fetch every verified record at a DHT key, and how many did not verify.";

const FIND_RECORDS_BY_TYPE_DESCRIPTION_FULL =
  "List every verified DHT record of one type the stations hold -- the discovery entry point. Pass " +
  "record_type \"procedure_advertisement\" to see every capability on the mesh with its realm, procedure, " +
  "advertiser and serving station. Coverage is what the linked stations' DHT holds, not a census.";
const FIND_RECORDS_BY_TYPE_DESCRIPTION_TERSE =
  "List every verified DHT record of one type (discovery entry point -- try \"procedure_advertisement\"). " +
  "Coverage is the linked stations' DHT, not a census.";

export function registerMeshDht(server: McpServer): void {
  server.tool(
    "mesh_find_record",
    toolDescription(FIND_RECORD_DESCRIPTION_FULL, FIND_RECORD_DESCRIPTION_TERSE),
    { key_hex: z.string().length(64).regex(/^[0-9a-fA-F]+$/, "must be hex").describe(KEY_DESCRIPTION) },
    async ({ key_hex }) => {
      ensurePresence(server);
      try {
        const record = await findRecord({ keyHex: key_hex });
        return jsonContent({ found: record !== null, record });
      } catch (e) {
        return errorContent(describeMeshError("mesh_find_record failed", e));
      }
    },
  );

  server.tool(
    "mesh_find_records",
    toolDescription(FIND_RECORDS_DESCRIPTION_FULL, FIND_RECORDS_DESCRIPTION_TERSE),
    { key_hex: z.string().length(64).regex(/^[0-9a-fA-F]+$/, "must be hex").describe(KEY_DESCRIPTION) },
    async ({ key_hex }) => {
      ensurePresence(server);
      try {
        return jsonContent(await findRecords({ keyHex: key_hex }));
      } catch (e) {
        return errorContent(describeMeshError("mesh_find_records failed", e));
      }
    },
  );

  server.tool(
    "mesh_find_records_by_type",
    toolDescription(FIND_RECORDS_BY_TYPE_DESCRIPTION_FULL, FIND_RECORDS_BY_TYPE_DESCRIPTION_TERSE),
    { record_type: z.string().describe(`One of ${RECORD_TYPE_NAMES.map((n) => `"${n}"`).join(", ")}, or a raw type number 0-255.`) },
    async ({ record_type }) => {
      ensurePresence(server);
      try {
        return jsonContent(await findRecordsByType({ recordType: record_type }));
      } catch (e) {
        return errorContent(describeMeshError("mesh_find_records_by_type failed", e));
      }
    },
  );
}
