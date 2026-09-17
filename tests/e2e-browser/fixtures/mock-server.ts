import http from "http";
import type { AddressInfo } from "net";

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
  readonly timestamp: number;
}

export class MockHttpServer {
  private server: http.Server | null = null;
  private port: number = 0;
  private requests: RecordedRequest[] = [];

  public async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });

        req.on("end", () => {
          // Record request safely (sanitize sensitive values if any)
          const sanitizedHeaders: Record<
            string,
            string | string[] | undefined
          > = {
            ...req.headers,
          };
          if (sanitizedHeaders.authorization) {
            sanitizedHeaders.authorization = "[REDACTED_PRESENT]";
          }

          this.requests.push({
            method: req.method || "GET",
            url: req.url || "/",
            headers: sanitizedHeaders,
            body,
            timestamp: Date.now(),
          });

          // Handle routes
          const url = req.url || "/";

          // CORS headers for extension fetch testing
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader(
            "Access-Control-Allow-Methods",
            "GET, POST, PUT, DELETE, OPTIONS",
          );
          res.setHeader(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, X-Requested-With",
          );

          if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
          }

          if (url === "/api/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok" }));
            return;
          }

          if (url === "/api/test-echo") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                receivedMethod: req.method,
                receivedHeaders: sanitizedHeaders,
                receivedBody: body,
              }),
            );
            return;
          }

          if (url === "/api/slow") {
            // Delay 3 seconds for abort testing
            setTimeout(() => {
              if (!res.writableEnded) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ delayed: true }));
              }
            }, 3000);
            return;
          }

          if (url.startsWith("/pages/mock-leetcode")) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`<!DOCTYPE html>
<html>
<head><title>Mock LeetCode</title></head>
<body>
  <h1>Mock LeetCode Problem</h1>
  <div id="submission-result">Accepted</div>
</body>
</html>`);
            return;
          }

          if (url.startsWith("/pages/hostile")) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`<!DOCTYPE html>
<html>
<head><title>Hostile Page</title></head>
<body>
  <h1>Hostile Test Page</h1>
  <script>
    // Adversarial attempts:
    window.attackLog = [];
    try {
      if (window.chrome && window.chrome.runtime) {
        window.attackLog.push('chrome.runtime exposed to page');
      } else {
        window.attackLog.push('chrome.runtime NOT exposed');
      }
    } catch(e) {
      window.attackLog.push('chrome.runtime access error: ' + e.message);
    }

    try {
      Object.prototype.polluted = 'adversarial_prototype';
      window.attackLog.push('prototype polluted in page window');
    } catch(e) {
      window.attackLog.push('prototype pollution error: ' + e.message);
    }
  </script>
</body>
</html>`);
            return;
          }

          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
        });
      });

      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address() as AddressInfo;
        this.port = addr.port;
        resolve(this.port);
      });

      this.server.on("error", reject);
    });
  }

  public getPort(): number {
    return this.port;
  }

  public getBaseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  public getRequests(): readonly RecordedRequest[] {
    return this.requests;
  }

  public clearRequests(): void {
    this.requests = [];
  }

  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        this.server = null;
      } else {
        resolve();
      }
    });
  }
}
