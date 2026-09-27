// What a subscription feed lost, made loud: the count a feed tool reports as
// `dropped`, the words it says that count in, and a warning on stderr the
// moment the count grows. @macula-io/ts's Subscription.dropped() is the
// source; a subscription's inbox holds 256 events and drops the newest while
// its reader is behind.
import type { Subscription } from "@macula-io/ts";

/**
 * What a feed's `dropped` count means, as the tools reading a feed state it:
 * events this server lost on that feed since it began listening, 0 when none
 * were lost, null when nothing listens to it. A subscription's inbox holds
 * 256 events and drops the newest while its reader is behind.
 */
export const DROPPED_MEANS =
  "events this server lost on the feed since it began listening (its inbox holds 256 and drops the newest while the reader is behind); 0 means none were lost, null means nothing is listening to that feed";

/** The sentence a feed tool's description carries about its `dropped` counts (full, then terse). */
export const DROPPED_DESCRIPTION =
  "`dropped` counts the events this server lost on that feed since it began listening (a reader 256 behind loses the newest): 0 means none were lost, null means nothing is listening to it.";
export const DROPPED_DESCRIPTION_TERSE = "dropped: events lost on the feed (0 = none, null = not listening).";

const warnedAt = new WeakMap<Subscription, number>();

/** How many events `sub` (on `topic`) dropped since it started, with a warning on stderr whenever that grew since the last look. */
export function droppedEvents(topic: string, sub: Subscription): number {
  const dropped = sub.dropped();
  const before = warnedAt.get(sub) ?? 0;
  if (dropped > before) {
    warnedAt.set(sub, dropped);
    console.error(`macula-mcp: the subscription to ${topic} lost ${dropped - before} event(s), ${dropped} in all: its reader fell behind`);
  }
  return dropped;
}
