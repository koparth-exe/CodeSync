import fs from "fs";
import path from "path";

export interface EvidenceRecord {
  readonly testId: string;
  readonly browser: "chromium" | "firefox";
  readonly browserVersion: string;
  readonly extensionVersion: string;
  readonly manifestVersion: number;
  readonly timestamp: string;
  readonly status: "PASS" | "FAIL" | "SKIPPED" | "LIMITATION";
  readonly relevantRuntimeState?: Record<string, unknown>;
  readonly relevantStorageState?: Record<string, unknown>;
  readonly relevantIndexedDBState?: Record<string, unknown>;
  readonly consoleErrors?: readonly string[];
  readonly relevantNetworkResults?: Record<string, unknown>;
  readonly invariantsExercised: readonly string[];
  readonly notes?: string;
}

export class EvidenceCollector {
  private static instance: EvidenceCollector | null = null;
  private records: EvidenceRecord[] = [];
  private outputDir: string;

  constructor(outputDir?: string) {
    this.outputDir =
      outputDir || path.resolve(process.cwd(), "tests/e2e-browser/evidence");
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  public static getInstance(): EvidenceCollector {
    if (!EvidenceCollector.instance) {
      EvidenceCollector.instance = new EvidenceCollector();
    }
    return EvidenceCollector.instance;
  }

  /**
   * Sanitizes any object before saving to ensure credentials/tokens/cookies are never captured.
   */
  private sanitize(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === "string") {
      // Redact known token patterns or passwords if encountered
      if (
        /ghp_[a-zA-Z0-9]{36}/.test(obj) ||
        /github_pat_[a-zA-Z0-9_]{82}/.test(obj)
      ) {
        return "[REDACTED_GITHUB_TOKEN]";
      }
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this.sanitize(item));
    }
    if (typeof obj === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();
        if (
          lowerKey.includes("token") ||
          lowerKey.includes("secret") ||
          lowerKey.includes("password") ||
          lowerKey.includes("cookie") ||
          lowerKey.includes("auth")
        ) {
          result[key] = "[REDACTED_PRESENCE_ONLY]";
        } else {
          result[key] = this.sanitize(value);
        }
      }
      return result;
    }
    return obj;
  }

  public record(evidence: EvidenceRecord): void {
    const sanitizedRecord: EvidenceRecord = {
      ...evidence,
      relevantRuntimeState: this.sanitize(
        evidence.relevantRuntimeState,
      ) as Record<string, unknown>,
      relevantStorageState: this.sanitize(
        evidence.relevantStorageState,
      ) as Record<string, unknown>,
      relevantIndexedDBState: this.sanitize(
        evidence.relevantIndexedDBState,
      ) as Record<string, unknown>,
      relevantNetworkResults: this.sanitize(
        evidence.relevantNetworkResults,
      ) as Record<string, unknown>,
    };

    this.records.push(sanitizedRecord);

    // Write individual record file
    const filePath = path.join(
      this.outputDir,
      `${evidence.testId}-${evidence.browser}.json`,
    );
    fs.writeFileSync(
      filePath,
      JSON.stringify(sanitizedRecord, null, 2),
      "utf-8",
    );
  }

  public getAllRecords(): readonly EvidenceRecord[] {
    return this.records;
  }

  public saveSummary(): string {
    const summaryPath = path.join(this.outputDir, "evidence-summary.json");
    fs.writeFileSync(
      summaryPath,
      JSON.stringify(
        {
          totalRecords: this.records.length,
          generatedAt: new Date().toISOString(),
          records: this.records,
        },
        null,
        2,
      ),
      "utf-8",
    );
    return summaryPath;
  }
}
