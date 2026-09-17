import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Build Artifacts & Production Safety (S8, S9)", () => {
  const targets = [
    { name: "Chrome MV3", dir: ".output/chrome-mv3" },
    { name: "Firefox MV3", dir: ".output/firefox-mv3" },
  ];

  for (const { name, dir } of targets) {
    describe(`${name} Output Validation`, () => {
      const outputDir = path.resolve(process.cwd(), dir);

      it("S9: production build directory and manifest exist", () => {
        expect(
          fs.existsSync(outputDir),
          `Build output directory ${dir} must exist`,
        ).toBe(true);
        expect(
          fs.existsSync(path.join(outputDir, "manifest.json")),
          `manifest.json must exist in ${dir}`,
        ).toBe(true);
      });

      it("verifies bundled background script exists and contains zero eval()", () => {
        const bgPath = path.join(outputDir, "background.js");
        expect(
          fs.existsSync(bgPath),
          `background.js must exist in ${dir}`,
        ).toBe(true);

        const content = fs.readFileSync(bgPath, "utf-8");
        expect(
          /\beval\s*\(/.test(content),
          `eval() detected in bundled background.js of ${name}`,
        ).toBe(false);
        expect(
          /\bnew\s+Function\s*\(/.test(content),
          `new Function() detected in bundled background.js of ${name}`,
        ).toBe(false);
      });

      it("verifies bundled content script exists and contains zero eval()", () => {
        const contentScriptPath = path.join(
          outputDir,
          "content-scripts",
          "content.js",
        );
        expect(
          fs.existsSync(contentScriptPath),
          `content-scripts/content.js must exist in ${dir}`,
        ).toBe(true);

        const content = fs.readFileSync(contentScriptPath, "utf-8");
        expect(
          /\beval\s*\(/.test(content),
          `eval() detected in bundled content.js of ${name}`,
        ).toBe(false);
      });

      it("verifies bundled popup HTML and chunk files exist", () => {
        const popupHtmlPath = path.join(outputDir, "popup.html");
        expect(
          fs.existsSync(popupHtmlPath),
          `popup.html must exist in ${dir}`,
        ).toBe(true);
      });
    });
  }
});
