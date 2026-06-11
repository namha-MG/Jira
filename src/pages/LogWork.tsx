import { useState, useEffect } from "react";
import { addWorklog, parseTimeToSeconds, getMyIssues, JiraIssue, getTransitions, transitionIssue, getIssue, getJiraFields } from "../jiraService";
import { JIRA_PROJECTS } from "../config";

interface Toast { id: number; type: "success" | "error"; msg: string; }

export default function LogWork() {
  const [issueKeysText, setIssueKeysText] = useState("");
  const [timeSpent, setTimeSpent] = useState("7h");
  const [logDate, setLogDate] = useState(() => {
    const now = new Date();
    return now.toISOString().slice(0, 10);
  });
  const [logTime, setLogTime] = useState("08:00");

  const currentTasksCount = issueKeysText
    .split(/[\n, ]+/)
    .map(k => k.trim())
    .filter(k => k.length > 0).length;
  const [comment, setComment] = useState("");
  const [adjustEstimate, setAdjustEstimate] = useState<"auto" | "leave" | "manual" | "new">("auto");
  const [submitting, setSubmitting] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [myIssues, setMyIssues] = useState<JiraIssue[]>([]);

  const isConfigured = !!localStorage.getItem("jira_pat") || !!localStorage.getItem("jira_basic");

  const fetchSuggestedIssues = () => {
    if (!isConfigured) return;
    setLoadingIssues(true);
    getMyIssues({
      projectKeys: JIRA_PROJECTS.map((p) => p.key),
      maxResults: 100,
      assignee: assigneeFilter,
    })
      .then((res) => setMyIssues(res.issues))
      .catch((e) => console.error("Failed to load suggested issues:", e))
      .finally(() => setLoadingIssues(false));
  };

  useEffect(() => {
    fetchSuggestedIssues();
  }, [isConfigured]);

  const addToast = (type: "success" | "error", msg: string) => {
    const id = Date.now();
    setToasts((t) => [...t, { id, type, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  };

  const [generatingAi, setGeneratingAi] = useState(false);

  const handleGenerateAiComment = async () => {
    const keysToLog = issueKeysText
      .split(/[\n, ]+/)
      .map(k => k.trim().toUpperCase())
      .filter(k => k.length > 0);

    if (keysToLog.length === 0) {
      addToast("error", "⚠️ Vui lòng điền ít nhất 1 Issue Key trước khi sinh ghi chú.");
      return;
    }

    const geminiKey = localStorage.getItem("gemini_api_key");
    if (!geminiKey) {
      addToast("error", "⚠️ Vui lòng vào trang Cài đặt để cấu hình Google Gemini API Key trước.");
      return;
    }

    setGeneratingAi(true);
    try {
      const key = keysToLog[0];
      let issueObj = myIssues.find((i) => i.key === key);
      if (!issueObj) {
        try {
          issueObj = await getIssue(key);
        } catch {
          // ignore
        }
      }

      const summary = issueObj?.fields?.summary || "";
      if (!summary) {
        throw new Error(`Không tìm thấy tiêu đề của task ${key} trên Jira.`);
      }

      const prompt = `Bạn là một kỹ sư phần mềm chuyên nghiệp. Hãy viết 1 câu ngắn gọn (dưới 15 từ) ghi chú lại công việc đã thực hiện cho task Jira có tiêu đề: "${summary}". Ví dụ: "Đã hoàn thành tối ưu hóa truy vấn SQL và sửa lỗi bộ lọc". Viết bằng tiếng Việt, trực tiếp, bắt đầu bằng từ hành động như "Hoàn thành...", "Cải tiến...", "Tối ưu...", "Sửa lỗi...", không dài dòng, không có phần giới thiệu, không thêm bất kỳ định dạng markdown hay dấu ngoặc kép nào xung quanh.`;

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }]
        })
      });

      if (!response.ok) {
        let errorMsg = "Lỗi kết nối Gemini API.";
        try {
          const errData = await response.json();
          if (errData.error?.message) {
            errorMsg = errData.error.message;
          } else if (errData.message) {
            errorMsg = errData.message;
          }
        } catch {
          // ignore
        }
        throw new Error(`${errorMsg} (Mã lỗi: ${response.status})`);
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
      if (text) {
        setComment(text);
        addToast("success", "✨ Đã sinh ghi chú công việc bằng AI thành công!");
      } else {
        throw new Error("Không nhận được phản hồi hợp lệ từ AI.");
      }
    } catch (e: any) {
      addToast("error", `❌ Lỗi sinh ghi chú AI: ${e.message || "Lỗi không xác định"}`);
    } finally {
      setGeneratingAi(false);
    }
  };

  const handleAutoTransition = async (key: string) => {
    addToast("success", `⏱️ Đang tự động cập nhật trạng thái cho ${key} vì đã log đủ thời gian estimate...`);
    try {
      let transitions = await getTransitions(key);

      const inprogressKeywords = ["in progress", "đang thực hiện", "đang làm", "to do", "cần làm"];
      const resolvedKeywords = ["resolved", "done", "đã giải quyết", "hoàn thành", "ready for test", "resolved / done"];
      const closedKeywords = ["closed", "đóng"];

      // 1. Chuyển sang In Progress (nếu đang ở Open và có transition này)
      const toInProgress = transitions.find(t => 
        inprogressKeywords.includes(t.to.name.toLowerCase()) || 
        inprogressKeywords.some(kw => t.name.toLowerCase().includes(kw))
      );

      if (toInProgress) {
        await transitionIssue(key, toInProgress.id);
        addToast("success", `🔄 Đã chuyển ${key} sang trạng thái: ${toInProgress.to.name}`);
        // Lấy lại danh sách transition tiếp theo
        transitions = await getTransitions(key);
      }

      // 2. Chuyển sang Resolved/Hoàn thành
      const toResolved = transitions.find(t => 
        resolvedKeywords.includes(t.to.name.toLowerCase()) || 
        resolvedKeywords.some(kw => t.name.toLowerCase().includes(kw))
      );

      if (toResolved) {
        const allFields = await getJiraFields();
        const outputField = allFields.find(f => f.name.toLowerCase() === "output" || f.name.toLowerCase() === "out put");
        const transitionFields: any = { resolution: { id: "10000" } };
        if (outputField) transitionFields[outputField.id] = "Tự động hoàn thành";

        await transitionIssue(key, toResolved.id, transitionFields);
        addToast("success", `🔄 Đã chuyển ${key} sang trạng thái: ${toResolved.to.name}`);
        // Lấy lại danh sách transition tiếp theo
        transitions = await getTransitions(key);
      }

      // 3. Chuyển sang Closed/Đóng
      const toClosed = transitions.find(t => 
        closedKeywords.includes(t.to.name.toLowerCase()) || 
        closedKeywords.some(kw => t.name.toLowerCase().includes(kw))
      );

      if (toClosed) {
        const allFields = await getJiraFields();
        const outputField = allFields.find(f => f.name.toLowerCase() === "output" || f.name.toLowerCase() === "out put");
        const transitionFields: any = { resolution: { id: "10000" } };
        if (outputField) transitionFields[outputField.id] = "Tự động hoàn thành";

        await transitionIssue(key, toClosed.id, transitionFields);
        addToast("success", `🔒 Đã đóng (Closed) issue ${key} thành công!`);
      }
    } catch (transErr: any) {
      console.error("Auto transition failed:", transErr);
      addToast("error", `⚠️ Không thể chuyển trạng thái tự động: ${transErr.message || "Lỗi workflow"}`);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!issueKeysText.trim() || !timeSpent.trim()) {
      addToast("error", "Vui lòng nhập Issue Key và thời gian");
      return;
    }

    const seconds = parseTimeToSeconds(timeSpent.trim());
    if (seconds === 0) {
      addToast("error", "Định dạng thời gian không hợp lệ. Ví dụ: 2h, 30m, 1h 30m");
      return;
    }

    const keysToLog = issueKeysText
      .split(/[\n, ]+/)
      .map(k => k.trim().toUpperCase())
      .filter(k => k.length > 0);

    if (keysToLog.length === 0) {
      addToast("error", "Không có Issue Key hợp lệ");
      return;
    }

    setSubmitting(true);
    let successCount = 0;

    for (const key of keysToLog) {
      try {
        // Tìm issueObj để lấy summary phục vụ sinh comment tự động và lấy Start Date
        let issueObj = myIssues.find((i) => i.key === key);
        if (!issueObj) {
          try {
             issueObj = await getIssue(key);
          } catch(e) {
             console.warn("Could not fetch issue", key);
          }
        }

        let started: string;
        if (keysToLog.length === 1 && logDate && logTime) {
           const [h, min] = logTime.split(':').map(Number);
           const [y, m, d] = logDate.split('-').map(Number);
           
           const dateObj = new Date(y, m - 1, d, isNaN(h) ? 8 : h, isNaN(min) ? 0 : min, 0);
           const offset = -dateObj.getTimezoneOffset();
           const sign = offset >= 0 ? "+" : "-";
           const offsetHours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
           const offsetMins = String(Math.abs(offset) % 60).padStart(2, "0");
           const yyyy = dateObj.getFullYear();
           const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
           const dd = String(dateObj.getDate()).padStart(2, "0");
           const hh = String(dateObj.getHours()).padStart(2, "0");
           const mmm = String(dateObj.getMinutes()).padStart(2, "0");

           started = `${yyyy}-${mm}-${dd}T${hh}:${mmm}:00.000${sign}${offsetHours}${offsetMins}`;
        } else if (issueObj && issueObj.fields && issueObj.fields.customfield_10300) {
           started = issueObj.fields.customfield_10300;
        } else {
           // Fallback: 8:00 AM hôm nay nếu task không có Start Date
           const today = new Date();
           today.setHours(8, 0, 0, 0);
           const offset = -today.getTimezoneOffset();
           const sign = offset >= 0 ? "+" : "-";
           const offsetHours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
           const offsetMins = String(Math.abs(offset) % 60).padStart(2, "0");
           const yyyy = today.getFullYear();
           const mm = String(today.getMonth() + 1).padStart(2, "0");
           const dd = String(today.getDate()).padStart(2, "0");
           started = `${yyyy}-${mm}-${dd}T08:00:00.000${sign}${offsetHours}${offsetMins}`;
        }

        let finalComment = comment.trim();
        if (!finalComment) {
          // Thử sinh bằng AI tự động nếu có API key
          const geminiKey = localStorage.getItem("gemini_api_key");
          if (geminiKey && issueObj && issueObj.fields && issueObj.fields.summary) {
            try {
              const summary = issueObj.fields.summary;
              const prompt = `Bạn là một kỹ sư phần mềm chuyên nghiệp. Hãy viết 1 câu ngắn gọn (dưới 15 từ) ghi chú lại công việc đã thực hiện cho task Jira có tiêu đề: "${summary}". Ví dụ: "Đã hoàn thành tối ưu hóa truy vấn SQL và sửa lỗi bộ lọc". Viết bằng tiếng Việt, trực tiếp, bắt đầu bằng từ hành động như "Hoàn thành...", "Cải tiến...", "Tối ưu...", "Sửa lỗi...", không dài dòng, không có phần giới thiệu, không thêm bất kỳ định dạng markdown hay dấu ngoặc kép nào xung quanh.`;
              const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
              });
              if (response.ok) {
                const data = await response.json();
                finalComment = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
              } else {
                let errText = `HTTP ${response.status}`;
                try {
                  const errData = await response.json();
                  errText = errData.error?.message || errData.message || errText;
                } catch {}
                console.warn(`Auto AI comment failed: ${errText}`);
              }
            } catch (e) {
              console.warn("Auto AI generation failed, falling back to static template", e);
            }
          }

          // Fallback nếu AI lỗi hoặc không có API key
          if (!finalComment) {
            if (issueObj && issueObj.fields && issueObj.fields.summary) {
              finalComment = `Thực hiện công việc: ${issueObj.fields.summary}`;
            } else {
              finalComment = `Thực hiện công việc cho task ${key}`;
            }
          }
        }

        await addWorklog(key, {
          timeSpentSeconds: seconds,
          comment: finalComment,
          started,
          adjustEstimate,
        });
        
        addToast("success", `✅ Đã log ${timeSpent} vào ${key} thành công!`);
        successCount++;

        // Tự động chuyển đổi trạng thái nếu tổng thời gian log vượt quá estimate
        if (issueObj) {
          const est = issueObj.fields.timetracking?.originalEstimateSeconds || 0;
          const currentLogged = issueObj.fields.timetracking?.timeSpentSeconds || 0;
          const newTotalLogged = currentLogged + seconds;

          if (est > 0 && newTotalLogged >= est) {
            setTimeout(() => handleAutoTransition(key), 1000);
          }
        }
      } catch (err: unknown) {
        const e = err as { 
          response?: { 
            data?: { 
              errorMessages?: string[]; 
              errors?: Record<string, string>; 
            } 
          }; 
          message?: string; 
        };
        
        let msg = "Lỗi không xác định";
        if (e.response?.data) {
          const data = e.response.data;
          if (data.errorMessages && data.errorMessages.length > 0) {
            msg = data.errorMessages[0];
          } else if (data.errors && Object.keys(data.errors).length > 0) {
            msg = Object.entries(data.errors)
              .map(([field, val]) => `${field}: ${val}`)
              .join("; ");
          }
        } else if (e.message) {
          msg = e.message;
        }
        
        addToast("error", `❌ Lỗi log work cho ${key}: ${msg}`);
      }
    }

    setSubmitting(false);
    if (successCount === keysToLog.length) {
       setIssueKeysText("");
       setComment("");
    }
  };

  // Lọc chỉ những task đang ở trạng thái inprogress hoặc open
  const filteredSuggestIssues = myIssues.filter((i) => {
    const statusName = i.fields.status.name.toLowerCase();
    return (
      statusName === "open" ||
      statusName === "in progress" ||
      statusName === "mở" ||
      statusName === "đang thực hiện" ||
      statusName === "đang làm" ||
      statusName === "to do" ||
      statusName === "cần làm"
    );
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">Log Công Việc</h1>
          <p className="page-subtitle">Ghi nhận thời gian làm việc vào Jira issue</p>
        </div>
      </div>

      <div className="page-body">
        {!isConfigured ? (
          <div className="empty-state">
            <div className="empty-state-icon">🔌</div>
            <div className="empty-state-title">Chưa kết nối Jira</div>
            <p className="empty-state-text">Vào Cài đặt để nhập Jira PAT token trước.</p>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 20, alignItems: "start" }}>
            {/* Form */}
            <div className="settings-section">
              <div className="settings-section-title">📝 Nhập worklog mới</div>
              <div className="settings-section-desc">Điền thông tin và nhấn Log Work để ghi nhận giờ làm việc</div>

              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label htmlFor="input-issue-key">Danh sách Issue Keys *</label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <textarea
                      id="input-issue-key"
                      placeholder="Nhập các Issue Key, phân tách bằng dấu phẩy hoặc xuống dòng (Ví dụ: BXDCSDL-123)... Hoặc chọn từ danh sách bên dưới"
                      value={issueKeysText}
                      onChange={(e) => setIssueKeysText(e.target.value.toUpperCase())}
                      rows={3}
                      required
                    />
                    
                    <select
                      id="select-suggested-issue"
                      value=""
                      onChange={(e) => {
                        const val = e.target.value;
                        if (!val) return;
                        setIssueKeysText(prev => prev ? `${prev}\n${val}` : val);
                      }}
                      style={{ 
                        fontSize: 13, 
                        padding: "8px 12px", 
                        borderRadius: 8, 
                        background: "var(--bg-card)", 
                        border: "1px solid var(--border)", 
                        color: "var(--text-primary)" 
                      }}
                      disabled={loadingIssues}
                    >
                      <option value="">🎯 {loadingIssues ? "Đang tải danh sách task của bạn..." : "Click để chọn nhanh từ Task được gán cho bạn"}</option>
                      {filteredSuggestIssues.map((issue) => (
                        <option key={issue.id} value={issue.key}>
                          [{issue.key}] {issue.fields.summary.length > 50 ? issue.fields.summary.slice(0, 50) + "..." : issue.fields.summary} ({issue.fields.status.name})
                        </option>
                      ))}
                    </select>

                    <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                      <input
                        type="text"
                        placeholder="🔍 Lọc Assignee (Để trống = Bản thân)"
                        value={assigneeFilter}
                        onChange={(e) => setAssigneeFilter(e.target.value)}
                        style={{ fontSize: 12, padding: "8px 12px", flex: 1 }}
                      />
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={fetchSuggestedIssues}
                        disabled={loadingIssues}
                        style={{ fontSize: 12, whiteSpace: "nowrap" }}
                      >
                        {loadingIssues ? "Đang tải..." : "Lọc Task"}
                      </button>
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                    Projects: {JIRA_PROJECTS.map((p) => p.key).join(", ")}
                  </div>
                </div>

                {currentTasksCount === 1 && (
                  <div className="form-group">
                    <label>Ngày giờ bắt đầu Log Work</label>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        type="date"
                        value={logDate}
                        onChange={(e) => setLogDate(e.target.value)}
                        disabled={submitting}
                        required
                        style={{ flex: 1 }}
                      />
                      <input
                        type="time"
                        value={logTime}
                        onChange={(e) => setLogTime(e.target.value)}
                        disabled={submitting}
                        required
                        style={{ width: "auto" }}
                      />
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                      Sẽ sử dụng ngày giờ này để log thay vì tự động lấy từ Start Date của Task.
                    </div>
                  </div>
                )}

                <div className="form-group">
                  <label htmlFor="input-time-spent">Thời gian *</label>
                  <input
                    id="input-time-spent"
                    type="text"
                    placeholder="Ví dụ: 2h, 30m, 1h 30m, 1d"
                    value={timeSpent}
                    onChange={(e) => setTimeSpent(e.target.value)}
                    required
                  />
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                    Định dạng: <code style={{ color: "var(--accent-blue)" }}>2h</code>, <code style={{ color: "var(--accent-blue)" }}>30m</code>, <code style={{ color: "var(--accent-blue)" }}>1h 30m</code>, <code style={{ color: "var(--accent-blue)" }}>1d</code> (1 day = 8h)
                  </div>
                </div>



                <div className="form-group">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <label htmlFor="input-comment" style={{ margin: 0 }}>Ghi chú công việc</label>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={handleGenerateAiComment}
                      disabled={generatingAi}
                      style={{ 
                        padding: "4px 8px", 
                        fontSize: 12, 
                        display: "flex", 
                        alignItems: "center", 
                        gap: 6, 
                        background: "rgba(16, 185, 129, 0.08)", 
                        border: "1px solid rgba(16, 185, 129, 0.2)",
                        color: "var(--accent-green)",
                        borderRadius: 6
                      }}
                    >
                      {generatingAi ? (
                        <>
                          <span className="spinning">⏳</span> Đang sinh bằng AI...
                        </>
                      ) : (
                        <>
                          <span>✨</span> Sinh ghi chú bằng AI
                        </>
                      )}
                    </button>
                  </div>
                  <textarea
                    id="input-comment"
                    placeholder="Mô tả công việc đã làm... (Ví dụ: Đã phát triển API, sửa lỗi hiển thị, tối ưu database...)"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    rows={4}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="select-adjust-estimate">Điều chỉnh Estimate sau khi log</label>
                  <select
                    id="select-adjust-estimate"
                    value={adjustEstimate}
                    onChange={(e) => setAdjustEstimate(e.target.value as typeof adjustEstimate)}
                  >
                    <option value="auto">Tự động tính toán lại (khuyến nghị)</option>
                    <option value="leave">Giữ nguyên estimate</option>
                    <option value="new">Đặt remaining mới</option>
                  </select>
                </div>

                <button
                  id="btn-submit-worklog"
                  type="submit"
                  className="btn btn-primary"
                  disabled={submitting}
                  style={{ width: "100%", padding: "12px" }}
                >
                  {submitting ? (
                    <><span className="spinning">⏳</span> Đang ghi...</>
                  ) : (
                    <><span>⏱️</span> Log Work</>
                  )}
                </button>
              </form>
            </div>

            {/* Tips */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div className="settings-section">
                <div className="settings-section-title">💡 Hướng dẫn nhập thời gian</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
                  {[
                    { input: "2h", desc: "2 giờ" },
                    { input: "30m", desc: "30 phút" },
                    { input: "1h 30m", desc: "1 giờ 30 phút" },
                    { input: "1d", desc: "1 ngày (8 giờ)" },
                    { input: "1d 2h", desc: "1 ngày 2 giờ (10 giờ)" },
                  ].map((ex) => (
                    <div key={ex.input} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        style={{ fontFamily: "monospace", minWidth: 70 }}
                        onClick={() => setTimeSpent(ex.input)}
                      >
                        {ex.input}
                      </button>
                      <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{ex.desc}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-section-title">🚀 Project Keys</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
                  {JIRA_PROJECTS.map((p) => (
                    <div key={p.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{p.name}</span>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        style={{ fontFamily: "monospace", fontSize: 11 }}
                        onClick={() => {
                          const key = p.key;
                          setIssueKeysText((prev) => prev ? `${prev}\n${key}-` : `${key}-`);
                          document.getElementById("input-issue-key")?.focus();
                        }}
                      >
                        {p.key}-...
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Toast notifications */}
      <div className="toast-container">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
