import { describe, expect, it } from "vitest";
import { inboxTopic } from "./inbox.js";

describe("inboxTopic", () => {
  it("is deterministic: the same node_id always yields the same topic", () => {
    const nodeId = "b".repeat(64);
    expect(inboxTopic(nodeId)).toBe(inboxTopic(nodeId));
  });

  it("differs per node_id, so two agents never share an inbox", () => {
    expect(inboxTopic("a".repeat(64))).not.toBe(inboxTopic("b".repeat(64)));
  });

  it("embeds the node_id verbatim, so it's computable from just the id, no lookup", () => {
    const nodeId = "c".repeat(64);
    expect(inboxTopic(nodeId)).toBe(`agents.dm.${nodeId}`);
  });
});
