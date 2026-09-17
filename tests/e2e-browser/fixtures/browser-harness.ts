import {
  chromium,
  firefox,
  type BrowserContext,
  type Worker,
} from "@playwright/test";
import path from "path";
import fs from "fs";
import os from "os";
import { spawn, type ChildProcess } from "child_process";
import { WebDriverBiDiClient } from "./bidi-client";

export interface ChromiumHarness {
  readonly context: BrowserContext;
  readonly serviceWorker: Worker;
  readonly extensionId: string;
  readonly profileDir: string;
  restart: () => Promise<ChromiumHarness>;
  close: () => Promise<void>;
}

export interface FirefoxHarness {
  readonly bidi: WebDriverBiDiClient;
  readonly process: ChildProcess;
  readonly extensionId: string;
  readonly profileDir: string;
  readonly port: number;
  restart: (newPort?: number) => Promise<FirefoxHarness>;
  close: () => Promise<void>;
}

export class BrowserHarness {
  private static createdDirs: string[] = [];

  public static createTempProfile(
    prefix: string = "codesync-profile-",
  ): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    this.createdDirs.push(dir);
    return dir;
  }

  public static safeCleanDir(dirPath: string): void {
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 500,
        });
      }
    } catch {
      // Best-effort cleanup on Windows where background handles may take a moment to release
    }
  }

  public static cleanAllTempProfiles(): void {
    for (const dir of this.createdDirs) {
      this.safeCleanDir(dir);
    }
    this.createdDirs = [];
  }

  /**
   * Launches Chromium persistent context with the unpacked CodeSync MV3 extension.
   */
  public static async launchChromium(
    existingProfileDir?: string,
  ): Promise<ChromiumHarness> {
    const extPath = path.resolve(".output/chrome-mv3");
    if (!fs.existsSync(extPath)) {
      throw new Error(
        `Chromium build output not found at ${extPath}. Run 'npm run build' first.`,
      );
    }

    const profileDir =
      existingProfileDir || this.createTempProfile("codesync-cr-");

    const context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
      ],
    });

    // Wait for the background service worker to initialize
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      try {
        sw = await context.waitForEvent("serviceworker", { timeout: 3000 });
      } catch {
        sw = context.serviceWorkers()[0];
      }
    }
    if (!sw) {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (context.serviceWorkers().length > 0) {
          sw = context.serviceWorkers()[0];
          break;
        }
      }
    }
    if (!sw) {
      throw new Error(
        "Background service worker failed to register in Chromium.",
      );
    }

    const swUrl = sw.url();
    // URL format: chrome-extension://<extension-id>/background.js
    const match = swUrl.match(/chrome-extension:\/\/([a-z0-9_-]+)/i);
    const extensionId = match && match[1] ? match[1] : "";

    const harness: ChromiumHarness = {
      context,
      serviceWorker: sw,
      extensionId,
      profileDir,
      restart: async () => {
        await context.close();
        // Pause briefly for Windows process release
        await new Promise((r) => setTimeout(r, 800));
        return BrowserHarness.launchChromium(profileDir);
      },
      close: async () => {
        await context.close();
        if (!existingProfileDir) {
          BrowserHarness.safeCleanDir(profileDir);
        }
      },
    };

    return harness;
  }

  /**
   * Launches Firefox with WebDriver BiDi and installs unpacked Firefox MV3 extension.
   */
  public static async launchFirefox(
    port: number = 9224,
    existingProfileDir?: string,
  ): Promise<FirefoxHarness> {
    const extPath = path.resolve(".output/firefox-mv3");
    if (!fs.existsSync(extPath)) {
      throw new Error(
        `Firefox build output not found at ${extPath}. Run 'npm run build:firefox' first.`,
      );
    }

    const profileDir =
      existingProfileDir || this.createTempProfile("codesync-ff-");
    const ffExecutable = firefox.executablePath();

    const ffProc = spawn(
      ffExecutable,
      [
        `--remote-debugging-port=${port}`,
        "--headless",
        "--profile",
        profileDir,
        "about:blank",
      ],
      { stdio: "pipe" },
    );

    // Wait for BiDi port readiness
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const bidi = new WebDriverBiDiClient(`ws://127.0.0.1:${port}/session`);
    await bidi.connect();
    await bidi.newSession();

    // Install extension via BiDi webExtension.install
    const installResult = await bidi.installExtension(extPath);
    const extensionId = installResult.extension;

    // Small delay for background scripts to execute
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const harness: FirefoxHarness = {
      bidi,
      process: ffProc,
      extensionId,
      profileDir,
      port,
      restart: async (newPort = port + 2) => {
        await bidi.close();
        ffProc.kill();
        await new Promise((r) => setTimeout(r, 1000));
        return BrowserHarness.launchFirefox(newPort, profileDir);
      },
      close: async () => {
        await bidi.close();
        ffProc.kill();
        await new Promise((r) => setTimeout(r, 800));
        if (!existingProfileDir) {
          BrowserHarness.safeCleanDir(profileDir);
        }
      },
    };

    return harness;
  }
}
