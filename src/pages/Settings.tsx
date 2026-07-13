import { useState, useEffect } from "react";
import { testConnection, JiraUser } from "../jiraService";
import {
  getDefaultProjectKey,
  getSelectedProjectKeys,
  JIRA_BASE_URL,
  JIRA_PROJECTS,
  msalConfig,
  saveSelectedProjectKeys,
} from "../config";
import { getHolidays, saveHolidays, DEFAULT_HOLIDAYS } from "../utils";
import {
  GIT_PAT_STORAGE_KEY,
  GIT_PROJECT_LINKS_STORAGE_KEY,
  GitProjectLinks,
  getGitProjectLinks,
  saveGitProjectLinks,
} from "../gitReconciliationService";

interface Toast { id: number; type: "success" | "error" | "info"; msg: string; }

export default function Settings() {
  const [pat, setPat] = useState(() => localStorage.getItem("jira_pat") || "");
  const [geminiKey, setGeminiKey] = useState(() => localStorage.getItem("gemini_api_key") || "");
  const [gitPat, setGitPat] = useState(() => localStorage.getItem(GIT_PAT_STORAGE_KEY) || "");
  const [projectGitLinks, setProjectGitLinks] = useState<GitProjectLinks>(() => getGitProjectLinks());
  const [authorizedCloseTeam, setAuthorizedCloseTeam] = useState(() => localStorage.getItem("authorized_close_team") || "");
  const [jiraUrl, setJiraUrl] = useState(() => localStorage.getItem("jira_url") || JIRA_BASE_URL);
  const [selectedProjectKeys, setSelectedProjectKeys] = useState<string[]>(() => getSelectedProjectKeys());
  const [projectSearch, setProjectSearch] = useState("");
  const [defaultProject, setDefaultProject] = useState(() => getDefaultProjectKey());
  const [autoLogEnabled, setAutoLogEnabled] = useState(() => localStorage.getItem("auto_log_enabled") !== "false");
  const [holidays, setHolidays] = useState<string[]>([]);
  const [newHoliday, setNewHoliday] = useState("");
  const [testing, setTesting] = useState(false);
  const [connStatus, setConnStatus] = useState<null | { ok: boolean; user?: JiraUser; msg?: string }>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [saving, setSaving] = useState(false);
  const [showPat, setShowPat] = useState(false);
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [showGitPat, setShowGitPat] = useState(false);

  // Trích xuất Tenant ID từ authority URL (e.g. login.microsoftonline.com/TENANT_ID)
  const tenantId = msalConfig.auth.authority.split("/").pop() || "";
  const clientId = msalConfig.auth.clientId;
  const isNotConfigured = clientId === "YOUR_CLIENT_ID" || tenantId.includes("YOUR_TENANT_ID");
  const projectByKey = new Map(JIRA_PROJECTS.map((project) => [project.key, project]));
  const selectedProjects = selectedProjectKeys
    .map((key) => projectByKey.get(key))
    .filter((project): project is (typeof JIRA_PROJECTS)[number] => !!project);
  const filteredProjects = JIRA_PROJECTS.filter((project) => {
    const search = projectSearch.trim().toLowerCase();
    if (!search) return true;
    return project.key.toLowerCase().includes(search) || project.name.toLowerCase().includes(search);
  });

  const addToast = (type: Toast["type"], msg: string) => {
    const id = Date.now();
    setToasts((t) => [...t, { id, type, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  };

  // Check existing connection on mount
  useEffect(() => {
    const savedPat = localStorage.getItem("jira_pat");
    setHolidays(getHolidays());
    if (savedPat) {
      testConn();
    }
    
    // Fetch authorized config from backend
    fetch("/api/configs/authorized_close_team")
      .then(r => r.json())
      .then(data => {
        if (data && data.value !== null) {
          setAuthorizedCloseTeam(data.value);
          localStorage.setItem("authorized_close_team", data.value);
        }
      })
      .catch(e => console.warn("Lỗi tải cấu hình phân quyền từ DB", e));

    fetch("/api/configs/git_project_links")
      .then(r => r.json())
      .then(data => {
        if (data && data.value) {
          const parsed = JSON.parse(data.value);
          setProjectGitLinks(parsed);
          saveGitProjectLinks(parsed);
        }
      })
      .catch(e => console.warn("Lỗi tải cấu hình Git repo từ DB", e));

    fetch("/api/configs/git_pat")
      .then(r => r.json())
      .then(data => {
        if (data && data.value) {
          setGitPat(data.value);
          localStorage.setItem(GIT_PAT_STORAGE_KEY, data.value);
        }
      })
      .catch(e => console.warn("Lỗi tải Git PAT từ DB", e));

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedProjectKeys.length === 0) return;
    if (!selectedProjectKeys.includes(defaultProject)) {
      setDefaultProject(selectedProjectKeys[0]);
    }
  }, [defaultProject, selectedProjectKeys]);

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
    if (selectedProjectKeys.length === 0) {
      addToast("error", "Vui lòng chọn ít nhất 1 dự án tham gia");
      setSaving(false);
      return;
    }

    const nextDefaultProject = selectedProjectKeys.includes(defaultProject)
      ? defaultProject
      : selectedProjectKeys[0];

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
    if (gitPat.trim()) {
      localStorage.setItem(GIT_PAT_STORAGE_KEY, gitPat.trim());
    } else {
      localStorage.removeItem(GIT_PAT_STORAGE_KEY);
    }
    const normalizedProjectGitLinks = Object.fromEntries(
      Object.entries(projectGitLinks).map(([projectKey, links]) => [
        projectKey,
        links.map((link) => link.trim()).filter(Boolean),
      ])
    );
    saveGitProjectLinks(normalizedProjectGitLinks);
    setProjectGitLinks(normalizedProjectGitLinks);
    localStorage.setItem("jira_url", jiraUrl.trim() || JIRA_BASE_URL);
    saveSelectedProjectKeys(selectedProjectKeys);
    localStorage.setItem("default_project", nextDefaultProject);
    localStorage.setItem("auto_log_enabled", String(autoLogEnabled));
    localStorage.setItem("authorized_close_team", authorizedCloseTeam);
    saveHolidays(holidays);
    setDefaultProject(nextDefaultProject);

    // Test connection
    await testConn();
    
    // Save PAT to backend for cron jobs
    if (pat.trim()) {
      try {
        await fetch("/api/save-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pat: pat.trim(), autoLogEnabled })
        });
      } catch (e) {
        console.warn("Failed to sync PAT to backend", e);
      }
    }

    // Save authorized list to backend
    try {
      await fetch("/api/configs/authorized_close_team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: authorizedCloseTeam })
      });
    } catch (e) {
      console.warn("Failed to sync authorized team to backend", e);
    }

    try {
      await fetch("/api/configs/git_pat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: gitPat.trim() })
      });
      await fetch("/api/configs/git_project_links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: JSON.stringify(normalizedProjectGitLinks) })
      });
    } catch (e) {
      console.warn("Failed to sync Git config to backend", e);
    }

    addToast("success", "✅ Đã lưu cài đặt");
    setSaving(false);
  };

  const toggleProjectKey = (projectKey: string) => {
    setSelectedProjectKeys((current) => {
      if (current.includes(projectKey)) {
        return current.filter((key) => key !== projectKey);
      }
      return [...current, projectKey];
    });
  };

  const updateGitLink = (projectKey: string, index: number, value: string) => {
    setProjectGitLinks((current) => {
      const links = [...(current[projectKey] || [])];
      links[index] = value;
      return { ...current, [projectKey]: links };
    });
  };

  const addGitLink = (projectKey: string) => {
    setProjectGitLinks((current) => ({
      ...current,
      [projectKey]: [...(current[projectKey] || []), ""],
    }));
  };

  const removeGitLink = (projectKey: string, index: number) => {
    setProjectGitLinks((current) => {
      const links = (current[projectKey] || []).filter((_, i) => i !== index);
      return { ...current, [projectKey]: links };
    });
  };

  const handleClear = () => {
    localStorage.removeItem("jira_pat");
    localStorage.removeItem("jira_basic");
    localStorage.removeItem("jira_url");
    localStorage.removeItem("gemini_api_key");
    localStorage.removeItem(GIT_PAT_STORAGE_KEY);
    localStorage.removeItem(GIT_PROJECT_LINKS_STORAGE_KEY);
    setPat("");
    setJiraUrl(JIRA_BASE_URL);
    setGeminiKey("");
    setGitPat("");
    setProjectGitLinks({});
    setConnStatus(null);
    addToast("info", "🗑️ Đã xóa thông tin kết nối");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16 }}>
        <div className="page-title-group">
          <h1 className="page-title">Cài đặt</h1>
          <p className="page-subtitle">Kết nối Jira và cấu hình hệ thống</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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

      <div className="page-body">
        <div style={{ maxWidth: 1400, margin: "0 auto", display: "flex", flexWrap: "wrap", gap: 32, alignItems: "flex-start" }}>
          
          {/* --- CỘT TRÁI --- */}
          <div style={{ flex: "1 1 480px", display: "flex", flexDirection: "column", gap: 16 }}>
            
            {/* Jira Connection */}
            <div className="settings-section" style={{ marginBottom: 0 }}>
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
                <label htmlFor="select-default-project">Dự án mặc định</label>
                <select
                  id="select-default-project"
                  value={defaultProject}
                  onChange={(e) => setDefaultProject(e.target.value)}
                >
                  {selectedProjects.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.name} ({p.key})
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label>Dự án tham gia</label>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    type="text"
                    value={projectSearch}
                    onChange={(e) => setProjectSearch(e.target.value)}
                    placeholder="Tìm theo mã hoặc tên dự án..."
                    style={{ flex: "1 1 220px" }}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setSelectedProjectKeys(JIRA_PROJECTS.map((project) => project.key))}
                  >
                    Chọn tất cả
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setSelectedProjectKeys([])}
                  >
                    Bỏ chọn
                  </button>
                </div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  Đã chọn <strong style={{ color: "var(--text-primary)" }}>{selectedProjectKeys.length}</strong>/{JIRA_PROJECTS.length} dự án. Các màn Dashboard, Issues, Log Work, Tạo Issue Nhanh sẽ chỉ dùng các dự án này.
                </div>
                <div className="settings-project-grid">
                  {filteredProjects.map((project) => (
                    <label key={project.key} className="settings-project-option">
                      <input
                        type="checkbox"
                        checked={selectedProjectKeys.includes(project.key)}
                        onChange={() => toggleProjectKey(project.key)}
                      />
                      <span>
                        <strong>{project.key}</strong>
                        {project.name !== project.key && <small>{project.name}</small>}
                      </span>
                    </label>
                  ))}
                </div>
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
            </div>

            {/* AI Assistant Config */}
            <div className="settings-section" style={{ marginBottom: 0 }}>
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

            {/* Git Reconciliation Config */}
            <div className="settings-section" style={{ marginBottom: 0 }}>
              <div className="settings-section-title">🔍 Cấu hình đối soát Git</div>
              <div className="settings-section-desc">
                Khai báo Git Personal Access Token và các repo tương ứng với từng project Jira. Một project có thể gắn nhiều repo.
              </div>

              <div className="form-group">
                <label htmlFor="input-git-pat">
                  Git Personal Access Token
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ marginLeft: 8, padding: "2px 6px", fontSize: 11 }}
                    onClick={() => setShowGitPat((v) => !v)}
                  >
                    {showGitPat ? "🙈 Ẩn" : "👁️ Hiện"}
                  </button>
                </label>
                <input
                  id="input-git-pat"
                  type={showGitPat ? "text" : "password"}
                  value={gitPat}
                  onChange={(e) => setGitPat(e.target.value)}
                  placeholder="Nhập Git PAT dùng để đọc commit từ GitLab/GitHub/Bitbucket..."
                  autoComplete="off"
                />
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  Token cần quyền đọc repository/commit. Với repo public có thể để trống, nhưng repo private cần PAT.
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {selectedProjects.map((project) => {
                  const links = projectGitLinks[project.key] || [];
                  return (
                    <div
                      key={project.key}
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        padding: 12,
                        background: "rgba(255,255,255,0.02)",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 10 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700, color: "var(--text-primary)" }}>{project.key}</div>
                          <div style={{ fontSize: 12, color: "var(--text-muted)", overflowWrap: "anywhere" }}>{project.name}</div>
                        </div>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => addGitLink(project.key)}>
                          + Thêm repo
                        </button>
                      </div>

                      {links.length === 0 && (
                        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                          Chưa có repo Git cho project này.
                        </div>
                      )}

                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {links.map((link, index) => (
                          <div key={`${project.key}-${index}`} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <input
                              type="url"
                              value={link}
                              onChange={(e) => updateGitLink(project.key, index, e.target.value)}
                              placeholder="https://gitlab.example.com/group/repository.git"
                            />
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => removeGitLink(project.key, index)}
                              style={{ color: "var(--accent-red)", flexShrink: 0 }}
                            >
                              Xóa
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 12 }}>
                Chú ý: Nhớ bấm <strong style={{ color: "var(--text-primary)" }}>Lưu & Kết nối</strong> để đồng bộ cấu hình Git lên backend.
              </div>
            </div>

            {/* Authorization Config (Only for namha@etc.vn) */}
            {connStatus?.user && (connStatus.user.emailAddress?.includes("namha@etc.vn") || connStatus.user.name?.includes("namha@etc.vn")) && (
              <div className="settings-section" style={{ marginBottom: 0 }}>
                <div className="settings-section-title">🔒 Phân quyền Auto Close Task Team</div>
                <div className="settings-section-desc">
                  Khai báo danh sách email hoặc username được phép sử dụng tính năng "Auto Close Task Team" trên Dashboard. Cách nhau bởi dấu phẩy.
                </div>
                <div className="form-group">
                  <input
                    type="text"
                    value={authorizedCloseTeam}
                    onChange={(e) => setAuthorizedCloseTeam(e.target.value)}
                    placeholder="ví dụ: user1@etc.vn, user2@etc.vn"
                  />
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
                  Chú ý: Nhớ bấm <strong style={{ color: "var(--text-primary)" }}>Lưu & Kết nối</strong> ở bên trên để lưu cấu hình!
                </div>
              </div>
            )}

            {/* App Info */}
            <div className="settings-section" style={{ marginBottom: 0 }}>
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

          {/* --- CỘT PHẢI --- */}
          <div style={{ flex: "1 1 480px", display: "flex", flexDirection: "column", gap: 16 }}>
            
            {/* Background Job Config */}
            <div className="settings-section" style={{ marginBottom: 0 }}>
              <div className="settings-section-title">⚙️ Tự động Log Work (Job ngầm)</div>
              <div className="settings-section-desc">
                Hệ thống sẽ chạy ngầm vào 08:00 và 17:00 hàng ngày để tự động log work và chuyển trạng thái các task đến Due Date. Bạn có thể tắt tính năng này nếu không muốn.
              </div>
              
              <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", background: "var(--bg-card)", padding: "12px 16px", borderRadius: 8, border: "1px solid var(--border)" }}>
                <input 
                  type="checkbox" 
                  checked={autoLogEnabled}
                  onChange={(e) => setAutoLogEnabled(e.target.checked)}
                  style={{ width: 18, height: 18, cursor: "pointer" }}
                />
                <span style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>Bật Job tự động Log Work</span>
              </label>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
                Chú ý: Nhớ bấm <strong style={{ color: "var(--text-primary)" }}>Lưu & Kết nối</strong> ở bên trên để lưu trạng thái!
              </div>
            </div>

            {/* Holidays Config */}
            <div className="settings-section" style={{ marginBottom: 0 }}>
              <div className="settings-section-title">🏖️ Quản lý Ngày nghỉ lễ</div>
              <div className="settings-section-desc">
                Khai báo các ngày nghỉ lễ để hệ thống tính toán chính xác số giờ làm việc chuẩn trên Dashboard.
              </div>

              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <input
                  type="date"
                  value={newHoliday}
                  onChange={(e) => setNewHoliday(e.target.value)}
                  style={{ flex: 1, maxWidth: 200 }}
                />
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    if (newHoliday && !holidays.includes(newHoliday)) {
                      const next = [...holidays, newHoliday].sort();
                      setHolidays(next);
                      setNewHoliday("");
                    }
                  }}
                >
                  + Thêm
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    if (confirm("Bạn có chắc chắn muốn khôi phục danh sách mặc định không?")) {
                      setHolidays(DEFAULT_HOLIDAYS);
                    }
                  }}
                >
                  Khôi phục mặc định
                </button>
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, maxHeight: 200, overflowY: "auto", padding: 12, background: "var(--bg-card)", borderRadius: 8, border: "1px solid var(--border)" }}>
                {holidays.length === 0 && <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Chưa có ngày nghỉ lễ nào.</span>}
                {holidays.map(d => (
                  <div key={d} style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--bg-secondary)", border: "1px solid var(--border)", padding: "4px 8px", borderRadius: 16, fontSize: 13 }}>
                    <span>{d}</span>
                    <button
                      className="btn-ghost"
                      style={{ padding: 0, width: 20, height: 20, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent-red)", cursor: "pointer", border: "none", background: "transparent" }}
                      onClick={() => setHolidays(holidays.filter(h => h !== d))}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
                Chú ý: Nhớ bấm <strong style={{ color: "var(--text-primary)" }}>Lưu & Kết nối</strong> ở bên trên để lưu danh sách!
              </div>
            </div>

            {/* Azure Info */}
            <div className="settings-section" style={{ marginBottom: 0 }}>
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
