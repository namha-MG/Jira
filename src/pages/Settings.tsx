import { useState, useEffect } from "react";
import { testConnection, JiraUser } from "../jiraService";
import { JIRA_BASE_URL, msalConfig } from "../config";

interface Toast { id: number; type: "success" | "error" | "info"; msg: string; }

export default function Settings() {
  const [pat, setPat] = useState(() => localStorage.getItem("jira_pat") || "");
  const [geminiKey, setGeminiKey] = useState(() => localStorage.getItem("gemini_api_key") || "");
  const [jiraUrl, setJiraUrl] = useState(() => localStorage.getItem("jira_url") || JIRA_BASE_URL);
  const [testing, setTesting] = useState(false);
  const [connStatus, setConnStatus] = useState<null | { ok: boolean; user?: JiraUser; msg?: string }>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [saving, setSaving] = useState(false);
  const [showPat, setShowPat] = useState(false);
  const [showGeminiKey, setShowGeminiKey] = useState(false);

  // Trích xuất Tenant ID từ authority URL (e.g. login.microsoftonline.com/TENANT_ID)
  const tenantId = msalConfig.auth.authority.split("/").pop() || "";
  const clientId = msalConfig.auth.clientId;
  const isNotConfigured = clientId === "YOUR_CLIENT_ID" || tenantId.includes("YOUR_TENANT_ID");

  const addToast = (type: Toast["type"], msg: string) => {
    const id = Date.now();
    setToasts((t) => [...t, { id, type, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  };

  // Check existing connection on mount
  useEffect(() => {
    const savedPat = localStorage.getItem("jira_pat");
    if (savedPat) {
      testConn();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const testConn = async () => {
    setTesting(true);
    setConnStatus(null);
    try {
      const result = await testConnection();
      setConnStatus({ ok: result.success, user: result.user, msg: result.error });
    } catch {
      setConnStatus({ ok: false, msg: "Không thể kết nối đến server" });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    if (pat.trim()) {
      localStorage.setItem("jira_pat", pat.trim());
    } else {
      localStorage.removeItem("jira_pat");
    }
    if (geminiKey.trim()) {
      localStorage.setItem("gemini_api_key", geminiKey.trim());
    } else {
      localStorage.removeItem("gemini_api_key");
    }
    localStorage.setItem("jira_url", jiraUrl.trim() || JIRA_BASE_URL);

    // Test connection
    await testConn();
    addToast("success", "✅ Đã lưu cài đặt");
    setSaving(false);
  };

  const handleClear = () => {
    localStorage.removeItem("jira_pat");
    localStorage.removeItem("jira_basic");
    localStorage.removeItem("jira_url");
    localStorage.removeItem("gemini_api_key");
    setPat("");
    setJiraUrl(JIRA_BASE_URL);
    setGeminiKey("");
    setConnStatus(null);
    addToast("info", "🗑️ Đã xóa thông tin kết nối");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">Cài đặt</h1>
          <p className="page-subtitle">Kết nối Jira và cấu hình hệ thống</p>
        </div>
      </div>

      <div className="page-body">
        <div style={{ maxWidth: 640 }}>
          {/* Jira Connection */}
          <div className="settings-section">
            <div className="settings-section-title">🔗 Kết nối Jira Server</div>
            <div className="settings-section-desc">
              Nhập thông tin xác thực để kết nối với Jira tại <code style={{ color: "var(--accent-blue)" }}>{jiraUrl}</code>
            </div>

            <div className="form-group">
              <label htmlFor="input-jira-url">Jira Server URL</label>
              <input
                id="input-jira-url"
                type="url"
                value={jiraUrl}
                onChange={(e) => setJiraUrl(e.target.value)}
                placeholder="https://jira.example.com"
              />
            </div>

            <div className="form-group">
              <label htmlFor="input-jira-pat">
                Personal Access Token (PAT)
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ marginLeft: 8, padding: "2px 6px", fontSize: 11 }}
                  onClick={() => setShowPat((v) => !v)}
                >
                  {showPat ? "🙈 Ẩn" : "👁️ Hiện"}
                </button>
              </label>
              <input
                id="input-jira-pat"
                type={showPat ? "text" : "password"}
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                placeholder="Nhập Jira Personal Access Token của bạn..."
                autoComplete="off"
              />
            </div>

            {/* How to get PAT */}
            <details style={{ marginBottom: 16 }}>
              <summary style={{ fontSize: 13, color: "var(--accent-blue-light)", cursor: "pointer", fontWeight: 600, listStyle: "none" }}>
                📖 Cách lấy Personal Access Token từ Jira?
              </summary>
              <div style={{ marginTop: 12, padding: "14px 16px", background: "rgba(79, 142, 247, 0.05)", border: "1px solid rgba(79, 142, 247, 0.15)", borderRadius: 10, fontSize: 13, lineHeight: 1.8 }}>
                <ol style={{ paddingLeft: 18, color: "var(--text-secondary)" }}>
                  <li>Đăng nhập vào Jira tại <a href={jiraUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent-blue-light)" }}>{jiraUrl}</a></li>
                  <li>Click vào avatar (góc trên phải) → <strong style={{ color: "var(--text-primary)" }}>Profile</strong></li>
                  <li>Chọn <strong style={{ color: "var(--text-primary)" }}>Security</strong> → <strong style={{ color: "var(--text-primary)" }}>Personal Access Tokens</strong></li>
                  <li>Click <strong style={{ color: "var(--text-primary)" }}>Create token</strong></li>
                  <li>Đặt tên: <code style={{ color: "var(--accent-blue)" }}>Jira Monitor Tool</code></li>
                  <li>Click <strong style={{ color: "var(--text-primary)" }}>Create</strong> và <strong style={{ color: "var(--accent-red)" }}>copy token ngay</strong> (chỉ hiển thị 1 lần!)</li>
                  <li>Dán token vào ô trên và nhấn <strong style={{ color: "var(--text-primary)" }}>Lưu & Kết nối</strong></li>
                </ol>
              </div>
            </details>

            {/* Connection status */}
            {connStatus && (
              <div className={`connection-status ${connStatus.ok ? "connected" : "error"}`}>
                {connStatus.ok ? (
                  <>
                    <span>✅</span>
                    <div>
                      <div style={{ fontWeight: 600 }}>Kết nối thành công!</div>
                      {connStatus.user && (
                        <div style={{ fontSize: 12, opacity: 0.8 }}>
                          Xin chào, {connStatus.user.displayName} ({connStatus.user.emailAddress})
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <span>❌</span>
                    <div>
                      <div style={{ fontWeight: 600 }}>Kết nối thất bại</div>
                      <div style={{ fontSize: 12, opacity: 0.8 }}>{connStatus.msg}</div>
                    </div>
                  </>
                )}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button
                id="btn-save-jira-config"
                className="btn btn-primary"
                onClick={handleSave}
                disabled={saving || testing}
              >
                {saving ? <><span className="spinning">⏳</span> Đang lưu...</> : "💾 Lưu & Kết nối"}
              </button>
              <button
                id="btn-test-connection"
                className="btn btn-secondary"
                onClick={testConn}
                disabled={testing || !pat}
              >
                {testing ? <><span className="spinning">🔄</span> Đang kiểm tra...</> : "🔌 Test kết nối"}
              </button>
              <button
                id="btn-clear-config"
                className="btn btn-danger"
                onClick={handleClear}
              >
                🗑️ Xóa
              </button>
            </div>
          </div>

          {/* AI Assistant Config */}
          <div className="settings-section">
            <div className="settings-section-title">🤖 Cấu hình AI Assistant</div>
            <div className="settings-section-desc">
              Cấu hình Google Gemini API Key để tự động viết ghi chú công việc (Worklog Comment) chất lượng cao bằng AI.
            </div>

            <div className="form-group">
              <label htmlFor="input-gemini-key">
                Google Gemini API Key
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ marginLeft: 8, padding: "2px 6px", fontSize: 11 }}
                  onClick={() => setShowGeminiKey((v) => !v)}
                >
                  {showGeminiKey ? "🙈 Ẩn" : "👁️ Hiện"}
                </button>
              </label>
              <input
                id="input-gemini-key"
                type={showGeminiKey ? "text" : "password"}
                value={geminiKey}
                onChange={(e) => setGeminiKey(e.target.value)}
                placeholder="Nhập Google Gemini API Key của bạn (AI Studio)..."
                autoComplete="off"
              />
            </div>

            <details style={{ marginBottom: 16 }}>
              <summary style={{ fontSize: 13, color: "var(--accent-blue-light)", cursor: "pointer", fontWeight: 600, listStyle: "none" }}>
                📖 Cách lấy Gemini API Key miễn phí?
              </summary>
              <div style={{ marginTop: 12, padding: "14px 16px", background: "rgba(79, 142, 247, 0.05)", border: "1px solid rgba(79, 142, 247, 0.15)", borderRadius: 10, fontSize: 13, lineHeight: 1.8 }}>
                <ol style={{ paddingLeft: 18, color: "var(--text-secondary)" }}>
                  <li>Truy cập cổng Google AI Studio: <a href="https://aistudio.google.com/" target="_blank" rel="noreferrer" style={{ color: "var(--accent-blue-light)" }}>aistudio.google.com</a></li>
                  <li>Đăng nhập bằng tài khoản Google của bạn.</li>
                  <li>Click vào nút <strong style={{ color: "var(--text-primary)" }}>Get API key</strong> ở góc trên bên trái.</li>
                  <li>Click <strong style={{ color: "var(--text-primary)" }}>Create API key</strong>, chọn một Google Cloud Project bất kỳ (hoặc tạo mới) rồi nhấn tạo.</li>
                  <li>Copy mã API Key nhận được, dán vào ô bên trên và bấm nút <strong style={{ color: "var(--text-primary)" }}>Lưu cài đặt</strong> ở trên!</li>
                </ol>
              </div>
            </details>
          </div>

          {/* Azure Info */}
          <div className="settings-section">
            <div className="settings-section-title">🔐 Azure EntraID</div>
            <div className="settings-section-desc">Thông tin xác thực Azure AD được cấu hình trong source code</div>
            <div style={{ padding: "12px 16px", background: "var(--bg-card)", borderRadius: 8, border: "1px solid var(--border)", fontSize: 13 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {[
                  { label: "Client ID", val: clientId, err: clientId === "YOUR_CLIENT_ID" },
                  { label: "Tenant ID", val: tenantId, err: tenantId.includes("YOUR_TENANT_ID") },
                  { label: "Redirect URI", val: window.location.origin, err: false },
                ].map((item) => (
                  <div key={item.label} style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    <span style={{ color: "var(--text-muted)", width: 100, flexShrink: 0, fontSize: 12 }}>{item.label}</span>
                    <code style={{ color: item.err ? "var(--accent-red)" : "var(--accent-green)", fontSize: 12 }}>
                      {item.val}
                    </code>
                    {item.err && (
                      <span style={{ fontSize: 11, color: "var(--accent-orange)" }}>⚠️ Chưa cấu hình</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div style={{ marginTop: 12, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.7 }}>
              Để cấu hình Azure EntraID, chỉnh sửa file <code style={{ color: "var(--accent-blue)" }}>src/config.ts</code> và điền <code>clientId</code> và <code>tenantId</code> từ Azure Portal.
            </div>
          </div>

          {/* App Info */}
          <div className="settings-section">
            <div className="settings-section-title">ℹ️ Thông tin ứng dụng</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {[
                { label: "Version", value: "1.0.0" },
                { label: "Jira API", value: "REST API v2" },
                { label: "Auth", value: "Azure EntraID + PAT" },
                { label: "Framework", value: "React + Vite + TypeScript" },
              ].map((info) => (
                <div key={info.label} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "10px 14px", background: "var(--bg-card)", borderRadius: 8, border: "1px solid var(--border)" }}>
                  <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>{info.label}</span>
                  <span style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 600 }}>{info.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Toasts */}
      <div className="toast-container">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>{t.msg}</div>
        ))}
      </div>
    </div>
  );
}
