export type PendingEntry = {
  connectionId: string;
  discard: () => void;
};

export class PendingChannelQueue<T extends PendingEntry> {
  private readonly entries = new Map<string, T[]>();
  private totalEntries = 0;

  constructor(
    private readonly limits: {
      channels: number;
      entries: number;
      entriesPerChannel: number;
    },
  ) {}

  enqueue(channel: string, entry: T): boolean {
    const existing = this.entries.get(channel);
    if (
      this.totalEntries >= this.limits.entries ||
      (!existing && this.entries.size >= this.limits.channels) ||
      (existing?.length ?? 0) >= this.limits.entriesPerChannel
    ) {
      entry.discard();
      return false;
    }
    const channelEntries = existing ?? [];
    channelEntries.push(entry);
    this.entries.set(channel, channelEntries);
    this.totalEntries += 1;
    return true;
  }

  drain(channel: string): T[] {
    const entries = this.entries.get(channel) ?? [];
    if (entries.length > 0) {
      this.entries.delete(channel);
      this.totalEntries -= entries.length;
    }
    return entries;
  }

  removeConnection(connectionId: string): void {
    for (const [channel, entries] of this.entries) {
      const retained = entries.filter((entry) => {
        if (entry.connectionId !== connectionId) {
          return true;
        }
        entry.discard();
        this.totalEntries -= 1;
        return false;
      });
      if (retained.length === 0) {
        this.entries.delete(channel);
      } else {
        this.entries.set(channel, retained);
      }
    }
  }

  get size(): number {
    return this.totalEntries;
  }
}
