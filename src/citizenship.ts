// Citizenship: this agent's entry in the mesh-wide citizens directory
// (hecate-citizens), so it is addressable there the same way a spartan
// mind or a human via macula-passport is.
//
// Presence (presence.ts) makes an agent VISIBLE to other agents: an
// agent.hello heartbeat any other macula-mcp roster picks up. It does not
// make it a citizen. hecate-citizens is the directory every hecate service
// queries -- hecate-mail delegates to a citizen_did it finds there, a
// spartan mind is registered there (hecate-spartan's citizen_registration)
// -- and an agent that never registers simply does not exist to any of
// them. Found 2026-09-02 on a fresh opencode install: presence worked,
// the agent was on every roster, and it still "could not do much on the
// mesh" because nothing had ever created a citizen_did for it.
//
// The citizen_did IS the default identity's node_id (raw 32-byte Ed25519
// pubkey, hex) -- the same one mesh_call/mesh_publish act as and the one
// agent.hello announces. No new key: the whole point of the ownership
// proof hecate_citizens.register_presence demands is that only the holder
// of that key can register it, and macula-cli's `identity sign` produces
// exactly that proof from the default identity file.
//
// Registration is presence, not identity: entries expire (hecate-citizens'
// own TTL is ~20 min), so this re-registers every DEFAULT_RENEW_SECONDS,
// the same ~4x margin hecate-spartan's minds keep. Stops with presence
// (mesh_goodbye), and the entry ages out on its own after that.
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
import { call, discoverProcedureRealm, identitySign } from "./macula_cli.js";

export const REGISTER_PROCEDURE = "hecate_citizens.register_presence";
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
  // own stationArgs() resolution needs the real absence of a host to
  // attach -seed fallbacks to each periodic renewal; a pre-resolved
  // string looks exactly like an explicit override and would silently
  // lose them.
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
 * without a mesh: citizen_did and the signature are hex text (what
 * hecate-citizens' citizen_ownership_proof decodes), the timestamp is the
 * one that was signed, and nothing here is a boolean.
 */
export function registerArgs(input: {
  nodeId: string;
  timestamp: number;
  signature: string;
  displayName: string;
}): Record<string, unknown> {
  return {
    citizen_did: input.nodeId,
    proof: { timestamp: input.timestamp, signature: input.signature },
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
  signed: { node_id: string; timestamp: number; signature: string },
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
 * having carried a route to hecate-citizens' own station; during a
 * fleet rollout that route is exactly what is missing for a minute or
 * two (seen live 2026-09-02 as temporary_relay_failure on the very first
 * registration of a fresh install), while the service's own direct-dial
 * DHT record is still there. Same advice mesh_call's own `direct` doc
 * gives a caller, applied here automatically.
 */
export async function callThenDirect(args: Parameters<typeof call>[0]): Promise<Awaited<ReturnType<typeof call>>> {
  try {
    return await call(args);
  } catch (plain) {
    try {
      return await call({ ...args, direct: true });
    } catch (direct) {
      const p = plain instanceof Error ? plain.message : String(plain);
      const d = direct instanceof Error ? direct.message : String(direct);
      throw new Error(`${p}; direct-dial retry: ${d}`);
    }
  }
}

/** One registration attempt against the directory. Throws on any failure; callers record, never propagate. */
export async function register(input: { host?: string; nodeId: string; displayName: string }): Promise<{ realm: string; expires_at?: number }> {
  const realm = await discoverProcedureRealm({ host: input.host, procedure: REGISTER_PROCEDURE });
  const signed = await identitySign({ procedure: REGISTER_PROCEDURE });
  if (signed.node_id !== input.nodeId) {
    throw new Error(`identity sign returned node_id ${signed.node_id}, presence announced ${input.nodeId}`);
  }
  const callArgs = registerArgs({ nodeId: signed.node_id, timestamp: signed.timestamp, signature: signed.signature, displayName: input.displayName });
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
    const { realm, expires_at } = await register({ host: s.host, nodeId: s.nodeId, displayName: s.displayName });
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
