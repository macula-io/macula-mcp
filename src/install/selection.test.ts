import { describe, expect, it } from "vitest";
import { parseSelection } from "./selection.js";

describe("parseSelection", () => {
  it("treats empty input (bare Enter) as 'all'", () => {
    expect(parseSelection("", 3)).toBe("all");
    expect(parseSelection("   ", 3)).toBe("all");
  });

  it("parses a single number", () => {
    expect(parseSelection("2", 3)).toEqual(new Set([2]));
  });

  it("parses comma-separated numbers, trimming whitespace", () => {
    expect(parseSelection("1, 3", 3)).toEqual(new Set([1, 3]));
  });

  it("de-duplicates repeated indices", () => {
    expect(parseSelection("1,1,1", 3)).toEqual(new Set([1]));
  });

  it("falls back to 'all' rather than registering with nothing, on out-of-range numbers", () => {
    expect(parseSelection("9", 3)).toBe("all");
  });

  it("falls back to 'all' on unparseable garbage", () => {
    expect(parseSelection("nope", 3)).toBe("all");
  });

  it("keeps only the valid numbers when a selection mixes valid and out-of-range", () => {
    expect(parseSelection("1,9,2", 3)).toEqual(new Set([1, 2]));
  });
});
