// HTTP client for the local hecate-daemon, spoken over its Unix socket.
//
// macula-mcp does NOT speak QUIC, DHT or Macula RPC. It hands the daemon a
// JSON request and lets the daemon — already a mesh client, already the
// realm-accountable leaf — do the actual macula:call / put_content / publish.
// Same discipline as git-remote-mesh.
//
// Wire rule (memory feedback_macula_publish_takes_terms): we send plain
// JSON to the *daemon*. The daemon converts to a CBOR term before it touches
// the Macula wire. Nothing here ever pre-encodes a payload destined for the
// mesh — it sends structured JSON, the daemon owns the wire encoding.

import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

const DEFAULT_SOCKET_REL = ".hecate/hecate-daemon/sockets/api.sock";

export function socketPath(): string {
  const explicit = process.env.HECATE_DAEMON_SOCKET;
  if (explicit && explicit.length > 0) return explicit;
  return join(homedir(), DEFAULT_SOCKET_REL);
}

export class DaemonUnavailable extends Error {}
export class DaemonError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
  }
}

interface CallOpts {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}

async function call<T>({ method, path, body }: CallOpts): Promise<T> {
  const sock = socketPath();
  if (!existsSync(sock)) {
    throw new DaemonUnavailable(
      `hecate-daemon socket not found at ${sock}. Is the daemon running? ` +
        `(override with HECATE_DAEMON_SOCKET)`,
    );
  }

  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));

  return new Promise<T>((resolve, reject) => {
    const req = request(
      {
        socketPath: sock,
        method,
        path,
        headers: {
          // hyperlocal-style hex Host headers get rejected by cowboy; be explicit.
          host: "localhost",
          ...(payload
            ? { "content-type": "application/json", "content-length": String(payload.length) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            return reject(new DaemonError(`daemon returned HTTP ${status} for ${path}`, status, raw));
          }
          try {
            resolve(raw.length ? (JSON.parse(raw) as T) : ({} as T));
          } catch (e) {
            reject(new DaemonError(`could not decode daemon reply for ${path}: ${raw}`, status, raw));
          }
        });
      },
    );
    req.on("error", (e) => reject(new DaemonUnavailable(`POST ${path} via ${sock}: ${e.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

// ---- daemon endpoint shapes -----------------------------------------------
// All endpoints implemented in hecate-daemon under apps/hecate_mesh,
// apps/guide_mesh_publications, apps/guide_mesh_artifacts,
// apps/project_mesh_activity, apps/query_mesh_activity.

/** GET /api/mesh/identity — apps/hecate_mesh/src/get_mesh_identity */
export interface Identity {
  ok: boolean;
  node_id: string | null;          // 32-byte ed25519 pubkey, hex
  mri: string | null;              // macula resource identifier
  realm: string | null;
  membership: "idle" | "joining" | "joined" | "failed";
  mesh: { activated: boolean; connected: boolean };
}

/** GET /api/mesh/peers — apps/hecate_mesh/src/get_mesh_peers (pre-existing) */
export interface PeersReply {
  ok: boolean;
  peers: unknown[];
  peer_count: number;
  self: Record<string, unknown>;
  connected: boolean;
}

/** GET /api/mesh/activity — apps/query_mesh_activity/src/get_mesh_activity */
export interface ActivityEvent {
  fact_id: string;
  kind: "mesh_fact_published" | "mesh_artifact_shared";
  ts_ms: number;
  payload: Record<string, unknown>;
}
export interface ActivityReply {
  ok: boolean;
  events: ActivityEvent[];
}

/** POST /api/mesh/call — apps/hecate_mesh/src/call_mesh (REQUESTER) */
export interface CallReply {
  ok: boolean;
  result?: unknown;
  duration_ms: number;
  error?: string;
}

/** POST /api/mesh/artifact/put — apps/guide_mesh_artifacts/src/share_mesh_artifact */
export interface PutArtifactReply {
  ok: boolean;
  mcid_hex?: string;
  size_bytes?: number;
  fact_id?: string;
  error?: string;
}

/** GET /api/mesh/artifact/:hash — apps/guide_mesh_artifacts/src/fetch_mesh_artifact */
export interface GetArtifactReply {
  ok: boolean;
  content?: string;     // base64
  size_bytes?: number;
  error?: string;
}

/** POST /api/mesh/publish — apps/guide_mesh_publications/src/publish_mesh_fact */
export interface PublishReply {
  ok: boolean;
  topic?: string;
  requested_at?: number;
  fact_id?: string;
  error?: string;
}

export const daemon = {
  identity: () => call<Identity>({ method: "GET", path: "/api/mesh/identity" }),

  peers: () => call<PeersReply>({ method: "GET", path: "/api/mesh/peers" }),

  activity: (since?: number, limit?: number) => {
    const params = new URLSearchParams();
    if (since !== undefined) params.set("since", String(since));
    if (limit !== undefined) params.set("limit", String(limit));
    const qs = params.toString();
    return call<ActivityReply>({
      method: "GET",
      path: "/api/mesh/activity" + (qs ? `?${qs}` : ""),
    });
  },

  meshCall: (args: { procedure: string; args?: Record<string, unknown>; timeout_ms?: number }) =>
    call<CallReply>({ method: "POST", path: "/api/mesh/call", body: args }),

  artifactPut: (args: { content: string; content_type: string }) =>
    call<PutArtifactReply>({ method: "POST", path: "/api/mesh/artifact/put", body: args }),

  artifactGet: (hashHex: string) =>
    call<GetArtifactReply>({
      method: "GET",
      path: `/api/mesh/artifact/${encodeURIComponent(hashHex)}`,
    }),

  publish: (args: { topic: string; fact: Record<string, unknown> }) =>
    call<PublishReply>({ method: "POST", path: "/api/mesh/publish", body: args }),
};
