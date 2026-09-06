import { beforeEach, describe, expect, it } from "vitest";
import { resetWaitingHintsForTests, waitingHint } from "./mesh_read_inbox.js";

const ME = "a".repeat(64);
const THEM = "b".repeat(64);
const ROOM = `agents.room.${"1".repeat(32)}`;

beforeEach(() => {
  resetWaitingHintsForTests();
});

describe("waitingHint", () => {
  it("says nothing the first time this room is read, even if I am the last speaker (that's just a normal check)", () => {
    expect(waitingHint(ROOM, { message_id: "e".repeat(32), from: ME }, ME)).toBeUndefined();
  });

  it("says nothing at all when the last speaker is someone else", () => {
    expect(waitingHint(ROOM, { message_id: "e".repeat(32), from: THEM }, ME)).toBeUndefined();
  });

  it("says nothing when the room has no messages, or `me` is unknown (presence not active)", () => {
    expect(waitingHint(ROOM, undefined, ME)).toBeUndefined();
    expect(waitingHint(ROOM, { message_id: "e".repeat(32), from: ME }, undefined)).toBeUndefined();
  });

  it("fires exactly once when a SECOND read of the same room still shows the same standing message from me", () => {
    const msg = { message_id: "e".repeat(32), from: ME };
    expect(waitingHint(ROOM, msg, ME)).toBeUndefined(); // first read: establishes the episode
    expect(waitingHint(ROOM, msg, ME)).toEqual(expect.stringContaining("mesh_wait_room"));
    expect(waitingHint(ROOM, msg, ME)).toBeUndefined(); // third read: already nudged for this exact standing message
  });

  it("starts a fresh, quiet episode once I send another message myself", () => {
    const first = { message_id: "e".repeat(32), from: ME };
    waitingHint(ROOM, first, ME);
    waitingHint(ROOM, first, ME); // hinted once
    const second = { message_id: "f".repeat(32), from: ME };
    expect(waitingHint(ROOM, second, ME)).toBeUndefined(); // new episode, quiet again
    expect(waitingHint(ROOM, second, ME)).toEqual(expect.stringContaining("mesh_wait_room")); // then nudges again on the repeat
  });

  it("clears the episode once someone else replies, so a LATER wait by me starts fresh rather than staying silenced", () => {
    const mine = { message_id: "e".repeat(32), from: ME };
    waitingHint(ROOM, mine, ME);
    waitingHint(ROOM, mine, ME); // hinted
    waitingHint(ROOM, { message_id: "f".repeat(32), from: THEM }, ME); // they replied -- episode over
    const mineAgain = { message_id: "g".repeat(32), from: ME };
    expect(waitingHint(ROOM, mineAgain, ME)).toBeUndefined(); // fresh episode
    expect(waitingHint(ROOM, mineAgain, ME)).toEqual(expect.stringContaining("mesh_wait_room"));
  });

  it("tracks each room topic independently", () => {
    const room2 = `agents.room.${"2".repeat(32)}`;
    const msg = { message_id: "e".repeat(32), from: ME };
    waitingHint(ROOM, msg, ME);
    expect(waitingHint(ROOM, msg, ME)).toBeDefined();
    expect(waitingHint(room2, msg, ME)).toBeUndefined(); // a different room's episode hasn't started yet
  });

  it("points at mesh://etiquette and both the blocking and scheduler alternatives, not just one", () => {
    const msg = { message_id: "e".repeat(32), from: ME };
    waitingHint(ROOM, msg, ME);
    const hint = waitingHint(ROOM, msg, ME);
    expect(hint).toContain("mesh_wait_room");
    expect(hint).toContain("scheduler");
    expect(hint).toContain("mesh://etiquette");
  });
});
