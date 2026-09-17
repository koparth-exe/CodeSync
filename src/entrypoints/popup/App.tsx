import React from "react";

/**
 * Minimal, secure popup UI foundation for CodeSync Phase 1A.
 *
 * Invariants:
 * - Uses React 19 with standard JSX text interpolation (auto-escaped, no XSS).
 * - Zero dangerouslySetInnerHTML or dynamic eval.
 * - Zero external network calls.
 */
export default function App(): React.ReactElement {
  return (
    <div
      style={{
        width: "320px",
        padding: "16px",
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        backgroundColor: "#0f172a",
        color: "#f8fafc",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid #334155",
          paddingBottom: "12px",
          marginBottom: "16px",
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: "18px",
            fontWeight: 600,
            color: "#38bdf8",
          }}
        >
          CodeSync
        </h1>
        <span
          style={{
            fontSize: "11px",
            backgroundColor: "#1e293b",
            color: "#94a3b8",
            padding: "2px 8px",
            borderRadius: "12px",
            border: "1px solid #475569",
          }}
        >
          v0.1.0
        </span>
      </div>

      <div style={{ marginBottom: "16px" }}>
        <div
          style={{
            backgroundColor: "#1e293b",
            borderRadius: "8px",
            padding: "12px",
            border: "1px solid #334155",
          }}
        >
          <div
            style={{
              fontSize: "13px",
              fontWeight: 600,
              color: "#f1f5f9",
              marginBottom: "4px",
            }}
          >
            Phase 1A: Secure Foundation
          </div>
          <div
            style={{ fontSize: "12px", color: "#94a3b8", lineHeight: "1.4" }}
          >
            Core extension infrastructure is active. Security baseline,
            minimum-privilege manifest, and fail-closed error handling are
            operational.
          </div>
        </div>
      </div>

      <div
        style={{
          fontSize: "11px",
          color: "#64748b",
          textAlign: "center",
          borderTop: "1px solid #1e293b",
          paddingTop: "8px",
        }}
      >
        Local-First • Manifest V3 • Zero Telemetry
      </div>
    </div>
  );
}
