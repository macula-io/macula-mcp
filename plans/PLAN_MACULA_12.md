# PLAN_MACULA_12.md

**Status:** In progress (branch `macula-12`)
**Created:** 2026-09-24
**Last Updated:** 2026-09-25

## End goal

> So an agent using macula-mcp reaches the macula 12 fleet again: calls the
> mcl-* services, talks in rooms, reads the DHT, and (once self-named serving
> is live) serves and rings.

BUILD. The move onto @macula-io/ts 0.18 (macula-go's pool on the 12 wire).
**The release is held until self-named serving (`~<node id>/<name>`) is live
on the fleet, SDK and stations (Raf, 2026-09-24).** SDK: done, macula-go
v0.11.0 (tagged 9753be2) and macula-ts main 46fbf3d; ts 0.18.0 tag pending.
Stations: 0.6.4 (own-namespace admission) not released; the fleet runs 0.6.2.

## Decisions (Raf, via the Supervisor, 2026-09-24)

- **Identities.** New ML-DSA key files (`NodeKey`) at a new default path; the
  old Ed25519 seed files are left untouched. The CHANGELOG tells users their
  node_ids change and to re-join realms and re-trust agents.
- **Rooms** stay on pubsub (they already are) and move to the new API.
- **Rings** stay CALLs, on the self-named `~<node id>/ring`, served
  in-process. Option 4 landed in the SDK before this branch was finished, so
  no refuse-by-name stage was needed; they wait on stations at 0.6.4.
- **Serving** (`mesh_serve`, the ring endpoint) is `~<node id>/<name>`,
  in-process, waiting on the same station release.
- **Ownership proofs** (Ed25519, signed through `identity sign`) are dropped,
  not ported: a served call carries the caller's verified key id and every
  publication is signed, so on 12 they prove nothing more.
- **Artifacts** (content transfer) refuse by name until macula has
  node-served content (macula#35); **UCAN-gated calls** until PQ UCANs
  (macula-go#2).

## Stations and realms

A 12 pool pins every station by node_id and trusts a realm only by its key.

- **Default stations**, each `host:port` with its node_id, taken from the
  stations' own peer lists in macula-fleet (`vps/*/config/pq.station-*.json`,
  2026-09-24):

  | Station | node_id |
  |---|---|
  | station-de-frankfurt.macula.io:4433 | 00cd0008ec2e…b71f85 |
  | station-de-nuremberg.macula.io:4433 | 00a9b4143e24…13af22 |
  | station-de-falkenstein.macula.io:4433 | 00df68247d11…e86435 |
  | station-fi-helsinki.macula.io:4433 | 004d1f470097…b4efd8 |
  | station-fr-paris.macula.io:4433 | 0063acc4a5af…f7ca94 |
  | station-nl-ams.macula.io:4433 | 000370eebafa…b04b0c |

- `MACULA_MESH_STATIONS` takes `host:port@<node_id hex>` entries, comma
  separated; an entry without a node_id is refused by name.
- **Default realm trust:** io.macula (`sha256("io.macula")`) with its public
  key, as mcl-echo's config carries it. `MACULA_MESH_REALMS` adds
  `<realm hex>=<key hex>` entries; joining a realm records its key.

## Work

- [x] Client layer (`macula_ts_client.ts`) on `Pool`: one pool per process,
  one `NodeKey` (pq_hybrid) per session scope, seeds pinned by node_id,
  io.macula trust plus `MACULA_MESH_REALMS`; call, publish, subscribe,
  watch, the DHT finds, serve, ownProcedure, proveKeyPossession.
- [x] Presence, lobby observer and rooms on the pool; hello/goodbye bound to
  the verified publisher.
- [x] Citizenship with no proof; realm join and device membership proving
  possession of the ML-DSA key.
- [x] Rings on `~<node id>/ring` and `mesh_serve` on `~<node id>/<name>`,
  in-process; ownership proofs and the relay handler deleted; room invites
  in parallel.
- [x] Artifacts and UCAN calls refuse by name.
- [x] Tests: 461 pass, tsc clean. README, HOWTO, etiquette, help prompts,
  instructions and CHANGELOG rewritten for 12.
- [x] `scripts/fleet-live-check.mjs` (2026-09-25, fleet on 0.6.2): presence,
  DHT by type (34 advertisements, 0 dropped), `mcl-echo/echo` by direct dial
  (216 ms), publish heard by watch, goodbye: pass. Expected fails: ring and
  `~callee/echo` (stations refuse own-namespace advertisements before 0.6.4),
  citizenship and `mesh_list_stations` (mcl-citizens and mcl-stations are not
  advertised on the fleet).
- [ ] Depend on `@macula-io/ts` ^0.18.0 (and refresh package-lock.json) once
  0.18.0 is published; until then the branch is tested against a local pack
  of macula-ts main.
- [ ] Once stations run 0.6.4: the live check's ring and serve steps pass,
  then the release.
