import { redactSensitiveData, redactString } from "./redactor";

export { redactSensitiveData, redactString };

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly context: string;
  readonly message: string;
  readonly data?: unknown;
}

/**
 * Safe Structured Logger for CodeSync.
 *
 * Invariants:
 * - All log arguments are sanitized via `redactSensitiveData` before output.
 * - Zero external transmission: logs exist only in standard console / local memory.
 * - No telemetry or remote analytics are permitted.
 */
export class Logger {
  private readonly context: string;

  constructor(context: string) {
    this.context = context;
  }

  private formatPrefix(level: LogLevel): string {
    const timestamp = new Date().toISOString();
    return `[CodeSync][${timestamp}][${level.toUpperCase()}][${this.context}]`;
  }

  debug(message: string, ...args: unknown[]): void {
    if (
      process.env.NODE_ENV === "test" ||
      process.env.NODE_ENV === "development"
    ) {
      const sanitizedArgs = args.map((a) => redactSensitiveData(a));
      console.debug(
        this.formatPrefix("debug"),
        redactString(message),
        ...sanitizedArgs,
      );
    }
  }

  info(message: string, ...args: unknown[]): void {
    const sanitizedArgs = args.map((a) => redactSensitiveData(a));
    console.info(
      this.formatPrefix("info"),
      redactString(message),
      ...sanitizedArgs,
    );
  }

  warn(message: string, ...args: unknown[]): void {
    const sanitizedArgs = args.map((a) => redactSensitiveData(a));
    console.warn(
      this.formatPrefix("warn"),
      redactString(message),
      ...sanitizedArgs,
    );
  }

  error(message: string, error?: unknown, ...args: unknown[]): void {
    const sanitizedError =
      error !== undefined ? redactSensitiveData(error) : undefined;
    const sanitizedArgs = args.map((a) => redactSensitiveData(a));
    if (sanitizedError !== undefined) {
      console.error(
        this.formatPrefix("error"),
        redactString(message),
        sanitizedError,
        ...sanitizedArgs,
      );
    } else {
      console.error(
        this.formatPrefix("error"),
        redactString(message),
        ...sanitizedArgs,
      );
    }
  }
}

/**
 * Creates a context-bound logger instance.
 */
export function createLogger(context: string): Logger {
  return new Logger(context);
}
