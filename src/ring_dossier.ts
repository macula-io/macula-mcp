// The ring dossier: the one owner of the `rings` rows (macula-mcp#42, step 2 of the crew's architecture
// review of this package, 2026-10-23).
//
// Before this, nine statements across four functions wrote the table directly, each a read followed by a
// write with awaits in between: a deferred ring could be answered twice, a decided answer could be
// overwritten by a late reply, and `answerPendingRing` read the row, waited on a room join, then wrote
// against what it had read -- so two answers to one ring both proceeded and the last one won.
//
// Every transition here is one conditional UPDATE inside one transaction, and every one says whether it
// changed a row. That answer is what "exactly once" rests on: the caller appends its history entry only
// when the transition reports a change, in the same transaction, rather than deriving it later.
//
// The one that has to happen before an await is `claimDeferredRing`: the row is marked with a token first,
// and the answer only lands if that token is still the row's. A claim that is released (the join failed)
// or lost (another answer landed) simply does not write.
import { randomBytes } from "node:crypto";
import { ANSWER, ringsDb, type Answer, type RingRecord } from "./rings.js";

/** How long a claim may sit before another attempt may take it: a process killed mid-answer must not make a
 * ring unanswerable forever. */
export const CLAIM_TTL_MS = 2 * 60 * 1000;

/** What places a ring: the same fields on both sides of the conversation. */
export interface RingSeed {
  ring_id: string;
  self: string;
  peer: string;
  purpose: string;
  room_topic: string;
  sent_at: number;
}

function now(): string {
  return new Date().toISOString();
}

/** One statement in its own transaction: BEGIN IMMEDIATE so a second process waits (busy_timeout) rather
 * than reading a row this one is about to change. */
function inTransaction<T>(run: () => T): T {
  const db = ringsDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = run();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * The caller's own row, written before the call goes out. False when this ring id was already placed --
 * `(ring_id, direction)` is the row's identity, so a repeat is the same ring, not a second one.
 */
export function ringPlaced(seed: RingSeed): boolean {
  return inTransaction(() => {
    const res = ringsDb()
      .prepare(
        `INSERT INTO rings (ring_id, self, direction, peer, purpose, room_topic, sent_at, recorded_at)
         VALUES (@ring_id, @self, 'out', @peer, @purpose, @room_topic, @sent_at, @now)
         ON CONFLICT(ring_id, direction) DO NOTHING`,
      )
      .run({ ...seed, self: seed.self.toLowerCase(), now: now() });
    return Number(res.changes) > 0;
  });
}

/**
 * The callee's row when a ring arrives: written with the answer the operator's policy gave on the spot
 * (accepted or declined), or with none when the ring is deferred to this agent's model. False when this
 * ring id was already received.
 */
export function ringReceived(seed: RingSeed & { answer: 1 | 2 | null; reason?: string }): boolean {
  return inTransaction(() => {
    const at = now();
    const res = ringsDb()
      .prepare(
        `INSERT INTO rings (ring_id, self, direction, peer, purpose, room_topic, sent_at, recorded_at, answer, reason, answered_at)
         VALUES (@ring_id, @self, 'in', @peer, @purpose, @room_topic, @sent_at, @at, @answer, @reason, @answered_at)
         ON CONFLICT(ring_id, direction) DO NOTHING`,
      )
      .run({
        ...seed,
        self: seed.self.toLowerCase(),
        at,
        answer: seed.answer,
        reason: seed.reason ?? null,
        answered_at: seed.answer === null ? null : at,
      });
    return Number(res.changes) > 0;
  });
}

/**
 * The caller's row learns what came back: an answer (1 accepted, 2 declined, 3 deferred), or a reason with
 * no answer at all (they were unreachable, or the reply was malformed). Answers only move forward -- 3 may
 * become 1 or 2, and 1 or 2 is final -- so a late reply never overwrites a decided one.
 *
 * Unreachable is not an answer: `answer: null` records the reason only, and only while nothing has answered.
 */
export function ringReply(ringId: string, answer: Answer | null, reason?: string): boolean {
  if (answer === null) {
    return inTransaction(() => {
      const res = ringsDb()
        .prepare(
          `UPDATE rings SET reason = @reason, answered_at = NULL
           WHERE ring_id = @ring_id AND direction = 'out' AND answer IS NULL`,
        )
        .run({ ring_id: ringId, reason: reason ?? null });
      return Number(res.changes) > 0;
    });
  }

  return inTransaction(() => {
    const res = ringsDb()
      .prepare(
        `UPDATE rings SET answer = @answer, reason = @reason, answered_at = @at
         WHERE ring_id = @ring_id AND direction = 'out' AND (answer IS NULL OR answer = @deferred)`,
      )
      .run({ ring_id: ringId, answer, reason: reason ?? null, at: now(), deferred: ANSWER.deferred });
    return Number(res.changes) > 0;
  });
}

export type Claim =
  | { ok: 1; ring: RingRecord; token: string }
  | { ok: 0; reason: "missing" | "answered"; answer?: Answer | null };

/**
 * Claims a deferred incoming ring before the work that answers it (a room join) is awaited, so two
 * attempts cannot both answer one ring. A claim older than `CLAIM_TTL_MS` is taken over: the process that
 * held it died, and the ring must not become unanswerable.
 */
export function claimDeferredRing(ringId: string, self: string): Claim {
  const staleBefore = new Date(Date.now() - CLAIM_TTL_MS).toISOString();
  const token = randomBytes(8).toString("hex");

  return inTransaction(() => {
    const db = ringsDb();
    const row = db.prepare("SELECT * FROM rings WHERE ring_id = ? AND self = ? AND direction = 'in'").get(ringId, self.toLowerCase()) as
      | RingRecord
      | undefined;
    if (!row) return { ok: 0, reason: "missing" } as Claim;
    if (row.answer !== null) return { ok: 0, reason: "answered", answer: row.answer } as Claim;
    const res = db
      .prepare(
        `UPDATE rings SET claim = @token, claimed_at = @at
         WHERE ring_id = @ring_id AND direction = 'in' AND answer IS NULL
           AND (claim IS NULL OR claimed_at < @stale_before)`,
      )
      .run({ ring_id: ringId, token, at: now(), stale_before: staleBefore });
    if (Number(res.changes) === 0) return { ok: 0, reason: "answered", answer: row.answer } as Claim;
    return { ok: 1, ring: { ...row, claim: token }, token } as Claim;
  });
}

/**
 * Answers the ring this claim holds. False when the claim was lost -- released, taken over as stale, or the
 * row answered meanwhile -- so the caller never reports an answer it did not record.
 */
export function answerClaimedRing(ringId: string, token: string, answer: 1 | 2, reason?: string): boolean {
  return inTransaction(() => {
    const res = ringsDb()
      .prepare(
        `UPDATE rings SET answer = @answer, reason = @reason, answered_at = @at, claim = NULL, claimed_at = NULL
         WHERE ring_id = @ring_id AND direction = 'in' AND claim = @token AND answer IS NULL`,
      )
      .run({ ring_id: ringId, token, answer, reason: reason ?? null, at: now() });
    return Number(res.changes) > 0;
  });
}

/** Gives the claim back (the join failed, so nothing was answered): only this token's own claim is cleared. */
export function releaseClaim(ringId: string, token: string): void {
  inTransaction(() => {
    ringsDb()
      .prepare("UPDATE rings SET claim = NULL, claimed_at = NULL WHERE ring_id = ? AND direction = 'in' AND claim = ? AND answer IS NULL")
      .run(ringId, token);
  });
}
