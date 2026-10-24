import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { answerClaimedRing, claimDeferredRing, CLAIM_TTL_MS, releaseClaim, ringPlaced, ringReceived, ringReply } from "./ring_dossier.js";
import { getRing } from "./rings.js";
import { closeMachineDb, machineDb } from "../machine_transcript.js";

const ME = "a".repeat(64);
const THEM = "b".repeat(64);
const ROOM = `agents.room.${"1".repeat(32)}`;

const seed = (ring_id: string, direction: "in" | "out") => ({
  ring_id,
  self: direction === "in" ? ME : THEM,
  peer: direction === "in" ? THEM : ME,
  purpose: "pair on the plan",
  room_topic: ROOM,
  sent_at: 5,
});

let dir = "";

beforeEach(() => {
  // A real file: this owner's whole point is what a shared file does under two writers.
  dir = mkdtempSync(join(tmpdir(), "macula-mcp-ring-dossier-"));
  process.env.MACULA_MCP_RINGS_DB = join(dir, "rings.sqlite3");
});

afterEach(() => {
  closeMachineDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MACULA_MCP_RINGS_DB;
});

describe("the rows are written once", () => {
  it("a placed ring is written once: the same ring id again is the same ring, not a second one", () => {
    expect(ringPlaced(seed("1".repeat(32), "out"))).toBe(true);
    expect(ringPlaced(seed("1".repeat(32), "out"))).toBe(false);
  });

  it("a received ring is written once, answered or not", () => {
    expect(ringReceived({ ...seed("2".repeat(32), "in"), answer: 1 })).toBe(true);
    expect(ringReceived({ ...seed("2".repeat(32), "in"), answer: null })).toBe(false);
    expect(getRing("2".repeat(32), ME)?.answer).toBe(1);
  });
});

describe("answers only move forward", () => {
  it("a deferral may be answered later, and a decided answer is final whatever arrives after it", () => {
    ringPlaced(seed("3".repeat(32), "out"));
    expect(ringReply("3".repeat(32), 3)).toBe(true);
    expect(ringReply("3".repeat(32), 1, "in")).toBe(true);
    // A late reply, a second ring_answer: nothing moves a decided answer.
    expect(ringReply("3".repeat(32), 2, "out")).toBe(false);
    expect(getRing("3".repeat(32), THEM)?.answer).toBe(1);
  });

  it("unreachable is not an answer: the reason is recorded and an answer can still arrive", () => {
    ringPlaced(seed("4".repeat(32), "out"));
    expect(ringReply("4".repeat(32), null, "unreachable: not serving")).toBe(true);
    expect(getRing("4".repeat(32), THEM)?.answer).toBeNull();
    expect(getRing("4".repeat(32), THEM)?.reason).toBe("unreachable: not serving");
    expect(ringReply("4".repeat(32), 1)).toBe(true);
    expect(getRing("4".repeat(32), THEM)?.answer).toBe(1);
  });
});

describe("a deferred ring is claimed before it is answered", () => {
  it("one claim wins and the second sees it is taken, so two answers cannot both proceed", () => {
    ringReceived({ ...seed("5".repeat(32), "in"), answer: null });
    const first = claimDeferredRing("5".repeat(32), ME);
    const second = claimDeferredRing("5".repeat(32), ME);

    expect(first.ok).toBe(1);
    expect(second.ok).toBe(0);
    expect(second.ok === 0 && second.reason).toBe("answered");
  });

  it("an answered ring cannot be claimed, and answers nothing", () => {
    ringReceived({ ...seed("6".repeat(32), "in"), answer: 2 });
    const claim = claimDeferredRing("6".repeat(32), ME);
    expect(claim.ok).toBe(0);
    expect(claim.ok === 0 && claim.reason).toBe("answered");
  });

  it("a released claim writes nothing, and leaves the ring answerable", () => {
    ringReceived({ ...seed("7".repeat(32), "in"), answer: null });
    const claim = claimDeferredRing("7".repeat(32), ME);
    expect(claim.ok).toBe(1);
    if (claim.ok === 0) return;

    releaseClaim("7".repeat(32), claim.token);
    expect(answerClaimedRing("7".repeat(32), claim.token, 1)).toBe(false);
    expect(getRing("7".repeat(32), ME)?.answer).toBeNull();

    const again = claimDeferredRing("7".repeat(32), ME);
    expect(again.ok).toBe(1);
    if (again.ok === 0) return;
    expect(answerClaimedRing("7".repeat(32), again.token, 1)).toBe(true);
    expect(getRing("7".repeat(32), ME)?.answer).toBe(1);
  });

  it("a claim the first attempt still holds loses to nobody, and one left behind by a dead process is taken over", () => {
    ringReceived({ ...seed("8".repeat(32), "in"), answer: null });
    const held = claimDeferredRing("8".repeat(32), ME);
    expect(held.ok).toBe(1);
    // Two minutes later the holder is assumed dead: the ring must not become unanswerable.
    machineDb()
      .prepare("UPDATE rings SET claimed_at = ? WHERE ring_id = ? AND direction = 'in'")
      .run(new Date(Date.now() - CLAIM_TTL_MS - 1000).toISOString(), "8".repeat(32));
    const takenOver = claimDeferredRing("8".repeat(32), ME);
    expect(takenOver.ok).toBe(1);
    if (held.ok === 0 || takenOver.ok === 0) return;
    // The process that lost the claim cannot answer with it.
    expect(answerClaimedRing("8".repeat(32), held.token, 2)).toBe(false);
    expect(answerClaimedRing("8".repeat(32), takenOver.token, 2)).toBe(true);
  });
});

// The second writer is a second CONNECTION to the same file, which is what a second process on the box is
// (rings.sqlite3 is shared per machine). What must hold across them is that a conditional UPDATE decides.
describe("two connections on one file", () => {
  it("one answer lands, whichever connection writes first", () => {
    ringReceived({ ...seed("9".repeat(32), "in"), answer: null });
    const other = new DatabaseSync(process.env.MACULA_MCP_RINGS_DB as string);
    const claim = claimDeferredRing("9".repeat(32), ME);
    expect(claim.ok).toBe(1);
    if (claim.ok === 0) return;

    // The other process answers the same row behind our claim, the way a stale second attempt would.
    const theirs = other
      .prepare("UPDATE rings SET answer = 1, answered_at = ? WHERE ring_id = ? AND direction = 'in' AND answer IS NULL")
      .run(new Date().toISOString(), "9".repeat(32));
    expect(Number(theirs.changes)).toBe(1);
    other.close();

    // Our answer arrives after: the row is decided, so it does not land.
    expect(answerClaimedRing("9".repeat(32), claim.token, 2)).toBe(false);
    expect(getRing("9".repeat(32), ME)?.answer).toBe(1);
  });
});
