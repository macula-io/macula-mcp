// The dependency floor that keeps this server a working mesh caller once
// providers turn sealing on by default (macula-io/macula-mcp#70).
//
// Release A of sealed-by-default makes a provider refuse every clear call
// with `sealed_required`. Recovery from that refusal -- sealing again to the
// key in the refusal's signed tbs, which is the key the provider holds now --
// is release A0. It is not in this repository: it is in @macula-io/ts 0.32.1,
// whose native library is macula-go v0.29.0 (macula-ts#24), so the version
// this package resolves IS the behaviour. 0.31.0 and below fail such a call
// with a stale keyless candidate instead.
//
// The check is a version, not a call, because a call cannot be made here: this
// repository's whole suite mocks @macula-io/ts at the module boundary and CI is
// offline (see ci.yml's test job), so a reseal test against the real binding
// would be a test of the mock. What can go wrong silently is the resolution,
// and that is what this holds: a regenerated lockfile, a pin back to 0.31.x, a
// range whose floor is below the A0 release.
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

/** The @macula-io/ts release that carries A0 (macula-ts 0.32.1: macula-go
 *  v0.29.0). A caller below it cannot recover from a `sealed_required`
 *  refusal, so it fails against a provider that refuses clear calls. */
const A0_RELEASE = "0.32.1";

const tsPackage = "@macula-io/ts";

interface PackageJson {
  dependencies?: Record<string, string>;
}

interface Lockfile {
  packages?: Record<string, { version?: string; dependencies?: Record<string, string> }>;
}

/** Parses a plain x.y.z version; a prerelease sorts below its release. */
function versionOf(text: string): { parts: number[]; prerelease: boolean } {
  const [core = "", ...rest] = text.split("-");
  const parts = core.split(".").map((piece) => Number.parseInt(piece, 10));
  if (parts.length < 3 || parts.some(Number.isNaN)) {
    throw new Error(`"${text}" is not an x.y.z version, so the sealing floor cannot be judged from it`);
  }
  return { parts, prerelease: rest.length > 0 };
}

/** The lowest version a semver range can resolve to, for the range shapes that
 *  can express a floor: ^x.y.z, ~x.y.z, x.y.z, and >=x.y.z. */
function floorOf(range: string): string {
  const match = /^(?:\^|~|>=|=)?\s*(\d+\.\d+\.\d+)$/.exec(range.trim());
  if (match?.[1] === undefined) {
    throw new Error(
      `"${range}" does not name a floor (^x.y.z, ~x.y.z, x.y.z, >=x.y.z): ` +
        "the sealing floor cannot be judged from a range that could resolve below it",
    );
  }
  return match[1];
}

/** Whether `version` is at least `floor`. */
function atLeast(version: string, floor: string): boolean {
  const a = versionOf(version);
  const b = versionOf(floor);
  if (a.prerelease !== b.prerelease) return b.prerelease;
  for (let i = 0; i < 3; i += 1) {
    const mine = a.parts[i] ?? 0;
    const theirs = b.parts[i] ?? 0;
    if (mine !== theirs) return mine > theirs;
  }
  return true;
}

describe(`${tsPackage}'s sealing floor (A0, macula-mcp#70)`, () => {
  it(`resolves ${A0_RELEASE} or newer, the release that reseals after a sealed_required refusal`, () => {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as PackageJson;
    const lock = require("../package-lock.json") as Lockfile;
    const declared = pkg.dependencies?.[tsPackage];
    const resolved = lock.packages?.[`node_modules/${tsPackage}`]?.version;
    const lockedRange = lock.packages?.[""]?.dependencies?.[tsPackage];

    // A range and a lockfile that agree with each other can still both be
    // wrong, so each is judged against A0 on its own.
    expect(declared, `package.json must depend on ${tsPackage}`).toBeDefined();
    expect(resolved, `package-lock.json must resolve ${tsPackage}`).toBeDefined();
    expect(
      atLeast(floorOf(declared ?? ""), A0_RELEASE),
      `package.json's "${tsPackage}": "${declared}" can resolve below ${A0_RELEASE}, which is the ` +
        "release that reseals a call a keyed provider refused with sealed_required: a server built " +
        "from it fails against every provider that turns sealed-by-default on",
    ).toBe(true);
    expect(
      atLeast(resolved ?? "0.0.0", A0_RELEASE),
      `npm ci installs ${tsPackage} ${resolved} from package-lock.json, below the A0 release ` +
        `${A0_RELEASE}: the lockfile needs regenerating with \`npm install ${tsPackage}@^${A0_RELEASE}\``,
    ).toBe(true);
    expect(
      lockedRange,
      `package-lock.json's root entry declares ${tsPackage} "${lockedRange}" while package.json ` +
        `declares "${declared}": the lockfile is out of step with the manifest`,
    ).toBe(declared);
  });
});
