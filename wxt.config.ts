import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: "src",
  manifestVersion: 3,
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "CodeSync",
    description:
      "Cross-browser extension for synchronizing competitive programming solutions to GitHub",
    version: "0.1.0",
    // GAP-05: Earliest Chromium version supporting Manifest V3 Service Worker (Chrome 88+)
    // and native crypto.randomUUID() required across core pipeline without fallback (Chrome 92+).
    minimum_chrome_version: "92",
    // Phase 1A & Phase 1C.4.2.1: Strictly minimum-privilege permissions.
    // Zero broad permissions (<all_urls>, webRequest, tabs, cookies are strictly prohibited).
    permissions: ["storage", "alarms"],
    // Phase 1C: Specific GitHub host permissions for OAuth/Device Flow and API requests
    host_permissions: ["https://github.com/*", "https://api.github.com/*"],
    content_security_policy: {
      // Hardened Extension Pages CSP:
      // - script-src 'self': Strictly forbids inline scripts (<script>, onclick) and dynamic eval.
      // - object-src 'none': Completely disables plugin execution (Flash, Java).
      // - base-uri 'none': Prevents <base> tag injection.
      // - frame-ancestors 'none': Prevents framing/clickjacking.
      // - style-src 'self' 'unsafe-inline': Required for React DOM style properties and Vite styling.
      //   Applies exclusively to CSS formatting; does NOT grant script execution privileges.
      extension_pages:
        "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'self' 'unsafe-inline';",
    },
    browser_specific_settings: {
      gecko: {
        id: "codesync@extension.local",
        strict_min_version: "128.0",
      },
    },
  },
});
