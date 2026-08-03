type TransformLine = (line: string) => Promise<string>;
type WriteLine = (line: string) => Promise<void>;

function orderingKey(line: string): string {
  try {
    const message = JSON.parse(line) as { params?: { threadId?: unknown } };
    const threadId = message.params?.threadId;
    return typeof threadId === "string" && threadId ? `thread:${threadId}` : "global";
  } catch {
    return "global";
  }
}

/**
 * Preserves ordering inside one Codex thread while allowing unrelated threads
 * and global protocol traffic to bypass a slow local classification.
 */
export class ClientLineDispatcher {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly pending = new Set<Promise<void>>();
  private writeQueue = Promise.resolve();

  constructor(
    private readonly transform: TransformLine,
    private readonly write: WriteLine,
  ) {}

  dispatch(line: string): void {
    const key = orderingKey(line);
    const previous = this.chains.get(key) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        let transformed = line;
        try {
          transformed = await this.transform(line);
        } catch {
          // Transform errors are byte-for-byte fail-open.
        }
        await this.enqueueWrite(transformed);
      })
      .catch(() => undefined);

    this.chains.set(key, task);
    this.pending.add(task);
    void task.then(() => {
      this.pending.delete(task);
      if (this.chains.get(key) === task) this.chains.delete(key);
    });
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
    await this.writeQueue;
  }

  private async enqueueWrite(line: string): Promise<void> {
    const queued = this.writeQueue
      .catch(() => undefined)
      .then(() => this.write(line));
    this.writeQueue = queued.catch(() => undefined);
    await queued;
  }
}
