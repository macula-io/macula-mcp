#!/usr/bin/env node
// macula-mcp-node-id: prints the node id (64 hex) this configuration's server uses, one line, and
// nothing else. The key is the one the server would use (MACULA_MCP_AGENT=<name> gives
// keys/agent-<name>.key, MACULA_MCP_IDENTITY pins a file), loaded or created exactly as the server
// does, so a launcher can list its agents' node ids before any of them starts (crew-code#18's
// roster). Never touches the mesh.
import { isRunDirectly } from "./run_directly.js";
import { selfNodeId } from "../macula_ts_client.js";

export async function nodeIdLine(): Promise<string> {
  return `${await selfNodeId()}\n`;
}

if (isRunDirectly(import.meta.url)) {
  nodeIdLine()
    .then((line) => process.stdout.write(line))
    .catch((e) => {
      console.error(`[macula-mcp-node-id] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
