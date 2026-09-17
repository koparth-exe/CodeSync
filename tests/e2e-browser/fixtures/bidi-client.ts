/**
 * Minimal, zero-dependency WebDriver BiDi client for Firefox testing.
 * Communicates over Firefox's native WebSocket BiDi session on --remote-debugging-port.
 */

export interface BiDiResponse {
  readonly type?: string;
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: string;
  readonly message?: string;
  readonly method?: string;
  readonly params?: unknown;
}

export class WebDriverBiDiClient {
  private ws: WebSocket | null = null;
  private messageId: number = 0;
  private pendingCallbacks: Map<
    number,
    { resolve: (val: unknown) => void; reject: (err: Error) => void }
  > = new Map();
  private eventListeners: Array<(event: BiDiResponse) => void> = [];

  constructor(private readonly wsUrl: string) {}

  public async connect(timeoutMs: number = 15000): Promise<void> {
    const startTime = Date.now();
    let lastError: Error | null = null;

    while (Date.now() - startTime < timeoutMs) {
      try {
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(this.wsUrl);

          ws.onopen = () => {
            this.ws = ws;
            ws.onerror = (_err) => {
              // Runtime errors after connection
            };
            ws.onmessage = (event) => {
              try {
                const data: BiDiResponse = JSON.parse(event.data.toString());
                if (data.id && this.pendingCallbacks.has(data.id)) {
                  const cb = this.pendingCallbacks.get(data.id)!;
                  this.pendingCallbacks.delete(data.id);
                  if (data.error) {
                    cb.reject(
                      new Error(
                        `BiDi command ${data.id} error: ${data.error} - ${data.message}`,
                      ),
                    );
                  } else {
                    cb.resolve(data.result);
                  }
                } else {
                  for (const listener of this.eventListeners) {
                    listener(data);
                  }
                }
              } catch {
                // Ignore parse errors from non-json frames
              }
            };
            resolve();
          };

          ws.onerror = (err) => {
            reject(new Error(`WebSocket connection failed: ${String(err)}`));
          };
        });
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    throw new Error(
      `BiDi connection timed out after ${timeoutMs}ms to ${this.wsUrl}: ${lastError?.message}`,
    );
  }

  public async sendCommand<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = 10000,
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("BiDi WebSocket is not connected");
    }

    const id = ++this.messageId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCallbacks.delete(id);
        reject(
          new Error(
            `BiDi command ${method} (id=${id}) timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      this.pendingCallbacks.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  public onEvent(listener: (event: BiDiResponse) => void): void {
    this.eventListeners.push(listener);
  }

  public async newSession(): Promise<unknown> {
    return this.sendCommand("session.new", { capabilities: {} });
  }

  public async installExtension(
    extensionPath: string,
  ): Promise<{ extension: string }> {
    return this.sendCommand<{ extension: string }>("webExtension.install", {
      extensionData: {
        type: "path",
        path: extensionPath,
      },
    });
  }

  public async getBrowsingContexts(): Promise<unknown> {
    return this.sendCommand("browsingContext.getTree", {});
  }

  public async createBrowsingContext(
    type: "tab" | "window" = "tab",
  ): Promise<{ context: string }> {
    return this.sendCommand<{ context: string }>("browsingContext.create", {
      type,
    });
  }

  public async navigate(contextId: string, url: string): Promise<unknown> {
    return this.sendCommand("browsingContext.navigate", {
      context: contextId,
      url,
      wait: "complete",
    });
  }

  public async evaluate<T = unknown>(
    contextId: string,
    expression: string,
  ): Promise<T> {
    return this.sendCommand<T>("script.evaluate", {
      expression,
      target: { context: contextId },
      awaitPromise: true,
      resultOwnership: "none",
    });
  }

  public async close(): Promise<void> {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.pendingCallbacks.clear();
    this.eventListeners = [];
  }
}
