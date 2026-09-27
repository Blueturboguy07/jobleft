// Load shedding per client (JL-settings-19). A burst of thousands of requests used to run every handler back to
// back: each one is synchronous SQLite work, so 5,000 requests held the event loop for about two minutes and even
// health did not answer. Now every handler waits for its turn in its client's queue (the app window, each paired
// extension): one waiting request per client runs per turn of the event loop, so new requests and health are read
// in between, and a client with too many requests already waiting gets 429 at once (cheap: no handler runs).

export const MAX_WAITING_PER_CLIENT = 128;

export class Turnstile {
  private readonly queues = new Map<string, Array<() => void>>();
  private scheduled = false;
  private readonly maxWaiting: number;

  constructor(maxWaiting = MAX_WAITING_PER_CLIENT) { this.maxWaiting = maxWaiting; }

  /** Resolves when it is this request's turn, or returns null when this client already has too many waiting. */
  enter(client: string): Promise<void> | null {
    let q = this.queues.get(client);
    if (q && q.length >= this.maxWaiting) return null;
    if (!q) { q = []; this.queues.set(client, q); }
    const queue = q;
    const turn = new Promise<void>((resolve) => { queue.push(resolve); });
    this.schedule();
    return turn;
  }

  /** Requests waiting for their turn, all clients together. */
  waiting(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    // setImmediate, not a microtask: the poll phase (new connections, health) runs between two turns.
    setImmediate(() => this.turn());
  }

  private turn(): void {
    this.scheduled = false;
    for (const [client, q] of this.queues) {
      const next = q.shift();
      if (q.length === 0) this.queues.delete(client);
      next?.();
    }
    if (this.queues.size) this.schedule();
  }
}
