// Blocks a likely secret/credential from leaving this machine through any
// of this server's own outbound mesh tools -- mesh_publish/mesh_call/
// mesh_say/mesh_ring/mesh_answer_ring/mesh_hello/mesh_put/mesh_remember/
// mesh_remember_directory, plus mesh_serve's -exec reply path (a
// registered local command's stdout, returned to whoever calls it).
//
// Why this exists: none of those tools had ANY content inspection before
// this (confirmed by a full-repo grep, zero hits for redact/secret/
// credential/sensitive/scan applied to outbound payloads -- every field
// was validated structurally only, type/length/hex-format, never for
// content). The coordination features shipped today (lane_claimed/
// lane_released, capability discovery via question_asked/answer_given)
// have to be safe for ANY agent/LLM connecting through this server, not
// just a careful one with "never echo secrets" already in its own system
// prompt -- so this needs enforcement at the tool boundary, not reliance
// on the calling model's own judgment.
//
// Specific SHAPES, not entropy. A generic "looks random" heuristic would
// false-positive constantly against this server's own completely normal
// traffic -- node ids, MCIDs, realm ids, UCANs are all long hex/base64url
// strings, published and returned by the hundred in ordinary use (this
// session's own live verification work today did exactly that). Matching
// specific, well-known secret formats instead keeps false positives near
// zero, at the honest cost of not catching a truly novel/unknown-format
// secret -- pattern matching was never going to be perfect, and isn't
// pretending to be.
//
// No override flag. Considered one (matches how a human-in-the-loop
// confirmation gate usually works) and rejected it: this server has no
// way to synchronously ask a HUMAN (no sampling/elicitation implemented,
// confirmed separately) -- any override could only be the CALLING AGENT
// asserting its own content is fine, and the exact threat model here (a
// careless or unsophisticated agent, not a careful one) would just always
// set that flag, making it decorative rather than a real gate. A hard
// block with a clear "what matched, roughly where" error lets a genuine
// false positive be redacted and retried -- there's no legitimate case
// for actually needing to publish a real credential onto a shared mesh.

import { MaculaCliError } from "./mesh_config.js";

interface SecretPattern {
  name: string;
  re: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { name: "AWS access key ID", re: /AKIA[0-9A-Z]{16}/ },
  // PRIVATE key blocks only -- deliberately excludes CERTIFICATE/PUBLIC
  // KEY/CERTIFICATE REQUEST blocks, which are legitimate, already-shipped
  // mesh traffic: macula-realm's CertificateRpcHandlers (issue_app_cert,
  // issue_ed25519_app_cert) returns cert_pem/org_ca_pem/realm_ca_pem --
  // real X.509 PEM over the mesh, as normal expected output. The regex
  // only matches when the literal words "PRIVATE KEY" follow BEGIN, which
  // by construction can never match a CERTIFICATE or PUBLIC KEY header.
  // [A-Z0-9 ]* (not a fixed alternation) so ENCRYPTED PRIVATE KEY (PKCS#8
  // with a passphrase) matches too, and the optional " BLOCK" suffix so
  // real PGP armor (-----BEGIN PGP PRIVATE KEY BLOCK-----) does, which the
  // earlier fixed-alternation version silently never matched (found by
  // adversarial review 2026-09-04 -- "PGP " was dead code with no test).
  { name: "PEM private key block", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/ },
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/ },
  { name: "Slack token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Stripe secret key", re: /sk_(live|test)_[A-Za-z0-9]{20,}/ },
  { name: "OpenAI API key", re: /sk-(proj-)?[A-Za-z0-9]{20,}/ },
  { name: "Anthropic API key", re: /sk-ant-[A-Za-z0-9-]{20,}/ },
  // The literal header SHAPE ("Authorization: Bearer <token>"), not any
  // bearer-token-looking string alone -- Macula UCANs are bearer tokens
  // by design (see reference_macula_ucan_bearer_not_audience_bound) and
  // get returned raw (ucan: <jwt>) from issue_membership_ucan_v1 replies
  // as normal, expected, constant mesh traffic. A bare JWT string with no
  // "Authorization:" prefix around it must never match this.
  { name: "Authorization: Bearer header", re: /Authorization:\s*Bearer\s+\S+/i },
  // A .env-style (or YAML-style) KEY=value/KEY: value line where KEY reads
  // as a secret by name. Deliberately conservative (requires an actual
  // key-then-value pair, not just the word SECRET/TOKEN/etc. appearing
  // anywhere) to avoid flagging ordinary field names like "citizen_did" or
  // "auth_token_type" that carry a non-secret value shape (a bare id, a
  // type label). Requires an UPPERCASE key on purpose: ordinary JSON/JS
  // field names are conventionally lower/camelCase, env-style secret names
  // are conventionally UPPER_SNAKE_CASE -- this is what keeps
  // "auth_token_type": "bearer" clean while still catching
  // "AWS_SECRET_ACCESS_KEY". This same pattern is also applied to
  // synthesized "KEY=value" strings built from object entries below, not
  // just to literal text -- see findLikelySecret's object branch.
  { name: "secret-looking KEY=value", re: /\b[A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_KEY|AUTH_TOKEN)[A-Z0-9_]*["']?\s*[=:]\s*["']?\S+/ },
];

export interface SecretMatch {
  patternName: string;
  /** Where in the scanned value the match was found, e.g. "fact.config.apiKey" or "text". */
  path: string;
}

function scanString(s: string): string | undefined {
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(s)) return p.name;
  }
  return undefined;
}

/**
 * Walks `value` (a string, or a JSON-shaped structure of strings/numbers/
 * arrays/objects -- exactly what every category-1 tool's free-text/args
 * field actually is) looking for the first string leaf that matches a
 * known secret shape. Returns the match (pattern name + a dotted/bracketed
 * path for a useful error) or undefined when nothing matched. Pure, no
 * network, no side effects -- safe to call before any mesh operation.
 */
export function findLikelySecret(value: unknown, path: string): SecretMatch | undefined {
  if (typeof value === "string") {
    const name = scanString(value);
    return name ? { patternName: name, path } : undefined;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const m = findLikelySecret(value[i], `${path}[${i}]`);
      if (m) return m;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // The secret-looking-KEY=value pattern above needs to see the KEY
      // NAME, but a JSON-structured value ({"AWS_SECRET_ACCESS_KEY": "..."})
      // never puts the key inside the string leaf the recursive scan below
      // checks -- the value alone often carries no distinctive shape at all
      // (found by adversarial review 2026-09-04: this was the single most
      // realistic bypass, an agent restructuring a .env file's lines into
      // JSON object properties rather than pasting raw "KEY=value" text).
      // Synthesizing "key=value" and running the SAME pattern list against
      // it catches exactly this, at negligible cost, without needing a
      // separate key-only pattern.
      if (typeof v === "string" && v.length > 0) {
        const kv = scanString(`${k}=${v}`);
        if (kv) return { patternName: kv, path: `${path}.${k}` };
      }
      const m = findLikelySecret(v, `${path}.${k}`);
      if (m) return m;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Throws a MaculaCliError (the same error type every mesh tool's catch
 * block already formats via reply.ts's describeCliError, so this needs no
 * new error-handling path at any call site) if `value` looks like it
 * contains a secret. `label` names the argument being scanned, for the
 * error message and as the root of the reported path.
 */
export function assertNoLikelySecret(value: unknown, label: string): void {
  const match = findLikelySecret(value, label);
  if (match) {
    throw new MaculaCliError(
      `${label} looks like it contains a ${match.patternName} (at ${match.path}) -- refusing to send it over the ` +
        "mesh. If this is a false positive, remove or redact the matched text and try again.",
    );
  }
}

/**
 * True when `buf` round-trips through UTF-8 decode/re-encode unchanged --
 * the standard way to tell "this is genuinely text" from "this is binary
 * data that happens to contain some ASCII-looking bytes", since Node's own
 * .toString("utf8") never throws on invalid sequences, it silently
 * substitutes U+FFFD instead.
 */
function isValidUtf8(buf: Buffer): boolean {
  return Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
}

/**
 * mesh_put's content is base64-encoded ARBITRARY bytes -- a build output,
 * a binary artifact, anything. Pattern-matching binary data is meaningless
 * (and risks false positives from byte coincidences), so this only scans
 * when the decoded bytes are genuinely valid UTF-8 text; binary content
 * passes through unscanned, silently, same "can't meaningfully inspect
 * this" spirit as mesh_remember_directory's own existing binary-skip.
 */
export function assertNoLikelySecretInBase64Content(contentBase64: string, label: string): void {
  const buf = Buffer.from(contentBase64, "base64");
  if (!isValidUtf8(buf)) return;
  assertNoLikelySecret(buf.toString("utf8"), label);
}

// mesh_remember_directory's second, cheaper layer, checked BEFORE a file
// is even read: filenames that are secret-bearing by convention, catching
// the common case even if the file's own content would somehow dodge
// findLikelySecret (encoding, an unrecognized format). Defense in depth,
// not a replacement for content scanning -- a file that passes this check
// still goes through findLikelySecret on its actual content.
const EXCLUDED_PATH_PATTERNS: RegExp[] = [
  /(^|[/\\])\.env(\.|$)/, // .env, .env.local, .env.production, ...
  /\.pem$/i,
  /\.key$/i,
  /(^|[/\\])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|[/\\])\.ssh([/\\]|$)/,
  /(^|[/\\])\.aws([/\\]|$)/,
  /(^|[/\\])\.npmrc$/,
  /(^|[/\\])credentials\.json$/i,
];

/** Whether `relativePath` matches a known secret-bearing filename convention, checked before the file is even opened. */
export function isExcludedPath(relativePath: string): boolean {
  return EXCLUDED_PATH_PATTERNS.some((re) => re.test(relativePath));
}
