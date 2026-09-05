// Tool: mesh_publish — emit an integration fact to a mesh topic.
//
// One-shot: connects, publishes, exits (macula_ts_client.ts's publish(),
// via @macula-io/ts's Session.publish). No delivery confirmation beyond
// the wire send succeeding -- PUBLISH has no ack on this protocol -- and
// no accountable event/fact_id anymore, since that was hecate-daemon's
// own ReckonDB-backed audit trail, dropped along with the daemon itself.
// No `seq` in the result either -- @macula-io/ts's Session.publish
// doesn't surface one (a real, known gap vs. the old macula-cli-backed
// version, see CHANGELOG.md/README.md).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultIdentityPath, defaultStation } from "./mesh_config.js";
import { publish } from "./macula_ts_client.js";
import { describeCliError, errorContent, jsonContent } from "./reply.js";
import { ensurePresence } from "./presence.js";
import { assertNoLikelySecret } from "./secret_scan.js";

export function registerMeshPublish(server: McpServer): void {
  server.tool(
    "mesh_publish",
    "Publish an integration fact to a mesh topic so other parties' agents can react. " +
      "Use a business verb for the fact type (e.g. 'module_generated', 'capability_announced'), " +
      `never CRUD. Returns the topic and duration_ms. Defaults to ${defaultStation()} if host isn't given.`,
    {
      topic: z.string().describe("Topic name (e.g. 'agents.module_generated')."),
      fact: z.record(z.string(), z.unknown()).describe("The integration fact payload (plain JSON; this server encodes the wire)."),
      host: z
        .string()
        .optional()
        .describe(`Station to connect through, "host[:port]". Defaults to ${defaultStation()}.`),
      realm: z
        .string()
        .length(64)
        .regex(/^[0-9a-fA-F]+$/, "must be hex")
        .optional()
        .describe(
          "32-byte realm as hex (64 chars) the topic is scoped to. Omit for the default all-zero realm. " +
            "See mesh_call's realm description for the full rationale.",
        ),
    },
    async ({ topic, fact, host, realm }) => {
      ensurePresence(server);
      try {
        assertNoLikelySecret(fact, "fact");
        const res = await publish({ host, topic, fact, realm, identityPath: defaultIdentityPath() });
        return jsonContent({ topic: res.topic, duration_ms: res.duration_ms });
      } catch (e) {
        return errorContent(describeCliError("mesh_publish failed", e));
      }
    },
  );
}
