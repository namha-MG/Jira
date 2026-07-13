import { useEffect, useMemo, useState } from "react";
import { getSelectedJiraProjects } from "../config";
import { formatSeconds } from "../jiraService";
import {
  GitReconciliationResult,
  GitReconciliationRow,
  runGitReconciliation,
} from "../gitReconciliationService";

interface Toast { id: number; type: "success" | "error" | "info"; msg: string; }

function todayInputValue() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function formatDateTime(value: string) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function shortCommitMessage(message: string) {
  const firstLine = message.split(/\r?\n/)[0] || "";
  return firstLine.length > 110 ? `${firstLine.slice(0, 110)}...` : firstLine;
}

function getStatusBadge(row: GitReconciliationRow) {
  if (row.status === "matched") {
    return <span className="badge badge-done">Đạt</span>;
  }
  return <span className="badge badge-blocked">Thiếu commit</span>;
}

export default function GitReconciliation() {
  const jiraProjects = getSelectedJiraProjects();
  const defaultProjectKeys = useMemo(() => jiraProjects.map((project) => project.key), [jiraProjects]);
  const [date, setDate] = useState(todayInputValue);
  const [selectedProjectKeys, setSelectedProjectKeys] = useState<string[]>(defaultProjectKeys);
  const [result, setResult] = useState<GitReconciliationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    setSelectedProjectKeys(defaultProjectKeys);
  }, [defaultProjectKeys]);

  const addToast = (type: Toast["type"], msg: string) => {
    const id = Date.now();
    setToasts((current) => [...current, { id, type, msg }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4000);
  };

  const toggleProject = (projectKey: string) => {
    setSelectedProjectKeys((current) => {
      if (current.includes(projectKey)) {
        return current.filter((key) => key !== projectKey);
      }
      return [...current, projectKey];
    });
  };

  const handleRun = async () => {
    if (selectedProjectKeys.length === 0) {
      addToast("error", "Vui lòng chọn ít nhất 1 project để đối soát.");
      return;
    }

    setLoading(true);
    try {
      const data = await runGitReconciliation({ date, projectKeys: selectedProjectKeys });
      setResult(data);
      addToast("success", data.telegramReport?.sent
        ? "Đã chạy đối soát và gửi report Telegram."
        : "Đã chạy đối soát Git với worklog Jira trong ngày.");
      if (data.telegramReport && !data.telegramReport.sent && data.telegramReport.error) {
        addToast("info", `Telegram: ${data.telegramReport.error}`);
      }
    } catch (err: any) {
      addToast("error", err?.message || "Không chạy được đối soát Git.");
    } finally {
      setLoading(false);
    }
  };

  const rows = result?.results || [];
  const missingRows = rows.filter((row) => row.status === "missing");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">Đối soát Git</h1>
          <p className="page-subtitle">Kiểm tra task đã log Jira với commit Git của account cấu hình, dùng AI để so nội dung Việt-Anh và gửi report Telegram.</p>
        </div>
        <div className="page-actions" style={{ marginLeft: "auto" }}>
          <button className="btn btn-primary" onClick={handleRun} disabled={loading}>
            {loading ? <><span className="spinning">⏳</span> Đang đối soát...</> : "Chạy đối soát"}
          </button>
        </div>
      </div>

      <div className="page-body">
        <div className="settings-section">
          <div className="settings-section-title">Bộ lọc đối soát</div>
          <div className="settings-section-desc">
            Nguồn Jira là các worklog của bạn trong ngày được chọn. Nguồn Git là các repo đã cấu hình theo project trong Settings.
          </div>

          <div className="filter-bar" style={{ marginBottom: 0 }}>
            <input
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              style={{ maxWidth: 180 }}
            />
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSelectedProjectKeys(defaultProjectKeys)}>
              Chọn project đang tham gia
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSelectedProjectKeys([])}>
              Bỏ chọn
            </button>
          </div>

          <div className="settings-project-grid" style={{ marginTop: 12 }}>
            {jiraProjects.map((project) => (
              <label key={project.key} className="settings-project-option">
                <input
                  type="checkbox"
                  checked={selectedProjectKeys.includes(project.key)}
                  onChange={() => toggleProject(project.key)}
                />
                <span>
                  <strong>{project.key}</strong>
                  {project.name !== project.key && <small>{project.name}</small>}
                </span>
              </label>
            ))}
          </div>
        </div>

        {result && (
          <>
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-icon">📋</div>
                <div className="stat-value">{result.stats.loggedTaskCount}</div>
                <div className="stat-label">Task đã log trong ngày</div>
              </div>
              <div className="stat-card">
                <div className="stat-icon">✅</div>
                <div className="stat-value">{result.stats.matchedCount}</div>
                <div className="stat-label">Task có commit khớp</div>
              </div>
              <div className="stat-card">
                <div className="stat-icon">⚠️</div>
                <div className="stat-value">{result.stats.missingCount}</div>
                <div className="stat-label">Task thiếu commit</div>
              </div>
              <div className="stat-card">
                <div className="stat-icon">🔗</div>
                <div className="stat-value">{result.stats.commitCount}</div>
                <div className="stat-label">Commit đã quét</div>
              </div>
            </div>

            {result.repoErrors.length > 0 && (
              <div className="settings-section" style={{ borderColor: "rgba(245, 158, 11, 0.35)" }}>
                <div className="settings-section-title">Repo chưa quét được</div>
                <div className="settings-section-desc">Kiểm tra lại URL repo hoặc Git PAT nếu các repo dưới đây trả lỗi.</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {result.repoErrors.map((error) => (
                    <div key={`${error.projectKey}-${error.repoUrl}`} style={{ fontSize: 12, color: "var(--text-secondary)", overflowWrap: "anywhere" }}>
                      <strong style={{ color: "var(--accent-orange)" }}>{error.projectKey}</strong> · {error.repoUrl} · {error.error}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result.telegramReport && (
              <div className={`connection-status ${result.telegramReport.sent ? "connected" : "error"}`}>
                <span>{result.telegramReport.sent ? "✅" : "⚠️"}</span>
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {result.telegramReport.sent ? "Đã gửi report Telegram" : "Chưa gửi được report Telegram"}
                  </div>
                  {!result.telegramReport.sent && result.telegramReport.error && (
                    <div style={{ fontSize: 12, opacity: 0.8 }}>{result.telegramReport.error}</div>
                  )}
                </div>
              </div>
            )}

            {missingRows.length > 0 && (
              <div className="settings-section" style={{ borderColor: "rgba(239, 68, 68, 0.28)" }}>
                <div className="settings-section-title">Task cần bổ sung commit</div>
                <div className="settings-section-desc">Các task này đã có worklog trong ngày nhưng chưa tìm thấy commit khớp issue key hoặc nội dung.</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {missingRows.map((row) => (
                    <span key={row.issueKey} className="badge badge-blocked">{row.issueKey}</span>
                  ))}
                </div>
              </div>
            )}

            <div className="chart-card">
              <div className="chart-title">Kết quả chi tiết</div>
              <div className="chart-subtitle">Một task được tính đạt khi có commit trong ngày khớp issue key hoặc được AI đánh giá phù hợp với nội dung task/worklog.</div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Trạng thái</th>
                      <th>Task Jira</th>
                      <th>Worklog trong ngày</th>
                      <th>Commit khớp</th>
                      <th>Lý do</th>
                      <th>Repo/Commit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.issueKey}>
                        <td>{getStatusBadge(row)}</td>
                        <td style={{ minWidth: 220 }}>
                          <div style={{ fontWeight: 700, color: "var(--accent-blue-light)" }}>{row.issueKey}</div>
                          <div style={{ color: "var(--text-secondary)", fontSize: 12, marginTop: 2 }}>{row.summary}</div>
                        </td>
                        <td style={{ minWidth: 240 }}>
                          {row.worklogs.map((worklog) => (
                            <div key={worklog.id} style={{ marginBottom: 8 }}>
                              <div style={{ color: "var(--text-primary)", fontWeight: 600, fontSize: 12 }}>
                                {formatSeconds(worklog.timeSpentSeconds)} · {formatDateTime(worklog.started)}
                              </div>
                              {worklog.comment && (
                                <div style={{ color: "var(--text-secondary)", fontSize: 12 }}>{worklog.comment}</div>
                              )}
                            </div>
                          ))}
                        </td>
                        <td style={{ minWidth: 260 }}>
                          {row.matchedCommit ? (
                            <div>
                              <a
                                href={row.matchedCommit.url}
                                target="_blank"
                                rel="noreferrer"
                                style={{ color: "var(--accent-green)", fontWeight: 700, textDecoration: "none" }}
                              >
                                {row.matchedCommit.shortSha}
                              </a>
                              <div style={{ color: "var(--text-secondary)", fontSize: 12, marginTop: 3 }}>
                                {shortCommitMessage(row.matchedCommit.message)}
                              </div>
                              {row.matchedCommit.branches?.length > 0 && (
                                <div style={{ color: "var(--accent-blue-light)", fontSize: 11, marginTop: 3 }}>
                                  Branch: {row.matchedCommit.branches.join(", ")}
                                </div>
                              )}
                              <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 3 }}>
                                {row.matchedCommit.authorName || "-"} · {formatDateTime(row.matchedCommit.committedAt)}
                              </div>
                            </div>
                          ) : (
                            <span style={{ color: "var(--text-muted)" }}>Chưa có commit khớp</span>
                          )}
                        </td>
                        <td style={{ color: "var(--text-secondary)", minWidth: 180 }}>
                          {row.matchReason}
                          {row.matchScore > 0 && <div style={{ color: "var(--text-muted)", fontSize: 11 }}>Score: {row.matchScore}</div>}
                        </td>
                        <td style={{ color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                          {row.repoCount} repo · {row.commitCount} commit
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={6}>
                          <div className="empty-state" style={{ padding: 28 }}>
                            <div className="empty-state-title">Không có task đã log trong ngày này</div>
                            <p className="empty-state-text">Đổi ngày hoặc project rồi chạy lại đối soát.</p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="toast-container">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.type}`}>{toast.msg}</div>
        ))}
      </div>
    </div>
  );
}
