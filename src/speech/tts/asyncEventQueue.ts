interface QueuedEvent<T> {
  value?: T;
  done?: boolean;
}

/** Minimal async queue shared by streaming TTS providers. */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly events: QueuedEvent<T>[] = [];
  private readonly waiters: Array<(event: QueuedEvent<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value });
    else this.events.push({ value });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: true });
    else this.events.push({ done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const event = this.events.shift() || await new Promise<QueuedEvent<T>>((resolve) => this.waiters.push(resolve));
      if (event.done) return;
      if (event.value !== undefined) yield event.value;
    }
  }
}
