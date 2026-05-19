import React, { useState } from "react";
import { createIssue, addWorklog, JiraIssue } from "../jiraService";
import { JIRA_PROJECTS } from "../config";

interface CreationLog {
  summary: string;
  status: "pending" | "processing" | "success" | "error";
  key?: string;
  errorMsg?: string;
  logDateText?: string;
}

export default function BulkCreate() {
  const [selectedProject, setSelectedProject] = useState(JIRA_PROJECTS[0].key);
  const [bulkText, setBulkText] = useState("");
  const [assignee, setAssignee] = useState("");
  const [estimate] = useState("7h"); // Cố định 7h theo yêu cầu
  const [autoLogWork, setAutoLogWork] = useState(true);
  const [startDate, setStartDate] = useState(() => {
    const now = new Date();
    return now.toISOString().slice(0, 10);
  });
  const [logs, setLogs] = useState<CreationLog[]>([]);
  const [isRunning, setIsRunning] = useState(false);

  const isConfigured = !!localStorage.getItem("jira_pat") || !!localStorage.getItem("jira_basic");

  // Helper tìm ngày làm việc kế tiếp (bỏ qua Thứ Bảy/Chủ Nhật)
  const getNextWorkday = (date: Date): Date => {
    const d = new Date(date);
    while (d.getDay() === 0 || d.getDay() === 6) {
      d.setDate(d.getDate() + 1);
    }
    return d;
  };

  const advanceDay = (date: Date): Date => {
    const d = new Date(date);
    d.setDate(d.getDate() + 1);
    return getNextWorkday(d);
  };

  const handleBulkCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bulkText.trim()) return;

    const summaries = bulkText
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (summaries.length === 0) return;

    setIsRunning(true);
    const initialLogs = summaries.map((s) => ({
      summary: s,
      status: "pending" as const,
    }));
    setLogs(initialLogs);

    let currentLogDate = getNextWorkday(new Date(startDate));

    for (let i = 0; i < summaries.length; i++) {
      if (i > 0) {
        currentLogDate = advanceDay(currentLogDate);
      }

      const logDateFormatted = currentLogDate.toLocaleDateString("vi-VN", {
        weekday: "short",
        year: "numeric",
        month: "numeric",
        day: "numeric",
      });

      // Cập nhật trạng thái sang 'processing' kèm ngày log/gán
      setLogs((prev) =>
        prev.map((log, idx) =>
          idx === i 
            ? { 
                ...log, 
                status: "processing", 
                logDateText: autoLogWork 
                  ? `Lên lịch log: ${logDateFormatted}` 
                  : `Lên lịch gán ngày: ${logDateFormatted}` 
              } 
            : log
        )
      );

      try {
        const formatJiraIsoDate = (d: Date, hour: number, minute: number) => {
          const year = d.getFullYear();
          const month = String(d.getMonth() + 1).padStart(2, "0");
          const day = String(d.getDate()).padStart(2, "0");
          const hh = String(hour).padStart(2, "0");
          const mm = String(minute).padStart(2, "0");

          // Tính múi giờ hiện tại (timezone offset) để định dạng +0700
          const offset = -d.getTimezoneOffset();
          const sign = offset >= 0 ? "+" : "-";
          const offsetHours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
          const offsetMins = String(Math.abs(offset) % 60).padStart(2, "0");

          return `${year}-${month}-${day}T${hh}:${mm}:00.000${sign}${offsetHours}${offsetMins}`;
        };

        const startDateStr = formatJiraIsoDate(currentLogDate, 8, 0); // 08:00 AM
        const endDateStr = formatJiraIsoDate(currentLogDate, 17, 0); // 17:00 PM (5:00 PM)

        const created: JiraIssue = await createIssue({
          projectKey: selectedProject,
          summary: summaries[i],
          assigneeName: assignee.trim() || undefined,
          originalEstimate: estimate,
          customFields: {
            "customfield_10300": startDateStr,
            "customfield_10302": endDateStr,
          }
        });

        // Nếu bật tự động log, thực hiện log work 7h
        if (autoLogWork) {
          const startedStr = currentLogDate.toISOString().replace("Z", "+0000");
          await addWorklog(created.key, {
            timeSpentSeconds: 7 * 3600, // 7h
            comment: `Thực hiện công việc: ${summaries[i]}`,
            started: startedStr,
            adjustEstimate: "auto",
          });
        }

        // Cập nhật trạng thái 'success' kèm theo Key
        setLogs((prev) =>
          prev.map((log, idx) =>
            idx === i ? { ...log, status: "success", key: created.key } : log
          )
        );
      } catch (err: unknown) {
        const e = err as { response?: { data?: { errorMessages?: string[] } }; message?: string };
        const msg = e.response?.data?.errorMessages?.[0] || e.message || "Lỗi tạo issue";
        
        // Cập nhật trạng thái 'error'
        setLogs((prev) =>
          prev.map((log, idx) =>
            idx === i ? { ...log, status: "error", errorMsg: msg } : log
          )
        );
      }
    }
    setIsRunning(false);
    setBulkText(""); // Clear form sau khi hoàn thành
  };

  if (!isConfigured) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div className="page-header">
          <div className="page-title-group">
            <h1 className="page-title">Tạo Issue Nhanh</h1>
          </div>
        </div>
        <div className="page-body" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="empty-state">
            <div className="empty-state-icon">🔌</div>
            <div className="empty-state-title">Chưa kết nối Jira</div>
            <p className="empty-state-text">Vào Cài đặt để kết nối với server Jira trước.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">Tạo Issue Nhanh</h1>
          <p className="page-subtitle">Tự động tạo nhiều issues với thời gian Estimate mặc định là 7 giờ</p>
        </div>
      </div>

      <div className="page-body">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, alignItems: "start" }}>
          {/* Cột 1: Nhập liệu */}
          <div className="settings-section">
            <div className="settings-section-title">➕ Tạo hàng loạt Issue</div>
            <div className="settings-section-desc">Mỗi dòng văn bản bên dưới sẽ được tạo thành một Issue riêng biệt.</div>

            <form onSubmit={handleBulkCreate}>
              <div className="form-group">
                <label>Dự án (Project)</label>
                <select
                  value={selectedProject}
                  onChange={(e) => setSelectedProject(e.target.value)}
                  disabled={isRunning}
                >
                  {JIRA_PROJECTS.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.name} ({p.key})
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label>Danh sách tóm tắt Issue (Mỗi dòng là 1 Issue) *</label>
                <textarea
                  placeholder="Ví dụ:&#10;Thiết kế giao diện trang chủ&#10;Viết API đồng bộ hóa dữ liệu&#10;Kiểm thử các chức năng cốt lõi"
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  disabled={isRunning}
                  rows={8}
                  style={{ fontFamily: "inherit", lineHeight: "1.5" }}
                  required
                />
              </div>

              <div className="form-group">
                <label>Tài khoản Assignee (Username)</label>
                <input
                  type="text"
                  placeholder="Ví dụ: namha (Để trống sẽ tự động assign cho bạn)"
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                  disabled={isRunning}
                />
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                  Nếu để trống, ứng dụng sẽ gọi API <code>/myself</code> để lấy tên tài khoản của bạn và tự động gắn vào.
                </div>
              </div>

              <div className="form-group" style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0" }}>
                <input
                  id="checkbox-autolog"
                  type="checkbox"
                  checked={autoLogWork}
                  onChange={(e) => setAutoLogWork(e.target.checked)}
                  disabled={isRunning}
                  style={{ width: "auto", margin: 0, cursor: "pointer" }}
                />
                <label htmlFor="checkbox-autolog" style={{ cursor: "pointer", fontWeight: "normal", fontSize: 13, userSelect: "none" }}>
                  Tự động log work 7h cho mỗi issue sau khi tạo?
                </label>
              </div>

              <div className="form-group">
                <label htmlFor="input-start-date-log">
                  {autoLogWork ? "Ngày bắt đầu log work *" : "Ngày bắt đầu của Task *"}
                </label>
                <input
                  id="input-start-date-log"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  disabled={isRunning}
                  required
                />
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                  {autoLogWork 
                    ? "Mỗi dòng tóm tắt sẽ tự động được gán Start/End Date và log 7h trên 1 ngày kế tiếp (bỏ qua Thứ Bảy và Chủ Nhật)."
                    : "Mỗi dòng tóm tắt sẽ tự động được gán Start/End Date trên 1 ngày kế tiếp (bỏ qua Thứ Bảy và Chủ Nhật) nhưng KHÔNG thực hiện log work."}
                </div>
              </div>

              <div className="form-group">
                <label>Thời gian Estimate mặc định</label>
                <input
                  type="text"
                  value={estimate}
                  disabled
                  style={{ opacity: 0.7, background: "rgba(255,255,255,0.02)" }}
                />
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                  Mỗi Issue tạo ra sẽ tự động được set Original Estimate là <strong>7 giờ</strong>.
                </div>
              </div>

              <button
                type="submit"
                className="btn btn-primary"
                disabled={isRunning || !bulkText.trim()}
                style={{ width: "100%", padding: "12px", marginTop: 8 }}
              >
                {isRunning ? (
                  <><span className="spinning">🌀</span> Đang xử lý tự động...</>
                ) : (
                  <>🚀 Bắt đầu Tạo Issues</>
                )}
              </button>
            </form>
          </div>

          {/* Cột 2: Trạng thái & Tiến độ */}
          <div className="settings-section" style={{ minHeight: 460, display: "flex", flexDirection: "column" }}>
            <div className="settings-section-title">📊 Tiến trình thực hiện</div>
            <div className="settings-section-desc">Theo dõi trạng thái tạo tự động thời gian thực.</div>

            <div
              style={{
                flex: 1,
                background: "rgba(0,0,0,0.15)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: 16,
                marginTop: 16,
                maxHeight: 440,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {logs.length === 0 ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", opacity: 0.5, padding: "40px 0" }}>
                  <span style={{ fontSize: 32, marginBottom: 8 }}>📋</span>
                  <span style={{ fontSize: 13 }}>Danh sách trống. Hãy nhập nội dung và bấm Tạo.</span>
                </div>
              ) : (
                logs.map((log, idx) => (
                  <div
                    key={idx}
                    style={{
                      background: "var(--bg-card)",
                      borderRadius: 8,
                      padding: "10px 14px",
                      border: "1px solid var(--border)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      fontSize: 13,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          color: "var(--text-primary)",
                          fontWeight: 500,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {log.summary}
                      </div>
                      {log.logDateText && (
                        <div style={{ color: "var(--accent-blue-light)", fontSize: 11, marginTop: 2, fontWeight: 500 }}>
                          📅 {log.logDateText}
                        </div>
                      )}
                      {log.errorMsg && (
                        <div style={{ color: "var(--accent-red)", fontSize: 11, marginTop: 2 }}>
                          ⚠️ {log.errorMsg}
                        </div>
                      )}
                    </div>

                    <div style={{ flexShrink: 0 }}>
                      {log.status === "pending" && (
                        <span style={{ color: "var(--text-muted)" }}>⏳ Đang chờ</span>
                      )}
                      {log.status === "processing" && (
                        <span style={{ color: "var(--accent-blue)", fontWeight: 600 }} className="spinning-slow">
                          🌀 Đang tạo...
                        </span>
                      )}
                      {log.status === "success" && (
                        <a
                          href={`https://20.84.97.109:3033/browse/${log.key}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            color: "var(--accent-green)",
                            fontWeight: 700,
                            textDecoration: "none",
                            background: "rgba(16, 185, 129, 0.1)",
                            padding: "4px 8px",
                            borderRadius: 6,
                          }}
                        >
                          ✅ {log.key} ↗
                        </a>
                      )}
                      {log.status === "error" && (
                        <span style={{ color: "var(--accent-red)", fontWeight: 600 }}>❌ Thất bại</span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
