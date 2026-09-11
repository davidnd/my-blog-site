/**
 * A real WebSocket client for the tests, using Node's built-in WebSocket so the
 * server is exercised over an actual socket rather than through a stub.
 */

import type { ClientMessage, ServerMessage } from '../../src/shared/types.ts';

const DEFAULT_TIMEOUT_MS = 2000;

export class TestClient {
  #socket: WebSocket;
  #received: ServerMessage[] = [];
  #waiting: Array<() => void> = [];

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      this.#received.push(JSON.parse(String(event.data)) as ServerMessage);
      for (const wake of this.#waiting.splice(0)) wake();
    });
  }

  /**
   * `query` carries the Cloudflare routing parameters. The Node server reads
   * the same ones, so a test can point either transport at the same helper.
   */
  static async connect(port: number, query = ''): Promise<TestClient> {
    const socket = new WebSocket(`ws://localhost:${port}/ws${query === '' ? '' : `?${query}`}`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('socket failed to open')), {
        once: true,
      });
    });
    return new TestClient(socket);
  }

  send(message: ClientMessage): void {
    this.#socket.send(JSON.stringify(message));
  }

  /** Sends bytes verbatim, for testing what the server does with garbage. */
  sendRaw(payload: string): void {
    this.#socket.send(payload);
  }

  /** Drops anything already received, so the next `next()` sees only new traffic. */
  drain(): void {
    this.#received.length = 0;
  }

  /** Waits for the next message of a given type, ignoring and consuming others. */
  async next<T extends ServerMessage['type']>(
    type: T,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.#received.findIndex((message) => message.type === type);
      if (index !== -1) {
        const [message] = this.#received.splice(index, 1);
        return message as Extract<ServerMessage, { type: T }>;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `timed out waiting for "${type}"; got ${JSON.stringify(this.#received)}`,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.#waiting.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Asserts nothing arrived in a short window — used to prove a move was ignored. */
  async expectSilence(ms = 150): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (this.#received.length > 0) {
      throw new Error(`expected no messages, got ${JSON.stringify(this.#received)}`);
    }
  }

  /**
   * A hibernating Durable Object can take its time answering the close
   * handshake, and a test has nothing to learn from waiting: the socket is shut
   * locally the moment close() returns. So the acknowledgement is given a short
   * budget rather than an unbounded one.
   */
  async close(timeoutMs = 500): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) =>
      this.#socket.addEventListener('close', () => resolve(), { once: true }),
    );
    this.#socket.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }
}
