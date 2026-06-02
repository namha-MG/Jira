import { useEffect, useState, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";
import {
  getMyIssues, JiraIssue, formatSeconds, getTransitions, transitionIssue,
} from "../jiraService";
import { JIRA_PROJECTS } from "../config";

interface ProjectStat {
  projectKey: string;
  projectName: string;
  totalIssues: number;
  estimatedSeconds: number;
  loggedSeconds: number;
  remainingSeconds: number;
}

const STATUS_COLORS: Record<string, string> = {
  "To Do": "#4b5563",
  "In Progress": "#4f8ef7",
  "Done": "#10b981",
  "In Review": "#8b5cf6",
  "Blocked": "#ef4444",
};

const CHART_COLORS = ["#4f8ef7", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444"];

function getBadgeClass(status: string): string {
  if (status === "In Progress") return "badge badge-inprogress";
  if (status === "Done") return "badge badge-done";
  if (status === "Blocked") return "badge badge-blocked";
  if (status === "In Review") return "badge badge-review";
  return "badge badge-todo";
}

function getProgressClass(pct: number): string {
  if (pct > 100) return "over";
  if (pct > 80) return "warn";
  return "good";
}

export default function Dashboard() {
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [timeRange, setTimeRange] = useState<"month" | "prevMonth" | "all">("month");
  
  const [transitioning, setTransitioning] = useState(false);
  const [transitionStatus, setTransitionStatus] = useState("");
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [closableTargets, setClosableTargets] = useState<JiraIssue[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());

  const isConfigured = !!localStorage.getItem("jira_pat") || !!localStorage.getItem("jira_basic");

  const autoCloseLoggedTasks = () => {
    // Tìm các task có:
    // 1. logged >= estimate (originalEstimateSeconds > 0)
    // 2. remaining === 0
    // 3. Status KHÔNG phải là Closed, Resolved, Cancelled, Done, v.v.
    const targets = issues.filter((i) => {
      const statusName = i.fields.status?.name?.toLowerCase() || "";
      const est = i.fields.timetracking?.originalEstimateSeconds || 0;
      const logged = i.fields.timetracking?.timeSpentSeconds || 0;
      const remain = i.fields.timetracking?.remainingEstimateSeconds || 0;

      // Tránh các task đã hoàn thành/hủy bỏ
      const isCompleted =
        statusName.includes("close") ||
        statusName.includes("resolve") ||
        statusName.includes("cancel") ||
        statusName.includes("done") ||
        statusName.includes("hủy") ||
        statusName.includes("đóng") ||
        statusName.includes("hoàn thành") ||
        statusName.includes("đã giải quyết");

      return est > 0 && logged >= est && remain === 0 && !isCompleted;
    });

    if (targets.length === 0) {
      alert("🎉 Không tìm thấy task nào đã log đủ thời gian cần chuyển trạng thái!");
      return;
    }

    setClosableTargets(targets);
    setSelectedTargets(new Set(targets.map(t => t.key)));
    setShowCloseModal(true);
  };

  const executeAutoClose = async () => {
    if (selectedTargets.size === 0) return;
    setShowCloseModal(false);
    
    setTransitioning(true);
    let successCount = 0;
    
    const targetsToClose = closableTargets.filter(t => selectedTargets.has(t.key));

    for (const task of targetsToClose) {
      const key = task.key;
      setTransitionStatus(`Đang xử lý ${key}: ${task.fields.summary.slice(0, 30)}...`);
      try {
        let transitions = await getTransitions(key);

        const inprogressKeywords = ["in progress", "đang thực hiện", "đang làm", "to do", "cần làm"];
        const resolvedKeywords = ["resolved", "done", "đã giải quyết", "hoàn thành", "ready for test", "resolved / done"];
        const closedKeywords = ["closed", "đóng"];

        // 1. Chuyển sang In Progress (nếu có)
        const toInProgress = transitions.find(t => 
          inprogressKeywords.includes(t.to.name.toLowerCase()) || 
          inprogressKeywords.some(kw => t.name.toLowerCase().includes(kw))
        );
        if (toInProgress) {
          await transitionIssue(key, toInProgress.id);
          transitions = await getTransitions(key);
        }

        // 2. Chuyển sang Resolved/Hoàn thành
        const toResolved = transitions.find(t => 
          resolvedKeywords.includes(t.to.name.toLowerCase()) || 
          resolvedKeywords.some(kw => t.name.toLowerCase().includes(kw))
        );
        if (toResolved) {
          await transitionIssue(key, toResolved.id);
          transitions = await getTransitions(key);
        }

        // 3. Chuyển sang Closed/Đóng
        const toClosed = transitions.find(t => 
          closedKeywords.includes(t.to.name.toLowerCase()) || 
          closedKeywords.some(kw => t.name.toLowerCase().includes(kw))
        );
        if (toClosed) {
          await transitionIssue(key, toClosed.id);
        }

        successCount++;
      } catch (err) {
        console.error(`Lỗi chuyển đổi trạng thái ${key}:`, err);
      }
    }

    setTransitioning(false);
    setTransitionStatus("");
    alert(`✅ Hoàn thành! Đã chuyển trạng thái thành công cho ${successCount}/${targetsToClose.length} task.`);
    fetchData(); // Refresh dashboard
  };

  const fetchData = useCallback(async () => {
    if (!isConfigured) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const projectKeys = JIRA_PROJECTS.map((p) => p.key);
      const result = await getMyIssues({ projectKeys, maxResults: 200 });
      setIssues(result.issues);
      setLastRefresh(new Date());
    } catch (err: unknown) {
      const e = err as { response?: { data?: { errorMessages?: string[] } }; message?: string };
      setError(e.response?.data?.errorMessages?.[0] || e.message || "Không thể tải dữ liệu");
    } finally {
      setLoading(false);
    }
  }, [isConfigured]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfPrevMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

  // Lọc Issues theo phạm vi thời gian
  const filteredIssues = issues.filter((i) => {
    // LOẠI BỎ CÁC TASK ĐÃ BỊ HỦY/CANCEL KHỎI DASHBOARD!
    const statusName = i.fields.status?.name?.toLowerCase() || "";
    if (
      statusName.includes("cancel") ||
      statusName.includes("hủy") ||
      statusName.includes("không thực hiện") ||
      statusName.includes("reject")
    ) {
      return false;
    }

    if (timeRange === "all") return true;
    
    let rangeStart = startOfMonth;
    let rangeEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    if (timeRange === "prevMonth") {
      rangeStart = startOfPrevMonth;
      rangeEnd = endOfPrevMonth;
    }

    // Giữ lại issue nếu nó được cập nhật trong khoảng thời gian này
    const updatedDate = new Date(i.fields.updated);
    if (updatedDate >= rangeStart && updatedDate <= rangeEnd) return true;

    // Hoặc nếu nó có chứa worklog được log trong khoảng thời gian này
    const hasWorklogThisPeriod = i.fields.worklog?.worklogs?.some(
      (wl) => {
        const d = new Date(wl.started);
        return d >= rangeStart && d <= rangeEnd;
      }
    );
    return !!hasWorklogThisPeriod;
  });

  // ── Aggregated stats ──
  const totalEstimated = filteredIssues.reduce((s, i) => s + (i.fields.timetracking?.originalEstimateSeconds || 0), 0);
  
  // Tính tổng thời gian đã log: chỉ tính những ticket đã được closed
  const totalLogged = filteredIssues.reduce((sum, issue) => {
    const statusName = issue.fields.status?.name?.toLowerCase() || "";
    if (!statusName.includes("close") && !statusName.includes("đóng")) {
      return sum;
    }

    if (timeRange === "all") {
      return sum + (issue.fields.timetracking?.timeSpentSeconds || 0);
    } else {
      let rangeStart = startOfMonth;
      let rangeEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      if (timeRange === "prevMonth") {
        rangeStart = startOfPrevMonth;
        rangeEnd = endOfPrevMonth;
      }

      const periodLogs = issue.fields.worklog?.worklogs?.reduce((s, wl) => {
        const wlDate = new Date(wl.started);
        return (wlDate >= rangeStart && wlDate <= rangeEnd) ? s + wl.timeSpentSeconds : s;
      }, 0) || 0;
      return sum + periodLogs;
    }
  }, 0);

  const totalRemaining = filteredIssues.reduce((s, i) => s + (i.fields.timetracking?.remainingEstimateSeconds || 0), 0);
  const logPct = totalEstimated > 0 ? Math.round((totalLogged / totalEstimated) * 100) : 0;

  // ── Status distribution ──
  const statusCounts: Record<string, number> = {};
  filteredIssues.forEach((i) => {
    const s = i.fields.status.name;
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  });
  const pieData = Object.entries(statusCounts).map(([name, value]) => ({ name, value }));

  // ── Per-project bar chart ──
  const projectStats: ProjectStat[] = JIRA_PROJECTS.map((p) => {
    const projIssues = filteredIssues.filter((i) => i.fields.project.key === p.key);
    
    const loggedSeconds = projIssues.reduce((sum, issue) => {
      if (timeRange === "all") {
        return sum + (issue.fields.timetracking?.timeSpentSeconds || 0);
      } else {
        let rangeStart = startOfMonth;
        let rangeEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
        if (timeRange === "prevMonth") {
          rangeStart = startOfPrevMonth;
          rangeEnd = endOfPrevMonth;
        }

        const periodLogs = issue.fields.worklog?.worklogs?.reduce((s, wl) => {
          const wlDate = new Date(wl.started);
          return (wlDate >= rangeStart && wlDate <= rangeEnd) ? s + wl.timeSpentSeconds : s;
        }, 0) || 0;
        return sum + periodLogs;
      }
    }, 0);

    return {
      projectKey: p.key,
      projectName: p.name,
      totalIssues: projIssues.length,
      estimatedSeconds: projIssues.reduce((s, i) => s + (i.fields.timetracking?.originalEstimateSeconds || 0), 0),
      loggedSeconds,
      remainingSeconds: projIssues.reduce((s, i) => s + (i.fields.timetracking?.remainingEstimateSeconds || 0), 0),
    };
  });

  const barChartData = projectStats.map((p) => ({
    name: p.projectName,
    "Estimate (h)": Math.round(p.estimatedSeconds / 3600),
    "Logged (h)":   Math.round(p.loggedSeconds / 3600),
    "Remaining (h)":Math.round(p.remainingSeconds / 3600),
  }));

  // ── Weekly statistics logic ──
  const getStartOfWeek = (d: Date) => {
    const date = new Date(d);
    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(date.setDate(diff));
    monday.setHours(0, 0, 0, 0);
    return monday;
  };

  const currentMonday = getStartOfWeek(new Date());
  
  const lastMonday = new Date(currentMonday);
  lastMonday.setDate(lastMonday.getDate() - 7);

  const nextMonday = new Date(currentMonday);
  nextMonday.setDate(nextMonday.getDate() + 7);

  const dayNames = ["Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7", "Chủ Nhật"];
  const dailyLoggedSeconds = Array(7).fill(0);
  let thisWeekTotalSeconds = 0;
  let lastWeekTotalSeconds = 0;

  issues.forEach((issue) => {
    issue.fields.worklog?.worklogs?.forEach((wl) => {
      const wlDate = new Date(wl.started);
      const wlTime = wlDate.getTime();

      // Check last week
      if (wlTime >= lastMonday.getTime() && wlTime < currentMonday.getTime()) {
        lastWeekTotalSeconds += wl.timeSpentSeconds;
      }

      // Check current week
      if (wlTime >= currentMonday.getTime() && wlTime < nextMonday.getTime()) {
        thisWeekTotalSeconds += wl.timeSpentSeconds;

        const dayOfWeek = wlDate.getDay();
        const dayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        if (dayIndex >= 0 && dayIndex < 7) {
          dailyLoggedSeconds[dayIndex] += wl.timeSpentSeconds;
        }
      }
    });
  });

  const weeklyChartData = dayNames.map((name, idx) => ({
    name,
    "Giờ đã log (h)": parseFloat((dailyLoggedSeconds[idx] / 3600).toFixed(2)),
  }));

  // ── Estimate vs Logged deviation ──
  const issuesWithDeviation = filteredIssues
    .map((issue) => {
      const est = issue.fields.timetracking?.originalEstimateSeconds || 0;
      const log = issue.fields.timetracking?.timeSpentSeconds || 0;
      const rem = issue.fields.timetracking?.remainingEstimateSeconds || 0;
      if (est <= 0) return null;
      const diff = log - est;
      return { issue, est, log, rem, diff };
    })
    .filter(Boolean)
    .sort((a, b) => Math.abs(b!.diff) - Math.abs(a!.diff));

  const overBudget = issuesWithDeviation.filter(i => i!.diff > 0);
  const underBudget = issuesWithDeviation.filter(i => i!.diff < 0);
  const totalOverSeconds = overBudget.reduce((s, i) => s + i!.diff, 0);
  const totalUnderSeconds = underBudget.reduce((s, i) => s + Math.abs(i!.diff), 0);

  // ── Recent issues ──
  const recentIssues = [...filteredIssues]
    .sort((a, b) => new Date(b.fields.updated).getTime() - new Date(a.fields.updated).getTime())
    .slice(0, 8);

  if (!isConfigured) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div className="page-header">
          <div className="page-title-group">
            <h1 className="page-title">Dashboard</h1>
            <p className="page-subtitle">Tổng quan thời gian làm việc</p>
          </div>
        </div>
        <div className="page-body" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="empty-state">
            <div className="empty-state-icon">🔌</div>
            <div className="empty-state-title">Chưa kết nối Jira</div>
            <p className="empty-state-text">
              Vào <strong>Cài đặt</strong> để nhập Jira Personal Access Token và kết nối với server Jira của bạn.
            </p>
            <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => {}}>
              ⚙️ Vào Cài đặt
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div className="page-header" style={{ flexWrap: "wrap", gap: 12 }}>
        <div className="page-title-group">
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">
            {lastRefresh
              ? `Cập nhật lúc ${lastRefresh.toLocaleTimeString("vi-VN")} — ${filteredIssues.length} issues`
              : "Đang tải dữ liệu..."}
          </p>
        </div>

        {/* Bộ lọc thời gian */}
        <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
          <button
            className={`btn btn-sm ${timeRange === "month" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setTimeRange("month")}
            style={{ fontSize: 12, padding: "6px 12px", borderRadius: 8 }}
          >
            📅 Tháng này ({now.getMonth() + 1}/{now.getFullYear()})
          </button>
          <button
            className={`btn btn-sm ${timeRange === "prevMonth" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setTimeRange("prevMonth")}
            style={{ fontSize: 12, padding: "6px 12px", borderRadius: 8 }}
          >
            ⏪ Tháng trước ({startOfPrevMonth.getMonth() + 1}/{startOfPrevMonth.getFullYear()})
          </button>
          <button
            className={`btn btn-sm ${timeRange === "all" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setTimeRange("all")}
            style={{ fontSize: 12, padding: "6px 12px", borderRadius: 8 }}
          >
            🌐 Tất cả thời gian
          </button>
        </div>

        <div className="page-actions" style={{ marginLeft: 0, display: "flex", gap: 8 }}>
          <button
            className="btn btn-sm"
            onClick={autoCloseLoggedTasks}
            disabled={loading || transitioning}
            style={{ 
              background: "linear-gradient(135deg, #8b5cf6, #4f8ef7)", 
              color: "white", 
              border: "none",
              fontWeight: 500,
              padding: "6px 14px",
              borderRadius: 8,
              cursor: "pointer",
              boxShadow: "0 4px 12px rgba(139, 92, 246, 0.25)"
            }}
          >
            ⚡ Auto Close Task Đủ Giờ
          </button>
          <button
            id="btn-refresh-dashboard"
            className="btn btn-secondary btn-sm"
            onClick={fetchData}
            disabled={loading || transitioning}
          >
            <span className={loading ? "spinning" : ""}>🔄</span>
            {loading ? "Đang tải..." : "Refresh"}
          </button>
        </div>
      </div>

      <div className="page-body">
        {transitioning && (
          <div className="toast" style={{ 
            marginBottom: 16, 
            background: "rgba(139, 92, 246, 0.1)", 
            border: "1px solid rgba(139, 92, 246, 0.2)",
            color: "var(--text-primary)",
            padding: "16px 20px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            borderRadius: 16
          }}>
            <div className="spinning" style={{ fontSize: 20 }}>⚙️</div>
            <div style={{ flex: 1 }}>
              <strong style={{ display: "block", fontSize: 14 }}>Đang tự động chuyển trạng thái tuần tự...</strong>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{transitionStatus}</span>
            </div>
          </div>
        )}

        {error && (
          <div className="toast" style={{ marginBottom: 16, borderLeft: "3px solid var(--accent-red)" }}>
            <span>❌</span> {error}
            <button className="btn btn-ghost btn-sm" onClick={fetchData} style={{ marginLeft: "auto" }}>Thử lại</button>
          </div>
        )}

        {showCloseModal && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
            <div style={{ background: "var(--bg-secondary)", borderRadius: 16, width: 640, maxWidth: "90vw", maxHeight: "80vh", display: "flex", flexDirection: "column", border: "1px solid var(--border)", boxShadow: "var(--shadow-lg)" }}>
              <div style={{ padding: 20, borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 18, color: "var(--text-primary)" }}>Chọn Task để đóng</h3>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>Những task này đã log đủ/vượt thời gian và cần được đóng.</div>
                </div>
                <button onClick={() => setShowCloseModal(false)} className="btn btn-ghost btn-sm">❌</button>
              </div>
              <div style={{ padding: 20, overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
                {closableTargets.map(t => (
                  <label key={t.key} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)", borderRadius: 10, cursor: "pointer" }}>
                    <input 
                      type="checkbox" 
                      style={{ width: 18, height: 18, cursor: "pointer" }}
                      checked={selectedTargets.has(t.key)}
                      onChange={(e) => {
                        const newSet = new Set(selectedTargets);
                        if (e.target.checked) newSet.add(t.key);
                        else newSet.delete(t.key);
                        setSelectedTargets(newSet);
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                        <span style={{ color: "var(--accent-blue-light)", fontWeight: 600, fontSize: 13 }}>{t.key}</span>
                        <span className={getBadgeClass(t.fields.status.name)} style={{ fontSize: 10, padding: "2px 6px" }}>{t.fields.status.name}</span>
                      </div>
                      <div style={{ color: "var(--text-primary)", fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {t.fields.summary}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
              <div style={{ padding: 20, borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", color: "var(--text-secondary)" }}>
                  <input 
                    type="checkbox" 
                    checked={selectedTargets.size === closableTargets.length}
                    onChange={(e) => {
                      if (e.target.checked) setSelectedTargets(new Set(closableTargets.map(t => t.key)));
                      else setSelectedTargets(new Set());
                    }}
                  />
                  Chọn tất cả
                </label>
                <div style={{ display: "flex", gap: 12 }}>
                  <button onClick={() => setShowCloseModal(false)} className="btn btn-secondary">Hủy</button>
                  <button onClick={executeAutoClose} className="btn btn-primary" disabled={selectedTargets.size === 0}>
                    Xác nhận đóng ({selectedTargets.size}) task
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="stats-grid">
              {[1,2,3,4].map(i => (
                <div key={i} className="stat-card" style={{ height: 110 }}>
                  <div className="skeleton" style={{ height: 24, width: "60%", marginBottom: 12 }} />
                  <div className="skeleton" style={{ height: 36, width: "40%" }} />
                </div>
              ))}
            </div>
            <div className="skeleton" style={{ height: 280, borderRadius: 16 }} />
          </div>
        ) : (
          <>
            {/* Stat Cards */}
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-icon">📋</div>
                <div className="stat-value">{issues.length}</div>
                <div className="stat-label">Tổng Issues</div>
                <div className="stat-change neutral">
                  {statusCounts["In Progress"] || 0} đang thực hiện
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-icon">🎯</div>
                <div className="stat-value">{formatSeconds(totalEstimated)}</div>
                <div className="stat-label">Tổng Estimate</div>
                <div className="stat-change neutral">Trên {issues.length} issues</div>
              </div>
              <div className="stat-card">
                <div className="stat-icon">⏱️</div>
                <div className="stat-value">{formatSeconds(totalLogged)}</div>
                <div className="stat-label">Đã Log (Closed)</div>
                <div className={`stat-change ${logPct > 100 ? "negative" : logPct > 80 ? "neutral" : "positive"}`}>
                  {logPct}% so với estimate
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-icon">⏳</div>
                <div className="stat-value">{formatSeconds(totalRemaining)}</div>
                <div className="stat-label">Còn lại</div>
                <div className="stat-change neutral">
                  {statusCounts["Done"] || 0} issues đã xong
                </div>
              </div>
            </div>

            {/* Overall progress */}
            <div className="chart-card" style={{ marginBottom: 16 }}>
              <div className="chart-title">Tiến độ Log Work tổng thể</div>
              <div className="chart-subtitle">Estimate vs. Logged ({logPct}% hoàn thành)</div>
              <div className="progress-bar-wrap" style={{ height: 10, marginBottom: 8 }}>
                <div
                  className={`progress-bar-fill ${getProgressClass(logPct)}`}
                  style={{ width: `${Math.min(logPct, 100)}%` }}
                />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text-secondary)" }}>
                <span>🟦 Logged: {formatSeconds(totalLogged)}</span>
                <span>⬜ Estimate: {formatSeconds(totalEstimated)}</span>
              </div>
            </div>

            {/* Weekly Statistics Section */}
            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 16, marginBottom: 16 }}>
              {/* Weekly bar chart */}
              <div className="chart-card">
                <div className="chart-title">Nỗ lực log work trong tuần này</div>
                <div className="chart-subtitle">Thời gian đã log theo từng ngày (giờ)</div>
                <div style={{ marginTop: 12 }}>
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={weeklyChartData} margin={{ top: 8, right: 0, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis dataKey="name" tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} />
                      <Tooltip
                        contentStyle={{ background: "#0f1527", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, fontSize: 12 }}
                        itemStyle={{ color: "#f1f5f9" }}
                        labelStyle={{ color: "#f1f5f9", fontWeight: 600 }}
                      />
                      <Bar dataKey="Giờ đã log (h)" fill="#10b981" radius={[4,4,0,0]} barSize={24} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Weekly comparison card */}
              <div className="chart-card" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                <div>
                  <div className="chart-title">So sánh hiệu suất tuần</div>
                  <div className="chart-subtitle">So sánh nỗ lực tuần này với tuần trước</div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, margin: "16px 0" }}>
                  <div style={{ background: "rgba(16, 185, 129, 0.05)", border: "1px solid rgba(16, 185, 129, 0.15)", borderRadius: 12, padding: "14px 16px" }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Tuần này</div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: "var(--accent-green)" }}>
                      {parseFloat((thisWeekTotalSeconds / 3600).toFixed(1))}h
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
                      Thứ 2 - Chủ Nhật
                    </div>
                  </div>

                  <div style={{ background: "rgba(255, 255, 255, 0.02)", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 16px" }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Tuần trước</div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: "var(--text-secondary)" }}>
                      {parseFloat((lastWeekTotalSeconds / 3600).toFixed(1))}h
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
                      Hiệu suất trước đó
                    </div>
                  </div>
                </div>

                {/* Progress message / Micro action */}
                <div style={{ 
                  background: "var(--bg-card)", 
                  border: "1px solid var(--border)", 
                  borderRadius: 12, 
                  padding: "12px 14px", 
                  fontSize: 12, 
                  color: "var(--text-secondary)",
                  display: "flex",
                  alignItems: "center",
                  gap: 10
                }}>
                  <div style={{ fontSize: 20 }}>
                    {thisWeekTotalSeconds >= 144000 ? "🏆" : thisWeekTotalSeconds >= 72000 ? "💪" : "⏰"}
                  </div>
                  <div>
                    {thisWeekTotalSeconds >= 144000 ? (
                      <div><strong>Xuất sắc!</strong> Bạn đã hoàn thành xuất sắc mục tiêu log work tuần này (&gt;40h).</div>
                    ) : thisWeekTotalSeconds >= 72000 ? (
                      <div><strong>Cố lên!</strong> Bạn đã log được hơn nửa tuần làm việc (&gt;20h).</div>
                    ) : (
                      <div><strong>Nhắc nhở:</strong> Hãy nhớ log đầy đủ giờ làm việc của tuần này nhé.</div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Charts grid */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16, marginBottom: 16 }}>
              {/* Bar chart by project */}
              <div className="chart-card">
                <div className="chart-title">Giờ theo Project</div>
                <div className="chart-subtitle">Estimate · Logged · Remaining (giờ)</div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={barChartData} margin={{ top: 8, right: 0, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="name" tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip
                      contentStyle={{ background: "#0f1527", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, fontSize: 12 }}
                      itemStyle={{ color: "#f1f5f9" }}
                      labelStyle={{ color: "#f1f5f9", fontWeight: 600 }}
                    />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: 11, color: "#94a3b8" }} />
                    <Bar dataKey="Estimate (h)" fill="#4f8ef7" radius={[4,4,0,0]} />
                    <Bar dataKey="Logged (h)"   fill="#10b981" radius={[4,4,0,0]} />
                    <Bar dataKey="Remaining (h)" fill="#f59e0b" radius={[4,4,0,0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Pie chart by status */}
              <div className="chart-card">
                <div className="chart-title">Trạng thái Issues</div>
                <div className="chart-subtitle">Phân bổ theo status</div>
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={80}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {pieData.map((entry, index) => (
                        <Cell
                          key={entry.name}
                          fill={STATUS_COLORS[entry.name] || CHART_COLORS[index % CHART_COLORS.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ background: "#0f1527", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, fontSize: 12 }}
                      itemStyle={{ color: "#f1f5f9" }}
                      labelStyle={{ color: "#f1f5f9", fontWeight: 600 }}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {pieData.map((entry, i) => (
                    <div key={entry.name} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: STATUS_COLORS[entry.name] || CHART_COLORS[i % CHART_COLORS.length], flexShrink: 0 }} />
                      <span style={{ color: "var(--text-secondary)", flex: 1 }}>{entry.name}</span>
                      <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>{entry.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Estimate vs Logged Deviation */}
            <div className="chart-card">
              <div className="chart-title">Độ lệch Estimate vs Logged</div>
              <div className="chart-subtitle">
                {timeRange === "all" ? "Tất cả thời gian" : timeRange === "prevMonth" ? "Tháng trước" : "Tháng này"}
              </div>

              {/* Summary bars */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                <div style={{ background: "rgba(239, 68, 68, 0.08)", border: "1px solid rgba(239, 68, 68, 0.2)", borderRadius: 12, padding: "12px 14px" }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>Quá estimate (total)</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "var(--accent-red)" }}>
                    +{formatSeconds(totalOverSeconds)}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>{overBudget.length} ticket</div>
                </div>
                <div style={{ background: "rgba(79, 142, 247, 0.08)", border: "1px solid rgba(79, 142, 247, 0.2)", borderRadius: 12, padding: "12px 14px" }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>Log thiếu (total)</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "var(--accent-blue-light)" }}>
                    -{formatSeconds(totalUnderSeconds)}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>{underBudget.length} ticket</div>
                </div>
              </div>

              {/* Deviation table */}
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left" }}>
                      <th style={{ padding: "6px 8px", color: "var(--text-muted)", fontWeight: 500 }}>Key</th>
                      <th style={{ padding: "6px 8px", color: "var(--text-muted)", fontWeight: 500 }}>Estimate</th>
                      <th style={{ padding: "6px 8px", color: "var(--text-muted)", fontWeight: 500 }}>Logged</th>
                      <th style={{ padding: "6px 8px", color: "var(--text-muted)", fontWeight: 500 }}>Diff</th>
                      <th style={{ padding: "6px 8px", color: "var(--text-muted)", fontWeight: 500 }}>%</th>
                      <th style={{ padding: "6px 8px", color: "var(--text-muted)", fontWeight: 500 }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {issuesWithDeviation.slice(0, 10).map((item) => {
                      if (!item) return null;
                      const { issue, est, log, rem, diff } = item;
                      const pct = est > 0 ? Math.round((log / est) * 100) : 0;
                      const diffH = diff / 3600;
                      return (
                        <tr key={issue.key} style={{ borderBottom: "1px solid var(--border)" }}>
                          <td style={{ padding: "8px" }}>
                            <a
                              href={`https://20.84.97.109:3033/browse/${issue.key}`}
                              target="_blank"
                              rel="noreferrer"
                              style={{ color: "var(--accent-blue-light)", fontWeight: 600, textDecoration: "none", fontSize: 12 }}
                            >
                              {issue.key}
                            </a>
                          </td>
                          <td style={{ padding: "8px", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{formatSeconds(est)}</td>
                          <td style={{ padding: "8px", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{formatSeconds(log)}</td>
                          <td style={{ padding: "8px", fontWeight: 600, whiteSpace: "nowrap" }}>
                            <span style={{ 
                              color: diff > 0 ? "var(--accent-red)" : diff < 0 ? "#f59e0b" : "var(--text-secondary)" 
                            }}>
                              {diff > 0 ? "+" : ""}{diffH.toFixed(1)}h
                            </span>
                          </td>
                          <td style={{ padding: "8px", textAlign: "center" }}>
                            <span style={{ 
                              color: pct > 100 ? "var(--accent-red)" : pct > 80 ? "#f59e0b" : "var(--accent-green)",
                              fontWeight: 600,
                              fontSize: 12
                            }}>
                              {pct}%
                            </span>
                          </td>
                          <td style={{ padding: "8px" }}>
                            <span className={getBadgeClass(issue.fields.status.name)}>
                              {issue.fields.status.name}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                    {issuesWithDeviation.filter(Boolean).length === 0 && (
                      <tr>
                        <td colSpan={6} style={{ padding: 24, textAlign: "center", color: "var(--text-muted)" }}>
                          Không có ticket nào cần estimate
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Recent Issues */}
            <div className="chart-card">
              <div className="chart-title" style={{ marginBottom: 4 }}>Issues gần đây</div>
              <div className="chart-subtitle">8 issues được cập nhật mới nhất</div>
              <div className="table-wrap" style={{ marginTop: 12 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Key</th>
                      <th>Tóm tắt</th>
                      <th>Project</th>
                      <th>Trạng thái</th>
                      <th>Estimate</th>
                      <th>Logged</th>
                      <th>%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentIssues.map((issue) => {
                      const est = issue.fields.timetracking?.originalEstimateSeconds || 0;
                      const log = issue.fields.timetracking?.timeSpentSeconds || 0;
                      const pct = est > 0 ? Math.round((log / est) * 100) : (log > 0 ? 100 : 0);
                      return (
                        <tr key={issue.id}>
                          <td>
                            <a
                              href={`https://20.84.97.109:3033/browse/${issue.key}`}
                              target="_blank"
                              rel="noreferrer"
                              style={{ color: "var(--accent-blue-light)", fontWeight: 600, textDecoration: "none", fontSize: 12 }}
                            >
                              {issue.key}
                            </a>
                          </td>
                          <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-secondary)" }}>
                            {issue.fields.summary}
                          </td>
                          <td style={{ fontSize: 11, color: "var(--text-muted)" }}>{issue.fields.project.key}</td>
                          <td>
                            <span className={getBadgeClass(issue.fields.status.name)}>
                              {issue.fields.status.name}
                            </span>
                          </td>
                          <td style={{ color: "var(--text-secondary)", fontSize: 12 }}>{est ? formatSeconds(est) : "—"}</td>
                          <td style={{ color: "var(--accent-green)", fontSize: 12, fontWeight: 600 }}>{log ? formatSeconds(log) : "—"}</td>
                          <td style={{ width: 80 }}>
                            {est > 0 ? (
                              <>
                                <div style={{ fontSize: 11, color: pct > 100 ? "var(--accent-red)" : "var(--text-secondary)", marginBottom: 2 }}>{pct}%</div>
                                <div className="progress-bar-wrap">
                                  <div className={`progress-bar-fill ${getProgressClass(pct)}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                                </div>
                              </>
                            ) : <span style={{ color: "var(--text-muted)", fontSize: 11 }}>—</span>}
                          </td>
                        </tr>
                      );
                    })}
                    {recentIssues.length === 0 && (
                      <tr>
                        <td colSpan={7}>
                          <div className="empty-state" style={{ padding: 24 }}>
                            <div>Không có issues nào được gán cho bạn</div>
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
    </div>
  );
}
