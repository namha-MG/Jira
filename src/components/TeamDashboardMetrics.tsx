import React from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";
import { JiraIssue, formatSeconds } from "../jiraService";

interface TeamDashboardMetricsProps {
  issues: JiraIssue[];
  member?: { displayName: string; username: string };
  useDateFilter?: boolean;
  dateFrom?: string;
  dateTo?: string;
}

const STATUS_COLORS: Record<string, string> = {
  "To Do": "#4b5563",
  "In Progress": "#4f8ef7",
  "Done": "#10b981",
  "In Review": "#8b5cf6",
  "Blocked": "#ef4444",
};

const CHART_COLORS = ["#4f8ef7", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444"];

function getProgressClass(pct: number): string {
  if (pct > 100) return "over";
  if (pct > 80) return "warn";
  return "good";
}

export default function TeamDashboardMetrics({ issues, member, useDateFilter, dateFrom, dateTo }: TeamDashboardMetricsProps) {
  const totalEstimated = issues.reduce((s, i) => s + (i.fields.timetracking?.originalEstimateSeconds || 0), 0);
  
  const totalLogged = issues.reduce((sum, issue) => {
    const statusName = issue.fields.status?.name?.toLowerCase() || "";
    if (!statusName.includes("close") && !statusName.includes("đóng") && !statusName.includes("done")) {
      return sum;
    }
    
    if (useDateFilter && dateFrom && dateTo) {
      const rangeStart = new Date(dateFrom);
      rangeStart.setHours(0, 0, 0, 0);
      const rangeEnd = new Date(dateTo);
      rangeEnd.setHours(23, 59, 59, 999);
      
      const taskDateStr = issue.fields.customfield_10300 || issue.fields.duedate || issue.fields.customfield_10302;
      const periodLogs = issue.fields.worklog?.worklogs?.reduce((s, wl) => {
        const wlDate = taskDateStr ? new Date(taskDateStr) : new Date(wl.started);
        return (wlDate >= rangeStart && wlDate <= rangeEnd) ? s + wl.timeSpentSeconds : s;
      }, 0) || 0;
      return sum + periodLogs;
    } else {
      return sum + (issue.fields.timetracking?.timeSpentSeconds || 0);
    }
  }, 0);

  const totalRemaining = issues.reduce((s, i) => s + (i.fields.timetracking?.remainingEstimateSeconds || 0), 0);
  const logPct = totalEstimated > 0 ? Math.round((totalLogged / totalEstimated) * 100) : 0;

  // ── Status & Type distribution ──
  const statusCounts: Record<string, number> = {};
  let uatBugCount = 0;
  let prodBugCount = 0;
  let subTaskCount = 0;

  issues.forEach((i) => {
    const s = i.fields.status.name;
    statusCounts[s] = (statusCounts[s] || 0) + 1;

    const typeName = i.fields.issuetype?.name?.toLowerCase() || "";
    if (typeName.includes("uat bug")) {
      uatBugCount++;
    } else if (typeName.includes("production bug") || typeName === "bug") {
      prodBugCount++;
    } else if (typeName.includes("sub-task") || typeName.includes("subtask")) {
      subTaskCount++;
    }
  });
  const pieData = Object.entries(statusCounts).map(([name, value]) => ({ name, value }));

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
    const taskDateStr = issue.fields.customfield_10300 || issue.fields.duedate || issue.fields.customfield_10302;
    issue.fields.worklog?.worklogs?.forEach((wl) => {
      const wlDate = taskDateStr ? new Date(taskDateStr) : new Date(wl.started);
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
    "Giờ đã log (h)": parseFloat((dailyLoggedSeconds[idx] / 3600).toFixed(1)),
  }));

  // ── Project-level statistics ──
  const projectStatsMap: Record<string, { estimate: number; logged: number; remaining: number }> = {};
  issues.forEach((i) => {
    const pName = i.fields.project?.name || i.fields.project?.key || "Khác";
    if (!projectStatsMap[pName]) {
      projectStatsMap[pName] = { estimate: 0, logged: 0, remaining: 0 };
    }
    projectStatsMap[pName].estimate += i.fields.timetracking?.originalEstimateSeconds || 0;
    
    let logged = 0;
    if (useDateFilter && dateFrom && dateTo) {
      const rangeStart = new Date(dateFrom);
      rangeStart.setHours(0, 0, 0, 0);
      const rangeEnd = new Date(dateTo);
      rangeEnd.setHours(23, 59, 59, 999);
      const taskDateStr = i.fields.customfield_10300 || i.fields.duedate || i.fields.customfield_10302;
      logged = i.fields.worklog?.worklogs?.reduce((s, wl) => {
        const wlDate = taskDateStr ? new Date(taskDateStr) : new Date(wl.started);
        return (wlDate >= rangeStart && wlDate <= rangeEnd) ? s + wl.timeSpentSeconds : s;
      }, 0) || 0;
    } else {
      logged = i.fields.timetracking?.timeSpentSeconds || 0;
    }
    projectStatsMap[pName].logged += logged;
    
    projectStatsMap[pName].remaining += i.fields.timetracking?.remainingEstimateSeconds || 0;
  });
  
  const projectChartData = Object.entries(projectStatsMap).map(([name, stats]) => ({
    name,
    "Estimate": Number((stats.estimate / 3600).toFixed(1)),
    "Đã log": Number((stats.logged / 3600).toFixed(1)),
    "Còn lại": Number((stats.remaining / 3600).toFixed(1)),
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Stat Cards */}
      <div className="stats-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        <div className="stat-card">
          <div className="stat-icon">📋</div>
          <div className="stat-value">{issues.length}</div>
          <div className="stat-label">Tổng Issues</div>
          <div className="stat-change neutral">
            {statusCounts["In Progress"] || 0} đang thực hiện
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">🐞</div>
          <div className="stat-value" style={{ color: "var(--accent-orange)" }}>{uatBugCount}</div>
          <div className="stat-label">UAT Bug</div>
          <div className="stat-change neutral">Trong kỳ này</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">🚨</div>
          <div className="stat-value" style={{ color: "var(--accent-red)" }}>{prodBugCount}</div>
          <div className="stat-label">Production Bug</div>
          <div className="stat-change neutral">Trong kỳ này</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">✅</div>
          <div className="stat-value" style={{ color: "var(--accent-blue)" }}>{subTaskCount}</div>
          <div className="stat-label">Sub-task</div>
          <div className="stat-change neutral">Trong kỳ này</div>
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
            {statusCounts["Done"] || statusCounts["Closed"] || 0} issues đã xong
          </div>
        </div>
      </div>

      {/* Overall progress */}
      <div className="chart-card" style={{ marginBottom: 16 }}>
        <div className="chart-title">Tiến độ Log Work tổng thể ({member ? member.displayName : "Team"})</div>
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
          <div className="chart-title">Nỗ lực log work của {member ? member.displayName : "Team"} (Tuần này)</div>
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
            <div className="chart-title">So sánh hiệu suất tuần ({member ? member.displayName : "Team"})</div>
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
              {thisWeekTotalSeconds >= lastWeekTotalSeconds ? "📈" : "📉"}
            </div>
            <div>
              {thisWeekTotalSeconds >= lastWeekTotalSeconds ? (
                <div><strong>Tốt!</strong> {member ? member.displayName : "Team"} log work bằng hoặc cao hơn tuần trước.</div>
              ) : (
                <div><strong>Nhắc nhở:</strong> {member ? "Nhắc nhở " + member.displayName : "Nhắc nhở thành viên"} log work đầy đủ nhé.</div>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {/* Charts grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 16, marginBottom: 16 }}>
        {/* Pie chart by status */}
        <div className="chart-card">
          <div className="chart-title">Trạng thái Issues</div>
          <div className="chart-subtitle">Phân bổ theo status</div>
          <ResponsiveContainer width="100%" height={220}>
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
              />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 11, color: "#94a3b8" }} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Project time tracking chart */}
        <div className="chart-card">
          <div className="chart-title">Thời gian theo Dự án (giờ)</div>
          <div className="chart-subtitle">Estimate vs Logged vs Remaining</div>
          <div style={{ marginTop: 12 }}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={projectChartData} margin={{ top: 8, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="name" tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ background: "#0f1527", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, fontSize: 12 }}
                  itemStyle={{ color: "#f1f5f9" }}
                  labelStyle={{ color: "#f1f5f9", fontWeight: 600 }}
                  cursor={{ fill: "rgba(255,255,255,0.05)" }}
                />
                <Legend wrapperStyle={{ fontSize: 11, color: "#94a3b8", paddingTop: 10 }} />
                <Bar dataKey="Estimate" fill="#3b82f6" radius={[4,4,0,0]} barSize={16} />
                <Bar dataKey="Đã log" fill="#10b981" radius={[4,4,0,0]} barSize={16} />
                <Bar dataKey="Còn lại" fill="#f59e0b" radius={[4,4,0,0]} barSize={16} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
