// Petnames: a deterministic, human-readable label for a mesh node id --
// Docker's adjective_color_animal convention with a four-digit suffix
// (e.g. "happy_green_rabbit_4831")
// -- so a person skimming a roster, transcript, or room listing can
// recognize and remember a specific identity without reading 64 hex
// characters. A pure function of the node id itself, not random per
// process: the same identity gets the same petname across restarts,
// across every tool that shows it, and on every other agent's own
// roster too (everyone hashes the same public bytes). This is a
// companion label, never a replacement -- every surface that adds one
// keeps the real node_id right alongside it, since only the real id is
// addressable.
//
// The suffix exists because the mesh is expected to host THOUSANDS of
// agents: the word trio alone (64,000 combinations) collides visibly
// under the birthday problem at a few hundred identities; the trio
// plus a 4-digit hash group (640,000,000 combinations) stays
// effectively collision-free at fleet scale. Two different identities
// landing on the same petname would still be a cosmetic coincidence a
// reader resolves by checking the node_id itself, the same way two
// people can share a name.

import { createHash } from "node:crypto";

/** Mood/feeling words. */
const ADJECTIVES_A = [
  "bold", "bouncy", "brave", "breezy", "calm", "cheerful", "clever", "curious",
  "daring", "eager", "elegant", "fierce", "gentle", "graceful", "humble", "jolly",
  "jovial", "keen", "kind", "lively", "lucky", "mellow", "merry", "nimble",
  "noble", "plucky", "proud", "quiet", "quirky", "radiant", "silly", "sleepy",
  "spry", "sturdy", "tranquil", "upbeat", "vivid", "wise", "witty", "zealous",
];

/** Color words. */
const ADJECTIVES_B = [
  "amber", "azure", "bronze", "coral", "crimson", "cyan", "emerald", "golden",
  "green", "indigo", "ivory", "jade", "lavender", "lilac", "magenta", "maroon",
  "mauve", "navy", "olive", "orange", "peach", "pink", "plum", "purple",
  "red", "rust", "ruby", "sage", "salmon", "scarlet", "sienna", "silver",
  "slate", "tan", "teal", "turquoise", "violet", "yellow", "blue", "copper",
];

/** Animal nouns. */
const NOUNS = [
  "antelope", "badger", "beetle", "bison", "cricket", "dolphin", "eagle", "elk",
  "falcon", "ferret", "flamingo", "fox", "gazelle", "gecko", "hare", "heron",
  "ibex", "iguana", "lynx", "marten", "mongoose", "moose", "narwhal", "orca",
  "otter", "owl", "panther", "pelican", "penguin", "rabbit", "raven", "salamander",
  "seal", "sparrow", "tiger", "toucan", "walrus", "weasel", "wolf", "wombat",
];

/**
 * A stable "adjective_adjective_noun" label for `nodeId`, e.g.
 * "happy_green_rabbit". Same input always produces the same output --
 * derived from a sha256 digest of the id (lowercased first, so a node
 * id that happens to arrive in mixed case still maps to the same
 * petname as its lowercase form), not from anything process-local like
 * a random seed or insertion order.
 */
export function petname(nodeId: string): string {
  const digest = createHash("sha256").update(nodeId.toLowerCase()).digest();
  const a = ADJECTIVES_A[digest.readUInt16BE(0) % ADJECTIVES_A.length];
  const b = ADJECTIVES_B[digest.readUInt16BE(2) % ADJECTIVES_B.length];
  const n = NOUNS[digest.readUInt16BE(4) % NOUNS.length];
  const suffix = String(digest.readUInt16BE(6) % 10_000).padStart(4, "0");
  return `${a}_${b}_${n}_${suffix}`;
}
