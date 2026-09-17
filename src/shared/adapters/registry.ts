/**
 * Platform Adapter Registry (Phase 1C.3)
 *
 * Central extension-controlled registry for platform adapters.
 * Guarantees:
 * - Extension-controlled code only (zero dynamic evaluation of page code)
 * - Unique adapter registration
 * - Fail-closed validation on malformed adapter implementations
 * - Safe origin resolution
 */

import {
  type PlatformAdapter,
  type PlatformId,
  SUPPORTED_PLATFORMS,
} from "./types";
import { ErrorCode, PlatformAdapterError } from "../errors";

export class PlatformAdapterRegistry {
  private readonly adapters = new Map<PlatformId, PlatformAdapter>();

  /**
   * Registers a platform adapter.
   * Throws PlatformAdapterError fail-closed if adapter is malformed or duplicate.
   */
  register(adapter: PlatformAdapter): void {
    if (!adapter || typeof adapter !== "object") {
      throw new PlatformAdapterError(
        "Adapter registration failed: adapter must be a non-null object.",
        ErrorCode.ADAPTER_REGISTRATION_INVALID,
      );
    }

    if (!adapter.id || !SUPPORTED_PLATFORMS.includes(adapter.id)) {
      throw new PlatformAdapterError(
        `Adapter registration failed: invalid platform id "${String(adapter.id)}".`,
        ErrorCode.ADAPTER_REGISTRATION_INVALID,
      );
    }

    if (!adapter.name || typeof adapter.name !== "string") {
      throw new PlatformAdapterError(
        "Adapter registration failed: adapter must have a valid string name.",
        ErrorCode.ADAPTER_REGISTRATION_INVALID,
        adapter.id,
      );
    }

    if (
      !Array.isArray(adapter.supportedOrigins) ||
      adapter.supportedOrigins.length === 0 ||
      adapter.supportedOrigins.some(
        (origin) => typeof origin !== "string" || !origin.trim(),
      )
    ) {
      throw new PlatformAdapterError(
        "Adapter registration failed: supportedOrigins must be a non-empty array of strings.",
        ErrorCode.ADAPTER_REGISTRATION_INVALID,
        adapter.id,
      );
    }

    if (
      typeof adapter.canHandle !== "function" ||
      typeof adapter.detectSubmission !== "function" ||
      typeof adapter.extractSubmission !== "function"
    ) {
      throw new PlatformAdapterError(
        "Adapter registration failed: adapter must implement canHandle, detectSubmission, and extractSubmission methods.",
        ErrorCode.ADAPTER_REGISTRATION_INVALID,
        adapter.id,
      );
    }

    if (this.adapters.has(adapter.id)) {
      throw new PlatformAdapterError(
        `Adapter with id "${adapter.id}" is already registered. Duplicate registrations are rejected.`,
        ErrorCode.ADAPTER_ALREADY_REGISTERED,
        adapter.id,
      );
    }

    this.adapters.set(adapter.id, adapter);
  }

  /**
   * Resolves the appropriate adapter for a given page URL.
   * Returns null if no adapter matches the URL.
   */
  resolve(url: URL | string): PlatformAdapter | null {
    for (const adapter of this.adapters.values()) {
      if (adapter.canHandle(url)) {
        return adapter;
      }
    }
    return null;
  }

  /**
   * Retrieves an adapter by platform id.
   */
  get(id: PlatformId): PlatformAdapter | null {
    return this.adapters.get(id) ?? null;
  }

  /**
   * Returns all registered adapters.
   */
  getAll(): readonly PlatformAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Clears all registered adapters (primarily for test isolation).
   */
  clear(): void {
    this.adapters.clear();
  }
}

/**
 * Global default adapter registry instance.
 */
export const defaultAdapterRegistry = new PlatformAdapterRegistry();
