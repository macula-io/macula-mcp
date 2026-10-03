import { describe, expect, it } from "vitest";
import { operatorActionText, pendingContent } from "./mesh_join_realm.js";
import type { BeginResult } from "./realm.js";

// The regression this guards: the pending join's link is a bearer link,
// redacted everywhere else (realm.ts's status()/redactPending), so a model
// that summarizes the tool result into "a join is pending" leaves the
// operator with no way to confirm. The action block must carry the link
// verbatim and lead the result.

const BEGAN: BeginResult = {
  session_id: "01a1025d-9e29-7b0c-9e7e-c572a7078e2a",
  join_url: "https://realm.macula.io/join/01a1025d-9e29-7b0c-9e7e-c572a7078e2a",
  expires_at: "2026-10-03T15:34:12Z",
  node_id: "a".repeat(64),
  reused: false,
  qr_terminal: "QR-ASCII",
  qr_png_base64: "aGk=",
};

const texts = (content: { type: string; text?: string }[]): string[] =>
  content.filter((c) => c.type === "text").map((c) => c.text ?? "");

describe("mesh_join_realm pending content", () => {
  it("leads the result with an OPERATOR ACTION block carrying the join_url verbatim", () => {
    const content = pendingContent(BEGAN, "/tmp/node.key");
    expect(content[0].type).toBe("text");
    expect(texts(content)[0].startsWith("OPERATOR ACTION REQUIRED")).toBe(true);
    expect(texts(content)[0]).toContain(BEGAN.join_url);
    expect(texts(content)[0]).toContain(BEGAN.node_id);
    expect(texts(content)[0]).toContain(BEGAN.expires_at);
  });

  it("keeps the action block before the JSON and the QR/image blocks", () => {
    const content = pendingContent(BEGAN, "/tmp/node.key");
    const actionAt = texts(content).findIndex((t) => t.startsWith("OPERATOR ACTION REQUIRED"));
    const jsonAt = texts(content).findIndex((t) => t.includes('"status": "pending"'));
    expect(actionAt).toBe(0);
    expect(jsonAt).toBeGreaterThan(actionAt);
    expect(content.some((c) => c.type === "image")).toBe(true);
    expect(texts(content).join("\n")).toContain("Scan to join:");
  });

  it("names the operator-facing action in the structured block too", () => {
    const json = texts(pendingContent(BEGAN, "/tmp/node.key")).find((t) => t.includes('"status": "pending"'));
    expect(json).toBeDefined();
    expect(json).toContain("Show the person this link");
  });
});
