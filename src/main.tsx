console.log("=== MAIN.TSX EXECUTING ===");
import React from "react";
import ReactDOM from "react-dom/client";
import { PublicClientApplication, EventType } from "@azure/msal-browser";
import type { AuthenticationResult } from "@azure/msal-browser";
import { MsalProvider } from "@azure/msal-react";
import { msalConfig } from "./config";
import App from "./App";
import "./index.css";

// ── Trang thông báo chưa cấu hình ──────────────────────────────────────────
function ConfigNeeded() {
  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#0a0e1a", fontFamily: "system-ui, -apple-system, sans-serif", padding: 20,
    }}>
      <div style={{
        background: "#0f1527", border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 24, padding: 48, maxWidth: 520, width: "100%", textAlign: "center",
      }}>
        <div style={{ fontSize: 56, marginBottom: 20 }}>⚙️</div>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: "#f1f5f9", marginBottom: 8 }}>
          Cần cấu hình Azure EntraID
        </h1>
        <p style={{ color: "#94a3b8", fontSize: 14, lineHeight: 1.7, marginBottom: 28 }}>
          Điền <strong style={{ color: "#4f8ef7" }}>Client ID</strong> và{" "}
          <strong style={{ color: "#4f8ef7" }}>Tenant ID</strong> vào{" "}
          <code style={{ color: "#10b981" }}>src/config.ts</code>
        </p>
        <div style={{ textAlign: "left", fontSize: 13, color: "#94a3b8", lineHeight: 2.2 }}>
          <div>➡️ Mở <a href="https://portal.azure.com" target="_blank" rel="noreferrer" style={{ color: "#4f8ef7" }}>Azure Portal</a> → App Registrations</div>
          <div>➡️ Tạo app mới: chọn SPA, redirect URI: <code style={{ color: "#10b981" }}>http://localhost:5173</code></div>
          <div>➡️ Copy Client ID + Tenant ID → dán vào <code style={{ color: "#10b981" }}>src/config.ts</code></div>
          <div>➡️ Refresh trang này</div>
        </div>
      </div>
    </div>
  );
}

// ── Main ────────────────────────────────────────────────────────────────────
const isNotConfigured =
  msalConfig.auth.clientId === "YOUR_CLIENT_ID" ||
  msalConfig.auth.authority.includes("YOUR_TENANT_ID");

if (isNotConfigured) {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode><ConfigNeeded /></React.StrictMode>
  );
} else {
  console.log("Initializing PublicClientApplication with config:", msalConfig);
  const msalInstance = new PublicClientApplication(msalConfig);

  console.log("Calling msalInstance.initialize()...");
  msalInstance
    .initialize()
    .then(() => {
      console.log("msalInstance.initialize() resolved! Now calling handleRedirectPromise()...");
      return msalInstance.handleRedirectPromise();
    })
    .then((redirectResult) => {
      console.log("msalInstance.handleRedirectPromise() resolved with:", redirectResult);
      const accounts = msalInstance.getAllAccounts();
      console.log("All accounts currently found:", accounts);
      if (accounts.length > 0) {
        msalInstance.setActiveAccount(accounts[0]);
        console.log("Set active account to:", accounts[0]);
      }

      msalInstance.addEventCallback((event) => {
        console.log("MSAL Event received:", event.eventType, event);
        if (event.eventType === EventType.LOGIN_SUCCESS && event.payload) {
          const { account } = event.payload as AuthenticationResult;
          msalInstance.setActiveAccount(account);
          console.log("Login success, set active account to:", account);
        }
      });

      console.log("Rendering React root...");
      ReactDOM.createRoot(document.getElementById("root")!).render(
        <React.StrictMode>
          <MsalProvider instance={msalInstance}>
            <App />
          </MsalProvider>
        </React.StrictMode>
      );
      console.log("React root rendering triggered.");
    })
    .catch((err: unknown) => {
      console.error("MSAL startup failed with error:", err);
      ReactDOM.createRoot(document.getElementById("root")!).render(
        <React.StrictMode>
          <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0a0e1a", color: "#f1f5f9", fontFamily: "system-ui, sans-serif", textAlign: "center", padding: 40 }}>
            <div>
              <div style={{ fontSize: 48, marginBottom: 16 }}>❌</div>
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8, color: "#ef4444" }}>MSAL Init Error</div>
              <div style={{ fontSize: 13, color: "#94a3b8" }}>{String(err)}</div>
            </div>
          </div>
        </React.StrictMode>
      );
    });
}
