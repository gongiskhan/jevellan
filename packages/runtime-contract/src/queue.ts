export class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;
  push(value: T): void {
    if (this.#closed) throw new Error('Event stream is closed.');
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false }); else this.#items.push(value);
  }
  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => {
      if (this.#items.length) return Promise.resolve({ value: this.#items.shift()!, done: false });
      if (this.#closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => this.#waiters.push(resolve));
    } };
  }
}
