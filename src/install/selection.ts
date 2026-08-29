// Pure parsing logic for bin/install.ts's interactive client picker.
// Lives here, not in bin/install.ts, so it can be imported and tested
// without triggering that file's unconditional `main()` call at module
// load -- bin/install.ts is a script, not a library, and importing a
// script for its logic would run the whole installer as a side effect.

/**
 * Parses the raw line typed at "Register with which?" into the chosen
 * 1-based indices, or "all" for empty input (Enter) or input that
 * resolves to zero valid indices (out-of-range numbers, garbage text --
 * never silently register with nothing just because the input was
 * unparseable).
 */
export function parseSelection(raw: string, count: number): "all" | Set<number> {
  const trimmed = raw.trim();
  if (trimmed === "") return "all";
  const chosen = new Set(
    trimmed
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= count),
  );
  return chosen.size === 0 ? "all" : chosen;
}
