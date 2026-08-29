// Platform detection for the installer. Used to pick MCP-client
// config paths, which vary per OS. macula-cli's own install.sh/
// install.ps1 handle platform detection for fetching that binary --
// not this installer's job.

import { platform, arch } from "node:os";

export type OS = "linux" | "darwin" | "win32";
export type Arch = "x64" | "arm64";

export interface PlatformInfo {
  os: OS;
  arch: Arch;
  /** Human-readable label used in install output. */
  label: string;
}

export function detect(): PlatformInfo {
  const rawOs = platform();
  const rawArch = arch();

  const os = mapOs(rawOs);
  const cpu = mapArch(rawArch);

  return {
    os,
    arch: cpu,
    label: `${os}-${cpu}`,
  };
}

function mapOs(p: NodeJS.Platform): OS {
  if (p === "linux") return "linux";
  if (p === "darwin") return "darwin";
  if (p === "win32") return "win32";
  throw new Error(
    `unsupported platform: ${p}. Macula supports linux, darwin, win32. ` +
      `File an issue at codeberg.org/macula-io/macula-mcp if you need ${p}.`,
  );
}

function mapArch(a: string): Arch {
  if (a === "x64") return "x64";
  if (a === "arm64") return "arm64";
  throw new Error(
    `unsupported arch: ${a}. Macula supports x64 and arm64.`,
  );
}
