// What a subscription feed lost, made loud: the count a feed tool reports as
// `dropped`, the words it says that count in, and a warning on stderr the
// moment the count grows. @macula-io/ts's Subscription.dropped() is the
// source; a subscription's inbox holds 256 events and drops the newest while
// its reader is behind.
import type { Subscription } from "@macula-io/ts";

const INBOX = "a subscription's inbox holds 256 events and discards the newest while its reader is behind";

/**
 * What a `dropped` count means, as a reply states it beside the count. It
 * counts events that REACHED a listener and were discarded there, never
 * events the mesh did not deliver, so 0 is "nothing that arrived was
 * discarded", not a claim that the feed is complete. Three kinds:
 * subscription (a watch, presence: since that subscription began), transcript
 * (a room or central: every loss recorded beside the facts, durable and shared
 * like them) and wait (a room or central: during that one wait).
 */
export const DROPPED_MEANS = {
  subscription: `events that reached this server's subscription and were discarded (${INBOX}), since it began; 0 means none were discarded, null means nothing is listening`,
  transcript: `events on this topic that reached a listener on this machine and were discarded before being recorded (${INBOX}), summed over every listener sharing the transcript since macula-mcp 0.35.0; 0 means none were discarded`,
  wait: `events on this topic discarded during this wait, before they could be read (${INBOX}); 0 means none were discarded`,
} as const;

/** The terse descriptions' sentence about `dropped`. */
export const DROPPED_DESCRIPTION_TERSE = "dropped: events discarded after arriving (0 = none).";

const warnedAt = new WeakMap<Subscription, number>();
const lossHooks = new WeakMap<Subscription, (lost: number) => void>();

/** Has `hook` told of every growth of `sub`'s drop count from now on, by how much, whoever notices it (a delivery or a read). */
export function onLoss(sub: Subscription, hook: (lost: number) => void): void {
  lossHooks.set(sub, hook);
}

/** How many events `sub` (on `topic`) dropped since it started, with a warning on stderr, and its loss hook told, whenever that grew since the last look. */
export function droppedEvents(topic: string, sub: Subscription): number {
  const dropped = sub.dropped();
  const before = warnedAt.get(sub) ?? 0;
  if (dropped > before) {
    // The hook first: if recording fails, the growth is not marked seen, and the next look retries it.
    lossHooks.get(sub)?.(dropped - before);
    warnedAt.set(sub, dropped);
    console.error(`macula-mcp: the subscription to ${topic} lost ${dropped - before} event(s), ${dropped} in all: its reader fell behind`);
  }
  return dropped;
}
