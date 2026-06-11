import { useEffect, useState, useCallback } from "react";
import {
  getIssuesByProject, getAllIssuesByJql, getWorklogs, JiraIssue, JiraUser, JiraWorklog, formatSeconds, createSubTask, getIssue, addWorklog, getAssignableUsers, getTransitions, transitionIssue, getJiraFields, generateAiOutput
} from "../jiraService";
import { JIRA_PROJECTS } from "../config";

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

export default function Issues() {
  const [selectedProject, setSelectedProject] = useState(JIRA_PROJECTS[0].key);
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [selectedIssue, setSelectedIssue] = useState<JiraIssue | null>(null);
  const [worklogs, setWorklogs] = useState<JiraWorklog[]>([]);
  const [worklogLoading, setWorklogLoading] = useState(false);
  const [timeRange, setTimeRange] = useState<"month" | "all">("month");
  const [sortBy, setSortBy] = useState<"key" | "updated" | "logged" | "estimate" | "startDate">("updated");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [advancedFilter, setAdvancedFilter] = useState("all");
  const [loadScope, setLoadScope] = useState<"me" | "all">("me");

  // Sub-task states
  const [subTaskModalOpen, setSubTaskModalOpen] = useState<JiraIssue | null>(null);
  const [subTasks, setSubTasks] = useState([{ summary: "", estimate: "", assigneeName: "" }]);
  const [creatingSubTask, setCreatingSubTask] = useState(false);

  // Log work states
  const [logWorkModalOpen, setLogWorkModalOpen] = useState<{ key: string; summary: string } | null>(null);
  const [logWorkTime, setLogWorkTime] = useState("");
  const [logWorkComment, setLogWorkComment] = useState("");
  const [loggingWork, setLoggingWork] = useState(false);

  // Resolve bug states
  const [resolveModalOpen, setResolveModalOpen] = useState<JiraIssue | null>(null);
  const [resolveResolution, setResolveResolution] = useState("10000");
  const [resolveOutput, setResolveOutput] = useState("");
  const [resolveComment, setResolveComment] = useState("");
  const [resolvingIssue, setResolvingIssue] = useState(false);

  const [projectUsers, setProjectUsers] = useState<JiraUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  const isConfigured = !!localStorage.getItem("jira_pat") || !!localStorage.getItem("jira_basic");

  useEffect(() => {
    setStatusFilter("all");
    setAssigneeFilter("all");
    
    // Fetch all assignable users for the selected project
    if (isConfigured) {
      setLoadingUsers(true);
      getAssignableUsers(selectedProject)
        .then(users => setProjectUsers(users))
        .catch(e => console.warn("Lỗi khi tải danh sách user của dự án", e))
        .finally(() => setLoadingUsers(false));
    }
  }, [selectedProject, isConfigured]);

  // Pagination states
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const fetchIssues = useCallback(async () => {
    if (!isConfigured) return;
    setLoading(true);
    setError(null);
    try {
      let jql = `project = "${selectedProject}"`;
      if (loadScope === "me") {
        jql += ` AND assignee = currentUser()`;
      }
      if (timeRange === "month") {
        jql += ` AND (updated >= startOfMonth() OR worklogDate >= startOfMonth())`;
      }
      jql += ` ORDER BY updated DESC`;

      let result = await getAllIssuesByJql(jql);

      if (loadScope === "me") {
        const parentKeys = new Set<string>();
        result.forEach(issue => {
          if (issue.fields.parent && issue.fields.parent.key) {
            parentKeys.add(issue.fields.parent.key);
          }
        });
        
        const existingKeys = new Set(result.map(i => i.key));
        const missingParentKeys = Array.from(parentKeys).filter(key => !existingKeys.has(key));
        
        if (missingParentKeys.length > 0) {
          // Split into chunks of 100 if needed, but usually it's small. Jira JQL handles up to thousands of keys.
          const parentJql = `key in (${missingParentKeys.join(",")})`;
          const parentIssues = await getAllIssuesByJql(parentJql);
          result = [...result, ...parentIssues];
        }
      }

      setIssues(result);
      setPage(1); // Reset trang về 1 mỗi khi load lại
    } catch (err: unknown) {
      const e = err as { message?: string };
      setError(e.message || "Lỗi khi tải issues");
    } finally {
      setLoading(false);
    }
  }, [selectedProject, timeRange, loadScope, isConfigured]);

  useEffect(() => { fetchIssues(); }, [fetchIssues]);

  const openDetail = async (issue: JiraIssue) => {
    setSelectedIssue(issue);
    setWorklogs([]);
    setWorklogLoading(true);
    try {
      const logs = await getWorklogs(issue.key);
      setWorklogs(logs);
    } catch {
      setWorklogs([]);
    } finally {
      setWorklogLoading(false);
    }
  };

  const handleSort = (col: typeof sortBy) => {
    if (sortBy === col) {
      setSortDir((d) => d === "asc" ? "desc" : "asc");
    } else {
      setSortBy(col);
      setSortDir("desc");
    }
  };

  const sortIndicator = (col: typeof sortBy) => {
    if (sortBy !== col) return " ↕";
    return sortDir === "asc" ? " ↑" : " ↓";
  };

  const isBugTask = useCallback((type?: string) => {
    if (!type) return false;
    const t = type.toLowerCase();
    return t === "bug in development" || t === "uat bug" || t === "production bug";
  }, []);

  const handleResolveClick = async (issue: JiraIssue) => {
    const status = issue.fields.status.name.toLowerCase();
    
    if (status === "open" || status === "mở") {
      try {
        setResolvingIssue(true);
        const transitions = await getTransitions(issue.key);
        const toInProgress = transitions.find(t => 
          t.to.name.toLowerCase() === "in progress" || 
          t.to.name.toLowerCase() === "đang thực hiện"
        );
        if (toInProgress) {
          await transitionIssue(issue.key, toInProgress.id);
          fetchIssues();
          
          if (selectedIssue && (selectedIssue.key === issue.key || selectedIssue.fields.subtasks?.some(s => s.key === issue.key))) {
             const freshIssue = await getIssue(selectedIssue.key);
             setSelectedIssue(freshIssue);
          }
        } else {
          alert(`Không tìm thấy transition sang In Progress cho task ${issue.key}`);
        }
      } catch (e: any) {
        alert("Lỗi khi chuyển trạng thái: " + (e.message || "Unknown error"));
      } finally {
        setResolvingIssue(false);
      }
    } else if (status === "in progress" || status === "đang thực hiện" || status === "đang làm") {
      setResolveModalOpen(issue as JiraIssue);
      setResolveResolution("10000");
      setResolveOutput("");
      setResolveComment("");
    } else if (status === "fixed" || status === "resolved" || status === "done" || status === "hoàn thành") {
      try {
        setResolvingIssue(true);
        let newTransitions = await getTransitions(issue.key);
        let toCommit = newTransitions.find(t => t.to.name.toLowerCase().includes("commit") || t.name.toLowerCase().includes("commit"));
        if (toCommit) {
          await transitionIssue(issue.key, toCommit.id);
          newTransitions = await getTransitions(issue.key);
        }
        
        // Nếu là UAT bug thì chuyển sang UAT
        const isUatBug = issue.fields.issuetype?.name?.toLowerCase() === "uat bug";
        if (isUatBug) {
          let toUat = newTransitions.find(t => t.to.name.toLowerCase().includes("uat") || t.name.toLowerCase().includes("uat"));
          if (toUat) {
            await transitionIssue(issue.key, toUat.id);
            newTransitions = await getTransitions(issue.key);
          }
        }
        let toClosed = newTransitions.find(t => t.to.name.toLowerCase() === "closed" || t.to.name.toLowerCase() === "đóng" || t.name.toLowerCase().includes("close"));
        if (toClosed) {
          await transitionIssue(issue.key, toClosed.id);
        }
        fetchIssues();
        if (selectedIssue && (selectedIssue.key === issue.key || selectedIssue.fields.subtasks?.some(s => s.key === issue.key))) {
           const freshIssue = await getIssue(selectedIssue.key);
           setSelectedIssue(freshIssue);
        }
      } catch (e: any) {
        alert("Lỗi khi chuyển trạng thái: " + (e.message || "Unknown error"));
      } finally {
        setResolvingIssue(false);
      }
    } else {
      alert("Tính năng này chỉ hỗ trợ chuyển từ Open -> In Progress -> Fixed -> Commit -> Closed");
    }
  };

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  // Filter + sort
  const filtered = issues
    .filter((i) => {
      const matchText = !searchText || i.key.toLowerCase().includes(searchText.toLowerCase()) || i.fields.summary.toLowerCase().includes(searchText.toLowerCase());
      const matchStatus = statusFilter === "all" || i.fields.status.name === statusFilter;
      
      let matchTime = true;
      if (timeRange === "month") {
        const updatedDate = new Date(i.fields.updated);
        const hasWorklogThisMonth = i.fields.worklog?.worklogs?.some(
          (wl) => new Date(wl.started) >= startOfMonth
        );
        matchTime = updatedDate >= startOfMonth || !!hasWorklogThisMonth;
      }

      const matchAssignee = assigneeFilter === "all" ||
        (assigneeFilter === "unassigned" && !i.fields.assignee) ||
        (i.fields.assignee && (i.fields.assignee.name || i.fields.assignee.accountId || i.fields.assignee.emailAddress) === assigneeFilter);

      let matchAdvanced = true;
      if (advancedFilter !== "all") {
        const statusName = i.fields.status.name.toLowerCase();
        const isDone = statusName === "done" || statusName === "resolved" || statusName === "closed" || statusName === "hoàn thành" || statusName === "đã giải quyết";
        const log = i.fields.timetracking?.timeSpentSeconds || 0;
        const dueDateStr = i.fields.duedate || i.fields.customfield_10302;
        let isOverdue = false;
        if (dueDateStr && !isDone) {
           const dueDate = new Date(dueDateStr);
           const today = new Date();
           today.setHours(0,0,0,0);
           isOverdue = dueDate < today;
        }

        if (advancedFilter === "overdue-unlogged") {
           matchAdvanced = isOverdue && log === 0;
        } else if (advancedFilter === "overdue") {
           matchAdvanced = isOverdue;
        } else if (advancedFilter === "unlogged") {
           matchAdvanced = !isDone && log === 0;
        }
      }

      return matchText && matchStatus && matchTime && matchAssignee && matchAdvanced;
    })
    .sort((a, b) => {
      let va = 0, vb = 0;
      if (sortBy === "key") {
        const cmp = a.key.localeCompare(b.key);
        return sortDir === "asc" ? cmp : -cmp;
      }
      if (sortBy === "updated") {
        va = new Date(a.fields.updated).getTime();
        vb = new Date(b.fields.updated).getTime();
      } else if (sortBy === "logged") {
        if (timeRange === "month") {
          va = a.fields.worklog?.worklogs?.reduce((s, wl) => new Date(wl.started) >= startOfMonth ? s + wl.timeSpentSeconds : s, 0) || 0;
          vb = b.fields.worklog?.worklogs?.reduce((s, wl) => new Date(wl.started) >= startOfMonth ? s + wl.timeSpentSeconds : s, 0) || 0;
        } else {
          va = a.fields.timetracking?.timeSpentSeconds || 0;
          vb = b.fields.timetracking?.timeSpentSeconds || 0;
        }
      } else if (sortBy === "estimate") {
        va = a.fields.timetracking?.originalEstimateSeconds || 0;
        vb = b.fields.timetracking?.originalEstimateSeconds || 0;
      } else if (sortBy === "startDate") {
        va = a.fields.customfield_10300 ? new Date(a.fields.customfield_10300).getTime() : 0;
        vb = b.fields.customfield_10300 ? new Date(b.fields.customfield_10300).getTime() : 0;
      }
      return sortDir === "asc" ? va - vb : vb - va;
    });

  const totalFiltered = filtered.length;
  const totalPages = Math.ceil(totalFiltered / pageSize) || 1;
  const paginatedFiltered = filtered.slice((page - 1) * pageSize, page * pageSize);

  const uniqueStatuses = [...new Set(issues.map((i) => i.fields.status.name))];
  // Filter out duplicates in projectUsers (just in case)
  const uniqueAssignees = [...new Map(
    projectUsers.map((a) => [a.name || a.accountId || a.emailAddress, a])
  ).values()];

  if (!isConfigured) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div className="page-header">
          <div className="page-title-group">
            <h1 className="page-title">Danh sách Issues</h1>
          </div>
        </div>
        <div className="page-body" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="empty-state">
            <div className="empty-state-icon">🔌</div>
            <div className="empty-state-title">Chưa kết nối Jira</div>
            <p className="empty-state-text">Vào Cài đặt để nhập Jira PAT token.</p>
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
          <h1 className="page-title">Danh sách Issues</h1>
          <p className="page-subtitle">{filtered.length}/{issues.length} issues • Project: {selectedProject}</p>
        </div>
        <div className="page-actions">
          <button id="btn-refresh-issues" className="btn btn-secondary btn-sm" onClick={fetchIssues} disabled={loading}>
            <span className={loading ? "spinning" : ""}>🔄</span> {loading ? "Đang tải..." : "Refresh"}
          </button>
        </div>
      </div>

      <div className="page-body">
        {/* Filters */}
        <div className="filter-bar" style={{ flexWrap: "wrap", gap: 12 }}>
          {/* Project tabs */}
          <div style={{ display: "flex", gap: 4 }}>
            {JIRA_PROJECTS.map((p) => (
              <button
                key={p.key}
                id={`tab-project-${p.key}`}
                className={`btn btn-sm ${selectedProject === p.key ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setSelectedProject(p.key)}
              >
                {p.name}
              </button>
            ))}
          </div>

          {/* Load Scope Tabs */}
          <div style={{ display: "flex", gap: 4, background: "rgba(255,255,255,0.03)", padding: 3, borderRadius: 8, border: "1px solid var(--border)" }}>
            <button
              className={`btn btn-sm`}
              style={{
                background: loadScope === "me" ? "var(--accent-blue)" : "transparent",
                color: "var(--text-primary)",
                border: "none",
                fontSize: 11,
                padding: "4px 10px"
              }}
              onClick={() => setLoadScope("me")}
            >
              Của tôi
            </button>
            <button
              className={`btn btn-sm`}
              style={{
                background: loadScope === "all" ? "var(--accent-blue)" : "transparent",
                color: "var(--text-primary)",
                border: "none",
                fontSize: 11,
                padding: "4px 10px"
              }}
              onClick={() => setLoadScope("all")}
            >
              Tất cả
            </button>
          </div>

          {/* Time Filter Tabs */}
          <div style={{ display: "flex", gap: 4, background: "rgba(255,255,255,0.03)", padding: 3, borderRadius: 8, border: "1px solid var(--border)" }}>
            <button
              className={`btn btn-sm`}
              style={{
                background: timeRange === "month" ? "var(--accent-blue)" : "transparent",
                color: "var(--text-primary)",
                border: "none",
                fontSize: 11,
                padding: "4px 10px"
              }}
              onClick={() => setTimeRange("month")}
            >
              Tháng này
            </button>
            <button
              className={`btn btn-sm`}
              style={{
                background: timeRange === "all" ? "var(--accent-blue)" : "transparent",
                color: "var(--text-primary)",
                border: "none",
                fontSize: 11,
                padding: "4px 10px"
              }}
              onClick={() => setTimeRange("all")}
            >
              Tất cả
            </button>
          </div>

          <div style={{ flex: 1, display: "flex", gap: 8, minWidth: 200, marginLeft: "auto" }}>
            <input
              id="input-search-issues"
              type="text"
              placeholder="🔍  Tìm kiếm issue..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              style={{ flex: 1, minWidth: 120 }}
            />
            <select
              id="select-status-filter"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              style={{ width: 140 }}
            >
              <option value="all">Tất cả status</option>
              {uniqueStatuses.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select
              id="select-assignee-filter"
              value={assigneeFilter}
              onChange={(e) => setAssigneeFilter(e.target.value)}
              style={{ width: 150 }}
            >
              <option value="all">Tất cả Assignee</option>
              <option value="unassigned">Chưa phân công</option>
              {uniqueAssignees.map((a) => {
                const userKey = a.name || a.accountId || a.emailAddress;
                return (
                  <option key={userKey} value={userKey}>
                    {a.displayName}
                  </option>
                );
              })}
            </select>
            <select
              id="select-advanced-filter"
              value={advancedFilter}
              onChange={(e) => setAdvancedFilter(e.target.value)}
              style={{ width: 160 }}
            >
              <option value="all">Tất cả tình trạng</option>
              <option value="overdue-unlogged">Quá hạn chưa log work</option>
              <option value="overdue">Quá hạn</option>
              <option value="unlogged">Chưa log work</option>
            </select>
          </div>
        </div>

        {error && (
          <div className="toast error" style={{ marginBottom: 12 }}>❌ {error}</div>
        )}

        {/* Table */}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th onClick={() => handleSort("key")} style={{ cursor: "pointer" }}>Key{sortIndicator("key")}</th>
                <th>Tóm tắt</th>
                <th>Người xử lý</th>
                <th>Trạng thái</th>
                <th>Loại</th>
                <th onClick={() => handleSort("startDate")} style={{ cursor: "pointer" }}>Start Date{sortIndicator("startDate")}</th>
                <th onClick={() => handleSort("estimate")} style={{ cursor: "pointer" }}>Estimate{sortIndicator("estimate")}</th>
                <th onClick={() => handleSort("logged")} style={{ cursor: "pointer" }}>Logged{sortIndicator("logged")}</th>
                <th>Tiến độ</th>
                <th onClick={() => handleSort("updated")} style={{ cursor: "pointer" }}>Cập nhật{sortIndicator("updated")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 11 }).map((__, j) => (
                      <td key={j}><div className="skeleton" style={{ height: 16, borderRadius: 4 }} /></td>
                    ))}
                  </tr>
                ))
              ) : paginatedFiltered.length === 0 ? (
                <tr>
                  <td colSpan={11}>
                    <div className="empty-state" style={{ padding: 32 }}>
                      <div className="empty-state-icon">📭</div>
                      <div className="empty-state-title">Không có issues</div>
                      <p className="empty-state-text">Thử thay đổi bộ lọc hoặc project khác</p>
                      {searchText.match(/^[A-Za-z]+-\d+$/) && (
                        <button 
                          className="btn btn-primary" 
                          style={{ marginTop: 16 }}
                          onClick={async () => {
                            try {
                              setLoading(true);
                              const issue = await getIssue(searchText.toUpperCase());
                              setIssues((prev) => {
                                if (prev.find((i) => i.key === issue.key)) return prev;
                                return [issue, ...prev];
                              });
                              setError(null);
                            } catch (e: any) {
                              setError("Không tìm thấy ticket trên máy chủ Jira hoặc bạn không có quyền xem.");
                            } finally {
                              setLoading(false);
                            }
                          }}
                        >
                          Tải dữ liệu "{searchText.toUpperCase()}" từ Jira
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                paginatedFiltered.map((issue) => {
                  const est = issue.fields.timetracking?.originalEstimateSeconds || 0;
                  const log = issue.fields.timetracking?.timeSpentSeconds || 0;
                  const pct = est > 0 ? Math.round((log / est) * 100) : (log > 0 ? 100 : 0);
                  const updatedDate = new Date(issue.fields.updated).toLocaleDateString("vi-VN");
                  const startDateStr = issue.fields.customfield_10300 ? new Date(issue.fields.customfield_10300).toLocaleDateString("vi-VN") : "—";

                  return (
                    <tr key={issue.id}>
                      <td>
                        <a
                          href={`https://20.84.97.109:3033/browse/${issue.key}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: "var(--accent-blue-light)", fontWeight: 700, textDecoration: "none", fontSize: 12 }}
                        >
                          {issue.key}
                        </a>
                      </td>
                      <td style={{ maxWidth: 280 }}>
                        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-primary)", fontSize: 13 }}>
                          {issue.fields.summary}
                        </div>
                      </td>
                      <td>
                        {issue.fields.assignee ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <img
                              src={issue.fields.assignee.avatarUrls["48x48"]}
                              alt={issue.fields.assignee.displayName}
                              style={{ width: 22, height: 22, borderRadius: "50%", border: "1px solid var(--border)" }}
                            />
                            <span style={{ fontSize: 12, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 100 }} title={issue.fields.assignee.displayName}>
                              {issue.fields.assignee.displayName}
                            </span>
                          </div>
                        ) : (
                          <span style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>Chưa phân công</span>
                        )}
                      </td>
                      <td>
                        <span className={getBadgeClass(issue.fields.status.name)}>
                          {issue.fields.status.name}
                        </span>
                      </td>
                      <td style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {issue.fields.issuetype?.name || "—"}
                      </td>
                      <td style={{ fontSize: 11, color: "var(--text-primary)" }}>{startDateStr}</td>
                      <td style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 500 }}>
                        {est ? formatSeconds(est) : <span style={{ color: "var(--text-muted)" }}>—</span>}
                      </td>
                      <td style={{ fontSize: 12, color: "var(--accent-green)", fontWeight: 700 }}>
                        {log ? formatSeconds(log) : <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>—</span>}
                      </td>
                      <td style={{ width: 100 }}>
                        {est > 0 ? (
                          <div>
                            <div style={{ fontSize: 10, color: pct > 100 ? "var(--accent-red)" : "var(--text-muted)", marginBottom: 3 }}>{pct}%</div>
                            <div className="progress-bar-wrap">
                              <div className={`progress-bar-fill ${getProgressClass(pct)}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                            </div>
                          </div>
                        ) : <span style={{ color: "var(--text-muted)", fontSize: 11 }}>—</span>}
                      </td>
                      <td style={{ fontSize: 11, color: "var(--text-muted)" }}>{updatedDate}</td>
                      <td>
                        <button
                          id={`btn-detail-${issue.key}`}
                          className="btn btn-ghost btn-sm"
                          onClick={() => openDetail(issue)}
                        >
                          Chi tiết
                        </button>
                        {(issue.fields.issuetype?.name === "Task" || issue.fields.issuetype?.name === "Story") && (
                          <button
                            className="btn btn-ghost btn-sm"
                            style={{ color: "var(--accent-blue)", marginLeft: 4 }}
                            onClick={() => {
                              setSubTaskModalOpen(issue);
                              setSubTasks([{ summary: "", estimate: "", assigneeName: "" }]);
                            }}
                            title="Tạo Sub-task"
                          >
                            + Sub-task
                          </button>
                        )}
                        {isBugTask(issue.fields.issuetype?.name) && 
                         !["closed", "đóng", "hoàn thành", "commit"].some(s => issue.fields.status?.name?.toLowerCase().includes(s)) && (
                            <button
                              className="btn btn-ghost btn-sm"
                              style={{ color: "var(--accent-purple)", marginLeft: 4 }}
                              onClick={() => handleResolveClick(issue)}
                              disabled={resolvingIssue}
                              title="Chuyển trạng thái Resolved"
                            >
                              ✓ Resolved
                            </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && !loading && (
          <div className="pagination" style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 16, padding: "16px 0", marginTop: 8 }}>
            <button 
              className="btn btn-secondary btn-sm" 
              disabled={page === 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}
            >
              Trước
            </button>
            <span style={{ fontSize: 13, color: "var(--text-secondary)", fontWeight: 500 }}>
              Trang {page} / {totalPages}
            </span>
            <button 
              className="btn btn-secondary btn-sm" 
              disabled={page === totalPages}
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            >
              Tiếp theo
            </button>
          </div>
        )}
      </div>

      {/* Detail Modal */}
      {selectedIssue && (
        <div className="modal-overlay" onClick={() => setSelectedIssue(null)}>
          <div className="modal" style={{ maxWidth: 580 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div style={{ fontSize: 12, color: "var(--accent-blue-light)", fontWeight: 700, marginBottom: 4 }}>
                  <a
                    href={`https://20.84.97.109:3033/browse/${selectedIssue.key}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "inherit", textDecoration: "none" }}
                  >
                    {selectedIssue.key} ↗
                  </a>
                </div>
                <div className="modal-title" style={{ fontSize: 15 }}>{selectedIssue.fields.summary}</div>
              </div>
              <button className="modal-close" onClick={() => setSelectedIssue(null)}>✕</button>
            </div>

            {/* Time tracking summary */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 20 }}>
              {[
                { label: "Estimate", value: formatSeconds(selectedIssue.fields.timetracking?.originalEstimateSeconds || 0), color: "var(--accent-blue)" },
                { label: "Logged", value: formatSeconds(selectedIssue.fields.timetracking?.timeSpentSeconds || 0), color: "var(--accent-green)" },
                { label: "Remaining", value: formatSeconds(selectedIssue.fields.timetracking?.remainingEstimateSeconds || 0), color: "var(--accent-orange)" },
              ].map((s) => (
                <div key={s.label} style={{ background: "var(--bg-card)", borderRadius: 8, padding: "12px 14px", border: "1px solid var(--border)" }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>{s.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: s.color }}>{s.value}</div>
                </div>
              ))}
            </div>

            {/* Status + Type */}
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <span className={getBadgeClass(selectedIssue.fields.status.name)}>{selectedIssue.fields.status.name}</span>
              <span className="badge badge-todo">{selectedIssue.fields.issuetype?.name}</span>
              {selectedIssue.fields.priority && (
                <span className="badge badge-todo">{selectedIssue.fields.priority.name}</span>
              )}
            </div>

            {/* Subtasks */}
            {selectedIssue.fields.subtasks && selectedIssue.fields.subtasks.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: "var(--text-primary)" }}>
                  📋 Sub-tasks ({selectedIssue.fields.subtasks.length})
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {selectedIssue.fields.subtasks.map((st) => (
                    <div key={st.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--bg-card)", borderRadius: 6, border: "1px solid var(--border)" }}>
                      <span className={getBadgeClass(st.fields.status.name)} style={{ fontSize: 10, padding: "2px 6px" }}>
                        {st.fields.status.name}
                      </span>
                      <a href={`https://20.84.97.109:3033/browse/${st.key}`} target="_blank" rel="noreferrer" style={{ fontSize: 12, fontWeight: 600, color: "var(--accent-blue-light)", textDecoration: "none" }}>
                        {st.key}
                      </a>
                      <span style={{ fontSize: 13, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>
                        {st.fields.summary}
                      </span>

                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ color: "var(--accent-green)", padding: "2px 8px", fontSize: 11 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setLogWorkModalOpen({ key: st.key, summary: st.fields.summary });
                          setLogWorkTime("");
                          setLogWorkComment("");
                        }}
                      >
                        + Log work
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Worklogs */}
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, color: "var(--text-primary)" }}>
                📝 Worklog ({worklogs.length})
              </div>
              {worklogLoading ? (
                <div style={{ display: "flex", justifyContent: "center", padding: 20 }}>
                  <div className="loading-spinner" />
                </div>
              ) : worklogs.length === 0 ? (
                <div style={{ fontSize: 13, color: "var(--text-muted)", textAlign: "center", padding: "16px 0" }}>
                  Chưa có worklog nào
                </div>
              ) : (
                <div style={{ maxHeight: 240, overflowY: "auto" }}>
                  {worklogs.map((wl) => (
                    <div key={wl.id} className="worklog-item">
                      <div className="worklog-dot" />
                      <div className="worklog-content">
                        <div className="worklog-time">{wl.timeSpent}</div>
                        {wl.comment && <div className="worklog-comment">{wl.comment}</div>}
                        <div className="worklog-meta">
                          {wl.author.displayName} • {new Date(wl.started).toLocaleString("vi-VN")}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setSelectedIssue(null)}>Đóng</button>
              <a
                href={`https://20.84.97.109:3033/browse/${selectedIssue.key}`}
                target="_blank"
                rel="noreferrer"
                className="btn btn-primary"
              >
                Mở trong Jira ↗
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Sub-task Modal */}
      {subTaskModalOpen && (
        <div className="modal-overlay" onClick={() => !creatingSubTask && setSubTaskModalOpen(null)}>
          <div className="modal" style={{ maxWidth: 650 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">Tạo nhanh nhiều Sub-task cho {subTaskModalOpen.key}</div>
              <button className="modal-close" onClick={() => !creatingSubTask && setSubTaskModalOpen(null)}>✕</button>
            </div>
            
            <div style={{ maxHeight: "60vh", overflowY: "auto", paddingRight: 4 }}>
              {subTasks.map((st, i) => (
                <div key={i} style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "flex-start" }}>
                  <div className="form-group" style={{ flex: 1, margin: 0 }}>
                    {i === 0 && <label>Tóm tắt (Summary) *</label>}
                    <input
                      type="text"
                      autoFocus={i === 0}
                      placeholder="Nhập tiêu đề công việc con..."
                      value={st.summary}
                      onChange={(e) => {
                        const newST = [...subTasks];
                        newST[i].summary = e.target.value;
                        setSubTasks(newST);
                      }}
                      disabled={creatingSubTask}
                      required
                    />
                  </div>
                  
                  <div className="form-group" style={{ width: 120, margin: 0 }}>
                    {i === 0 && <label>Estimate</label>}
                    <input
                      type="text"
                      placeholder="VD: 2h, 30m"
                      value={st.estimate}
                      onChange={(e) => {
                        const newST = [...subTasks];
                        newST[i].estimate = e.target.value;
                        setSubTasks(newST);
                      }}
                      disabled={creatingSubTask}
                    />
                  </div>
                  
                  <div className="form-group" style={{ width: 140, margin: 0 }}>
                    {i === 0 && <label>Assignee</label>}
                    <select
                      value={st.assigneeName || ""}
                      onChange={(e) => {
                        const newST = [...subTasks];
                        newST[i].assigneeName = e.target.value;
                        setSubTasks(newST);
                      }}
                      disabled={creatingSubTask || loadingUsers}
                    >
                      <option value="">{loadingUsers ? "Đang tải..." : "-- Tôi --"}</option>
                      {uniqueAssignees.map((a) => {
                        const userKey = a.name || a.accountId || a.emailAddress;
                        return (
                          <option key={userKey} value={userKey}>
                            {a.displayName}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                  
                  <div style={{ marginTop: i === 0 ? 24 : 4 }}>
                    <button 
                      className="btn btn-ghost btn-sm" 
                      style={{ padding: "8px 12px", color: subTasks.length > 1 ? "var(--accent-red)" : "var(--text-muted)", background: "rgba(255,255,255,0.05)" }}
                      onClick={() => {
                        if (subTasks.length > 1) {
                          setSubTasks(subTasks.filter((_, idx) => idx !== i));
                        } else {
                          setSubTasks([{ summary: "", estimate: "", assigneeName: "" }]);
                        }
                      }}
                      disabled={creatingSubTask}
                      title="Xóa dòng"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 8, marginBottom: 16 }}>
              <button 
                className="btn btn-ghost btn-sm" 
                style={{ color: "var(--accent-blue)", border: "1px dashed var(--accent-blue)" }}
                onClick={() => setSubTasks([...subTasks, { summary: "", estimate: "", assigneeName: "" }])}
                disabled={creatingSubTask}
              >
                + Thêm Sub-task
              </button>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setSubTaskModalOpen(null)} disabled={creatingSubTask}>Hủy</button>
              <button 
                className="btn btn-primary" 
                disabled={subTasks.every(st => !st.summary.trim()) || creatingSubTask}
                onClick={async () => {
                  const validTasks = subTasks.filter(st => st.summary.trim());
                  if (validTasks.length === 0) return;
                  
                  setCreatingSubTask(true);
                  try {
                    // Create sequentially to avoid overwhelming Jira API
                    for (const st of validTasks) {
                      await createSubTask({
                        parentKey: subTaskModalOpen.key,
                        projectKey: subTaskModalOpen.fields.project.key,
                        summary: st.summary.trim(),
                        originalEstimate: st.estimate.trim() || undefined,
                        assigneeName: st.assigneeName || undefined
                      });
                    }
                    setSubTaskModalOpen(null);
                    fetchIssues(); // Refresh list
                  } catch (e: any) {
                    let msg = e.message || "Unknown error";
                    if (e.response?.data?.errorMessages?.length) {
                      msg = e.response.data.errorMessages[0];
                    } else if (e.response?.data?.errors) {
                      msg = Object.values(e.response.data.errors).join(", ");
                    }
                    alert("Lỗi khi tạo sub-task: " + msg);
                  } finally {
                    setCreatingSubTask(false);
                  }
                }}
              >
                {creatingSubTask ? "Đang tạo..." : `Tạo ${subTasks.filter(st => st.summary.trim()).length} Sub-task`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Log Work Modal */}
      {logWorkModalOpen && (
        <div className="modal-overlay" onClick={() => !loggingWork && setLogWorkModalOpen(null)}>
          <div className="modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">Log Work cho {logWorkModalOpen.key}</div>
              <button className="modal-close" onClick={() => !loggingWork && setLogWorkModalOpen(null)}>✕</button>
            </div>
            <div className="form-group">
              <label>Thời gian (VD: 2h, 30m, 1d) *</label>
              <input
                type="text"
                value={logWorkTime}
                onChange={(e) => setLogWorkTime(e.target.value)}
                placeholder="2h 30m"
                disabled={loggingWork}
                autoFocus
              />
            </div>
            <div className="form-group">
              <label>Ghi chú (Tùy chọn)</label>
              <textarea
                value={logWorkComment}
                onChange={(e) => setLogWorkComment(e.target.value)}
                rows={3}
                placeholder="Đã làm..."
                disabled={loggingWork}
              />
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setLogWorkModalOpen(null)} disabled={loggingWork}>Hủy</button>
              <button
                className="btn btn-primary"
                disabled={!logWorkTime.trim() || loggingWork}
                onClick={async () => {
                  try {
                    setLoggingWork(true);
                    const timeRegex = /([0-9.]+)([wdhm])/g;
                    let totalSeconds = 0;
                    let match;
                    while ((match = timeRegex.exec(logWorkTime.toLowerCase())) !== null) {
                      const val = parseFloat(match[1]);
                      const unit = match[2];
                      if (unit === "w") totalSeconds += val * 5 * 8 * 3600;
                      else if (unit === "d") totalSeconds += val * 8 * 3600;
                      else if (unit === "h") totalSeconds += val * 3600;
                      else if (unit === "m") totalSeconds += val * 60;
                    }
                    if (totalSeconds === 0) {
                      throw new Error("Định dạng thời gian không đúng. VD: 2h, 30m");
                    }
                    let finalComment = logWorkComment.trim();
                    if (!finalComment) {
                      const geminiKey = localStorage.getItem("gemini_api_key");
                      if (geminiKey) {
                        try {
                          const summary = logWorkModalOpen.summary;
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
                            console.warn(`Auto AI comment failed: HTTP ${response.status}`);
                          }
                        } catch (e) {
                          console.warn("Auto AI generation failed, falling back to static template", e);
                        }
                      }

                      if (!finalComment) {
                        finalComment = `Thực hiện công việc: ${logWorkModalOpen.summary}`;
                      }
                    }

                    await addWorklog(logWorkModalOpen.key, {
                      timeSpentSeconds: totalSeconds,
                      comment: finalComment,
                    });
                    
                    setLogWorkModalOpen(null);
                    // Refresh issue details
                    if (selectedIssue && selectedIssue.key === selectedIssue.key) {
                      openDetail(selectedIssue);
                    }
                  } catch (e: any) {
                    alert("Lỗi khi log work: " + (e.message || "Unknown error"));
                  } finally {
                    setLoggingWork(false);
                  }
                }}
              >
                {loggingWork ? "Đang lưu..." : "Lưu Worklog"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Resolve Bug Modal */}
      {resolveModalOpen && (
        <div className="modal-overlay" onClick={() => !resolvingIssue && setResolveModalOpen(null)}>
          <div className="modal" style={{ maxWidth: 500 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">Fixed - {resolveModalOpen.key}</div>
              <button className="modal-close" onClick={() => !resolvingIssue && setResolveModalOpen(null)}>✕</button>
            </div>
            
            <div className="form-group">
              <label>Resolution *</label>
              <select 
                value={resolveResolution} 
                onChange={e => setResolveResolution(e.target.value)}
                disabled={resolvingIssue}
                required
              >
                <option value="10000">Done</option>
                <option value="10001">Won't Do</option>
                <option value="10002">Duplicate</option>
                <option value="10003">Cannot Reproduce</option>
              </select>
            </div>

            <div className="form-group">
              <label>Output</label>
              <textarea
                value={resolveOutput}
                onChange={(e) => setResolveOutput(e.target.value)}
                rows={4}
                placeholder="Nhập thông tin output (Nếu để trống AI sẽ tự sinh)..."
                disabled={resolvingIssue}
              />
            </div>

            <div className="form-group">
              <label>Comment</label>
              <textarea
                value={resolveComment}
                onChange={(e) => setResolveComment(e.target.value)}
                rows={4}
                placeholder="Nhập comment..."
                disabled={resolvingIssue}
              />
            </div>
            
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setResolveModalOpen(null)} disabled={resolvingIssue}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={resolvingIssue || !resolveResolution}
                onClick={async () => {
                  try {
                    setResolvingIssue(true);
                    
                    // Lấy transition Fixed
                    const transitions = await getTransitions(resolveModalOpen.key);
                    const toFixed = transitions.find(t => t.to.name.toLowerCase() === "fixed" || t.to.name.toLowerCase() === "resolved" || t.to.name.toLowerCase() === "done");
                    
                    if (toFixed) {
                      // Tìm ID của custom field Output
                      const allFields = await getJiraFields();
                      const outputField = allFields.find(f => f.name.toLowerCase() === "output" || f.name.toLowerCase() === "out put");
                      const outputFieldId = outputField ? outputField.id : "customfield_10000"; // fallback

                      const transitionFields: any = {
                        resolution: { id: resolveResolution }
                      };
                      
                      let finalOutput = resolveOutput.trim();
                      if (!finalOutput) {
                         finalOutput = await generateAiOutput(resolveModalOpen.fields.summary);
                      }
                      if (!finalOutput) {
                        finalOutput = `Đã hoàn thành: ${resolveModalOpen.fields.summary}`;
                      }

                      if (outputFieldId) {
                        transitionFields[outputFieldId] = finalOutput;
                      }

                      await transitionIssue(resolveModalOpen.key, toFixed.id, transitionFields, resolveComment.trim() || undefined);
                    }
                    
                    // Chuyển sang Commit (nếu có) - CHỈ DÀNH CHO BUG
                    let newTransitions = await getTransitions(resolveModalOpen.key);
                    const isBug = resolveModalOpen.fields.issuetype?.name?.toLowerCase().includes("bug");
                    if (isBug) {
                      let toCommit = newTransitions.find(t => t.to.name.toLowerCase().includes("commit") || t.name.toLowerCase().includes("commit"));
                      if (toCommit) {
                        await transitionIssue(resolveModalOpen.key, toCommit.id);
                        newTransitions = await getTransitions(resolveModalOpen.key);
                      }
                    }
                    
                    // Nếu là UAT bug thì chuyển sang UAT
                    const isUatBug = resolveModalOpen.fields.issuetype?.name?.toLowerCase() === "uat bug";
                    if (isUatBug) {
                      let toUat = newTransitions.find(t => t.to.name.toLowerCase().includes("uat") || t.name.toLowerCase().includes("uat"));
                      if (toUat) {
                        await transitionIssue(resolveModalOpen.key, toUat.id);
                        newTransitions = await getTransitions(resolveModalOpen.key);
                      }
                    }
                    
                    // Chuyển sang Closed (nếu có)
                    let toClosed = newTransitions.find(t => t.to.name.toLowerCase() === "closed" || t.to.name.toLowerCase() === "đóng" || t.name.toLowerCase().includes("close"));
                    if (toClosed) {
                      await transitionIssue(resolveModalOpen.key, toClosed.id);
                    }
                    
                    setResolveModalOpen(null);
                    fetchIssues();
                    if (selectedIssue && (selectedIssue.key === resolveModalOpen.key || selectedIssue.fields.subtasks?.some(s => s.key === resolveModalOpen.key))) {
                       const freshIssue = await getIssue(selectedIssue.key);
                       setSelectedIssue(freshIssue);
                    }
                  } catch (e: any) {
                    alert("Lỗi khi chuyển trạng thái: " + (e.message || "Unknown error"));
                  } finally {
                    setResolvingIssue(false);
                  }
                }}
              >
                {resolvingIssue ? "Đang xử lý..." : "Fixed"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
