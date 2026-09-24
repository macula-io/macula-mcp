// Citizenship: this agent's entry in the mesh-wide citizens directory
// (mcl-citizens), so other agents and services can find it by its node id.
//
// Presence (presence.ts) makes an agent VISIBLE to other agents: an
// agent.hello heartbeat any other macula-mcp roster picks up. It does not
// make it a citizen. mcl-citizens is the directory services consult to find
// who exists, and an agent that never registers does not exist to them.
// Found 2026-09-02 on a fresh opencode install: presence worked, the agent
// was on every roster, and it still "could not do much on the mesh" because
// nothing had ever registered it.
//
// The citizen is the default identity, the one mesh_call/mesh_publish act
// as and agent.hello announces. mcl-citizens/register_presence registers
// the CALL's caller, which macula signs end to end with that identity's key
// and the provider verifies, so no proof travels in the payload and nothing
// is signed here. register()'s realm discovery (macula_ts_client.ts's
// discoverProcedureRealm) is in-process, the same DHT find-records-by-type
// + filter mesh_stations.ts/mesh_memory.ts do inline for their own calls.
//
// Registration is presence, not identity: entries expire (mcl-citizens
// keeps one at most twenty minutes), so this re-registers every
// DEFAULT_RENEW_SECONDS, a ~4x margin. Stops with presence (mesh_goodbye),
// and the entry ages out on its own after that.
//
// Fire-and-forget at the mesh level, bounded at the call level: presence
// start awaits the first registration up to FIRST_ATTEMPT_TIMEOUT_MS so
// mesh_hello can report an honest outcome, and every failure is recorded
// in status() rather than thrown -- a directory being down must never
// take presence down with it.
//
// Opt out with MACULA_MCP_NO_CITIZENSHIP=1: registering puts this agent
// in a public directory, same category of decision as presence's own
// agent.hello broadcast (see presence.ts on why that is on by default).
import { defaultIdentityPath } from "./mesh_config.js";
import { callThenDirect as callThenDirectTs, discoverProcedureRealm, signOwnershipProof, type TsCallResult, type TsIdentitySignResult } from "./macula_ts_client.js";

export const REGISTER_PROCEDURE = "mcl-citizens/register_presence";
export const CITIZEN_KIND = "agent";
export const OFFERS = ["conversation"];
export const DEFAULT_RENEW_SECONDS = 300;
export const FIRST_ATTEMPT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 6_000;

export interface CitizenshipStatus {
  /** The default identity's node_id, which is what gets registered. */
  citizen_did?: string;
  registered: boolean;
  /** Set when MACULA_MCP_NO_CITIZENSHIP is on: nothing was or will be attempted. */
  disabled?: boolean;
  realm?: string;
  display_name?: string;
  registered_at?: string;
  expires_at?: number;
  next_renewal_at?: string;
  /** Why the last attempt failed, if it did. Cleared by the next success. */
  error?: string;
  /** An attempt is still in flight (the first one outlived its bounded wait, or a renewal is running); status() again later. */
  pending?: boolean;
}

interface CitizenshipState {
  // Deliberately the ORIGINAL possibly-undefined override, not
  // resolved via defaultStation() here -- discoverProcedureRealm/call's
  // own connectWithFallback() (macula_ts_client.ts) needs the real
  // absence of a host to attach its own multi-station fallback to each
  // periodic renewal; a pre-resolved string looks exactly like an
  // explicit override and would silently lose it.
  host?: string;
  nodeId: string;
  displayName: string;
  realm?: string;
  registeredAt?: string;
  expiresAt?: number;
  error?: string;
  inFlight: boolean;
  renewTimer?: NodeJS.Timeout;
  renewSeconds: number;
}

let state: CitizenshipState | undefined;

export function disabled(): boolean {
  return Boolean(process.env.MACULA_MCP_NO_CITIZENSHIP);
}

/**
 * What a citizen shows up as in the directory: the operator's name if
 * any, else the realm handle this identity joined under (realm.ts), else
 * the harness that runs this agent, else a plain label.
 */
export function displayName(operatorName: string | undefined, connectedVia: string | undefined, realmHandle?: string): string {
  return process.env.MACULA_MCP_CITIZEN_DISPLAY_NAME ?? operatorName ?? realmHandle ?? connectedVia ?? "macula-mcp agent";
}

/**
 * The register_presence payload. Pure, so the wire shape is testable
 * without a mesh. No proof and no citizen_did: mcl-citizens registers the
 * CALL's caller, which macula signs end to end with this identity's key and
 * the provider verifies, so the payload carries only what the directory
 * shows. Nothing here is a boolean.
 */
export function registerArgs(input: { displayName: string }): Record<string, unknown> {
  return {
    citizen_kind: CITIZEN_KIND,
    display_name: input.displayName,
    offers: OFFERS,
  };
}

/**
 * Merge an ownership proof for `procedure` into a call's args, for
 * mesh_call's prove_identity. The proof is bound to THIS server's default
 * identity, so citizen_did and proof always come from the signature --
 * a caller-supplied citizen_did for some other key could never verify
 * anyway. Every other arg the caller passed is kept. Pure.
 */
export function withIdentityProof(
  args: Record<string, unknown> | undefined,
  signed: TsIdentitySignResult,
): Record<string, unknown> {
  return {
    ...(args ?? {}),
    citizen_did: signed.node_id,
    proof: { timestamp: signed.timestamp, signature: signed.signature },
  };
}

function readOk(payload: unknown): { ok: boolean; expires_at?: number; error?: string } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const ok = p.ok === 1 || p.ok === true;
  return {
    ok,
    expires_at: typeof p.expires_at === "number" ? p.expires_at : undefined,
    error: typeof p.error === "string" ? p.error : undefined,
  };
}

/**
 * A plain (gossip-routed) call, then the same call direct-dialled if the
 * plain one fails. The plain route depends on inter-station gossip
 * having carried a route to mcl-citizens' own station; during a
 * fleet rollout that route is exactly what is missing for a minute or
 * two (seen live 2026-09-02 as temporary_relay_failure on the very first
 * registration of a fresh install), while the service's own direct-dial
 * DHT record is still there. Same advice mesh_call's own `direct` doc
 * gives a caller, applied here automatically. Thin wrapper over
 * macula_ts_client.ts's callThenDirect, pinned to this server's own
 * default identity -- the same identity every mesh_call/mesh_publish
 * call uses, and the one signIdentity() below signs proofs for.
 */
export async function callThenDirect(args: {
  host?: string;
  procedure: string;
  callArgs?: Record<string, unknown>;
  timeoutMs?: number;
  realm?: string;
}): Promise<TsCallResult> {
  return callThenDirectTs({ ...args, identityPath: defaultIdentityPath() });
}

/**
 * An ownership proof for `procedure`, signed by this server's own
 * default identity -- macula_ts_client.ts's signOwnershipProof pinned to
 * defaultIdentityPath(), the same identity register()/mesh_call's
 * prove_identity/ring_service.ts/mesh_ring.ts all act as.
 */
export function signIdentity(procedure: string): TsIdentitySignResult {
  return signOwnershipProof(defaultIdentityPath(), procedure);
}

/** One registration attempt against the directory. Throws on any failure; callers record, never propagate. */
export async function register(input: { host?: string; displayName: string }): Promise<{ realm: string; expires_at?: number }> {
  const realm = await discoverProcedureRealm({ host: input.host, procedure: REGISTER_PROCEDURE, identityPath: defaultIdentityPath() });
  const callArgs = registerArgs({ displayName: input.displayName });
  const res = await callThenDirect({ host: input.host, procedure: REGISTER_PROCEDURE, realm, timeoutMs: CALL_TIMEOUT_MS, callArgs });
  const outcome = readOk(res.payload);
  if (!outcome.ok) throw new Error(`${REGISTER_PROCEDURE} refused: ${outcome.error ?? "no reason given"}`);
  return { realm, expires_at: outcome.expires_at };
}

async function attempt(): Promise<void> {
  if (!state) return;
  const s = state;
  if (s.inFlight) return; // a renewal must never stack on a slow first attempt
  s.inFlight = true;
  try {
    const { realm, expires_at } = await register({ host: s.host, displayName: s.displayName });
    s.realm = realm;
    s.expiresAt = expires_at;
    s.registeredAt = new Date().toISOString();
    s.error = undefined;
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
    console.error(`citizenship: registering ${s.nodeId} with ${REGISTER_PROCEDURE} failed: ${s.error}`);
  } finally {
    s.inFlight = false;
  }
}

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
    void p.finally(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

/**
 * Register now (bounded wait, so a caller can report the outcome) and keep
 * re-registering until stop(). Calling again while active just updates
 * the display name for the next renewal. Returns the status after the
 * first attempt, or a disabled status when opted out.
 */
export async function start(input: {
  host?: string;
  nodeId: string;
  displayName: string;
  renewSeconds?: number;
}): Promise<CitizenshipStatus> {
  if (disabled()) return { citizen_did: input.nodeId, registered: false, disabled: true };
  if (state && state.nodeId === input.nodeId) {
    state.displayName = input.displayName;
    return status();
  }
  stop();
  const renewSeconds = Math.max(30, input.renewSeconds ?? DEFAULT_RENEW_SECONDS);
  state = { host: input.host, nodeId: input.nodeId, displayName: input.displayName, renewSeconds, inFlight: false };
  await withTimeout(attempt(), FIRST_ATTEMPT_TIMEOUT_MS);
  const timer = setInterval(() => void attempt(), renewSeconds * 1000);
  timer.unref();
  state.renewTimer = timer;
  return status();
}

/** Stop renewing. The directory entry ages out on its own; there is no unregister. */
export function stop(): void {
  if (!state) return;
  if (state.renewTimer) clearInterval(state.renewTimer);
  state = undefined;
}

export function status(): CitizenshipStatus {
  if (disabled()) return { registered: false, disabled: true };
  if (!state) return { registered: false };
  const nextRenewal = state.renewTimer ? new Date(Date.now() + state.renewSeconds * 1000).toISOString() : undefined;
  return {
    citizen_did: state.nodeId,
    registered: Boolean(state.registeredAt) && !state.error,
    realm: state.realm,
    display_name: state.displayName,
    registered_at: state.registeredAt,
    expires_at: state.expiresAt,
    next_renewal_at: nextRenewal,
    error: state.error,
    ...(state.inFlight ? { pending: true } : {}),
  };
}
