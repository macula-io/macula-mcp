import { isAbsolute, join } from "node:path";

const PATH_VARIABLES = [
  "MACULA_MCP_IDENTITY",
  "MACULA_MCP_RINGS_DB",
  "MACULA_MCP_ROSTER_DB",
  "MACULA_MCP_LOBBY_TRANSCRIPT_DB",
  "MACULA_MCP_REALM_DIR",
  "MACULA_MCP_CONTACT_POLICY_FILE",
  "MACULA_MCP_BANNER_FILE",
] as const;

/** Expand a configured home prefix without treating other paths as shell expressions. */
export function configuredPath(name: string, value: string): string {
  const prefix = /^(~|\$HOME)(?=$|[\\/])/.exec(value);
  if (!prefix) {
    if (value.startsWith("~")) throw new Error(`${name}: unsupported home path`);
    return value;
  }
  const home = process.env.HOME;
  if (!home || !isAbsolute(home)) throw new Error(`${name}: HOME must be an absolute path`);
  const rest = value.slice(prefix[0].length).replace(/^[\\/]+/, "");
  return rest ? join(home, rest) : home;
}

/** Reject unusable home prefixes before the server opens any configured file. */
export function validateConfiguredPaths(): void {
  for (const name of PATH_VARIABLES) {
    const value = process.env[name];
    if (value !== undefined) configuredPath(name, value);
  }
}
