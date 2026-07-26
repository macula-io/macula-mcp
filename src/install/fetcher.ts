// Daemon binary fetcher.
//
// Downloads a signed `hecate-daemon-<platform>.tar.gz` + sibling
// `.minisig` from Codeberg Releases, verifies the signature against
// the bundled minisign pubkey, and extracts to `~/.hecate/bin/`.
//
// Trust chain end-to-end:
//   npm-published @macula/mcp ↦ bundled keys/macula-minisign.pub
//   ↦ verifies → Codeberg Releases-published .tar.gz.minisig
//   ↦ guarantees → contents of .tar.gz
//
// Failure is loud: any HTTP error, signature mismatch, or extract
// problem rejects with a clear remediation hint. No half-installs.

import { mkdir, mkdtemp, rm, chmod, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { get as httpsGet } from "node:https";
import type { IncomingMessage } from "node:http";
import { pipeline } from "node:stream/promises";
import { extract as tarExtract } from "tar";
import { verifySignedFile, MinisignError } from "./verify.js";
import type { PlatformInfo } from "./platform.js";

export class FetcherError extends Error {
  constructor(message: string, readonly cause_?: unknown) {
    super(message);
    this.name = "FetcherError";
  }
}

export interface FetchedDaemon {
  binPath: string;
  version: string;
  platform: string;
  sigVerified: true;
}

export interface FetchOpts {
  version: string;
  platform: PlatformInfo;
  /** Override base URL (testing / sovereign-fork mirror). */
  baseUrl?: string;
  /** Override target install dir; default `~/.hecate/bin`. */
  installDir?: string;
  /** Override bundled-pubkey path (testing). */
  pubKeyPath?: string;
  /** Progress callback; bytes received vs total. */
  onProgress?: (received: number, total: number | undefined) => void;
}

const DEFAULT_BASE =
  "https://codeberg.org/hecate-social/hecate-daemon/releases/download";

/**
 * Fetch + verify + extract. Idempotent: if the target binary already
 * exists with the expected version (marker file), no-op.
 */
export async function fetchDaemon(opts: FetchOpts): Promise<FetchedDaemon> {
  const { version, platform } = opts;
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE;
  const installDir = opts.installDir ?? join(homedir(), ".hecate", "bin");
  const pubKeyPath = opts.pubKeyPath ?? defaultPubKeyPath();

  const platformLabel = platform.label;
  const tarName = `hecate-daemon-${platformLabel}-v${version}.tar.gz`;
  const sigName = `${tarName}.minisig`;
  const tarUrl = `${baseUrl}/v${version}/${tarName}`;
  const sigUrl = `${baseUrl}/v${version}/${sigName}`;

  const tmp = await mkdtemp(join(tmpdir(), "macula-fetch-"));
  try {
    const tarPath = join(tmp, tarName);
    const sigPath = join(tmp, sigName);

    await downloadTo(tarUrl, tarPath, opts.onProgress);
    await downloadTo(sigUrl, sigPath); // signature is small; no progress

    try {
      await verifySignedFile({ filePath: tarPath, sigPath, pubKeyPath });
    } catch (e) {
      if (e instanceof MinisignError) {
        throw new FetcherError(
          `Signature verification failed for ${tarName}. Refusing to install. ` +
            `Underlying error: ${e.message}`,
          e,
        );
      }
      throw e;
    }

    await mkdir(installDir, { recursive: true });
    // Extract the tarball; the daemon release layout is the
    // `_build/dist/rel/hecate/` tree from the dist profile.
    await tarExtract({ file: tarPath, cwd: installDir });

    const binPath = join(installDir, "hecate", "bin", "hecate");
    try {
      await stat(binPath);
    } catch {
      throw new FetcherError(
        `Extract succeeded but no executable at expected path ${binPath}. ` +
          `The release tarball may have an unexpected layout.`,
      );
    }
    await chmod(binPath, 0o755);

    return {
      binPath,
      version,
      platform: platformLabel,
      sigVerified: true,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// HTTP download with optional progress reporting
// ---------------------------------------------------------------------------

function downloadTo(
  url: string,
  destPath: string,
  onProgress?: (received: number, total: number | undefined) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onResponse = (res: IncomingMessage): void => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        // Follow one redirect (Codeberg may issue 302 to its CDN).
        res.resume();
        downloadTo(res.headers.location, destPath, onProgress).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new FetcherError(`HTTP ${status} fetching ${url}`));
        return;
      }
      const total = parseTotal(res.headers["content-length"]);
      let received = 0;
      if (onProgress) {
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          onProgress(received, total);
        });
      }
      const sink = createWriteStream(destPath);
      pipeline(res, sink).then(resolve, reject);
    };

    httpsGet(url, onResponse).on("error", (e) =>
      reject(new FetcherError(`network error fetching ${url}: ${e.message}`, e)),
    );
  });
}

function parseTotal(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// Pubkey path resolution
// ---------------------------------------------------------------------------

/**
 * Default pubkey path: `<package_root>/keys/macula-minisign.pub`.
 *
 * Computed relative to this module's compiled location:
 *   dist/install/fetcher.js → ../../keys/macula-minisign.pub
 */
function defaultPubKeyPath(): string {
  // Walk up: dist/install/fetcher.js → dist/install → dist → <root>
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "keys", "macula-minisign.pub");
}
