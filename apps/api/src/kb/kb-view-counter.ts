/**
 * Counts an article view at most once per reader per article per UTC day.
 *
 * Kept in memory: it only has to stop refreshes and repeat visits from
 * inflating the counter, and losing it on restart (or running several API
 * replicas) at worst counts a reader once more that day. The map is cleared at
 * the day boundary and capped, so it can't grow without bound.
 */
export class KbViewCounter {
  private day: string = "";
  private seen = new Set<string>();

  constructor(private readonly maxEntries: number = 100_000) {}

  /** True if this view should be counted (and remembers it). */
  shouldCount(readerKey: string, articleId: string, now: Date = new Date()): boolean {
    const today: string = now.toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.seen.clear();
    }
    const key = `${readerKey}:${articleId}`;
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.maxEntries) this.seen.clear();
    this.seen.add(key);
    return true;
  }
}
