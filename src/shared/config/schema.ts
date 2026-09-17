/**
 * Supported policies when a duplicate or conflicting submission file exists.
 */
export type DuplicatePolicy =
  "skip" | "overwrite" | "keep_both" | "prompt_user";

export const VALID_DUPLICATE_POLICIES: ReadonlyArray<DuplicatePolicy> = [
  "skip",
  "overwrite",
  "keep_both",
  "prompt_user",
];

/**
 * Validated extension configuration schema.
 * Note: Authentication tokens and sensitive credentials are stored separately
 * and NEVER mixed into generic application configuration.
 */
export interface ExtensionConfig {
  readonly version: number;
  readonly targetRepository?: string | undefined;
  readonly targetBranch: string;
  readonly baseFolder: string;
  readonly duplicatePolicy: DuplicatePolicy;
  readonly enabledPlatforms: Readonly<Record<string, boolean>>;
}
