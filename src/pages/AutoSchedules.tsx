import { useCallback, useEffect, useMemo, useState } from "react";
import { getAllIssuesByJql, JiraIssue, formatSeconds, parseTimeToSeconds } from "../jiraService";
import { JIRA_BASE_URL } from "../config";
import { silentAutoProcessTasks } from "../autoProcessor";
import {
  AutoResolveScheduleItem,
  clearFinishedAutoResolveSchedules,
  getAutoResolveScheduleItems,
  removeAutoResolveIssueKey,
} from "../stores/autoResolveStore";

type ScheduleFilter = "active" | "due" | "completed" | "error" | "all";

const activeStatuses = new Set(["pending", "processing", "error"]);

function escapeJqlKey(key: string): string {
  return key.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function normalizeText(str?: string) {
  if (!str) return "";
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "d").toLowerCase();
}

function toStartOfLocalDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function parseOptionalDate(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateTime(value?: string | number | null) {
  if (!value) return "—";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getIssueEstimateSeconds(issue?: JiraIssue, item?: AutoResolveScheduleItem) {
  const issueEstimate = issue?.fields.timetracking?.originalEstimateSeconds || 0;
  if (issueEstimate > 0) return issueEstimate;
  const textEstimate = issue?.fields.timetracking?.originalEstimate || item?.estimate;
  return textEstimate ? parseTimeToSeconds(textEstimate) : 0;
}

function getIssueLoggedSeconds(issue?: JiraIssue) {
  return issue?.fields.timetracking?.timeSpentSeconds || issue?.fields.aggregatetimespent || 0;
}

function getEndDate(item: AutoResolveScheduleItem, issue?: JiraIssue) {
  return issue?.fields.customfield_10302 || issue?.fields.duedate || item.endDate;
}

function isScheduleDue(item: AutoResolveScheduleItem, issue?: JiraIssue) {
  if (!activeStatuses.has(item.status)) return false;
  const endDate = parseOptionalDate(getEndDate(item, issue));
  if (!endDate) return false;
  return toStartOfLocalDay(endDate).getTime() <= toStartOfLocalDay(new Date()).getTime();
}

function getScheduleLabel(item: AutoResolveScheduleItem, issue?: JiraIssue) {
  if (item.status === "completed") return "Đã xử lý";
  if (item.status === "skipped") return "Đã bỏ qua";
  if (item.status === "error") return "Lỗi";
  if (item.status === "processing") return "Đang xử lý";
  if (isScheduleDue(item, issue)) return "Đến hạn";
  return "Đang chờ";
}

function getScheduleBadgeClass(item: AutoResolveScheduleItem, issue?: JiraIssue) {
  if (item.status === "completed") return "badge badge-done";
  if (item.status === "error") return "badge badge-blocked";
  if (item.status === "processing" || isScheduleDue(item, issue)) return "badge badge-inprogress";
  return "badge badge-todo";
}

export default function AutoSchedules() {
  const [items, setItems] = useState<AutoResolveScheduleItem[]>([]);
  const [issuesByKey, setIssuesByKey] = useState<Record<string, JiraIssue>>({});
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState<ScheduleFilter>("active");
  const [searchText, setSearchText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isConfigured = !!localStorage.getItem("jira_pat") || !!localStorage.getItem("jira_basic");
  const jiraBaseUrl = localStorage.getItem("jira_url") || JIRA_BASE_URL;

  const fetchIssueDetails = useCallback(async (scheduleItems: AutoResolveScheduleItem[]) => {
    if (!isConfigured || scheduleItems.length === 0) {
      setIssuesByKey({});
      return;
    }

    const keys = Array.from(new Set(scheduleItems.map(item => item.key).filter(Boolean)));
    const chunks: string[][] = [];
    for (let i = 0; i < keys.length; i += 80) {
      chunks.push(keys.slice(i, i + 80));
    }

    const fetched: JiraIssue[] = [];
    for (const chunk of chunks) {
      const quotedKeys = chunk.map(key => `"${escapeJqlKey(key)}"`).join(",");
      const result = await getAllIssuesByJql(`key in (${quotedKeys})`, chunk.length);
      fetched.push(...result);
    }

    setIssuesByKey(Object.fromEntries(fetched.map(issue => [issue.key, issue])));
  }, [isConfigured]);

  const loadSchedules = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const nextItems = getAutoResolveScheduleItems();
      setItems(nextItems);
      await fetchIssueDetails(nextItems);
    } catch (err: any) {
      setError(err?.response?.data?.errorMessages?.[0] || err?.message || "Không tải được danh sách lịch.");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [fetchIssueDetails]);

  useEffect(() => {
    loadSchedules();
  }, [loadSchedules]);

  const stats = useMemo(() => {
    const active = items.filter(item => activeStatuses.has(item.status)).length;
    const due = items.filter(item => isScheduleDue(item, issuesByKey[item.key])).length;
    const completed = items.filter(item => item.status === "completed" || item.status === "skipped").length;
    const errors = items.filter(item => item.status === "error").length;
    return { total: items.length, active, due, completed, errors };
  }, [items, issuesByKey]);

  const filteredItems = useMemo(() => {
    const search = normalizeText(searchText);
    return items.filter(item => {
      const issue = issuesByKey[item.key];
      const matchesFilter =
        filter === "all" ||
        (filter === "active" && activeStatuses.has(item.status)) ||
        (filter === "due" && isScheduleDue(item, issue)) ||
        (filter === "completed" && (item.status === "completed" || item.status === "skipped")) ||
        (filter === "error" && item.status === "error");

      const haystack = normalizeText([
        item.key,
        issue?.fields.summary || item.summary,
        issue?.fields.project?.key || item.projectKey,
        issue?.fields.assignee?.displayName || item.assigneeName,
        issue?.fields.status?.name,
      ].filter(Boolean).join(" "));

      return matchesFilter && (!search || haystack.includes(search));
    });
  }, [filter, issuesByKey, items, searchText]);

  const runNow = async () => {
    setRunning(true);
    setMessage(null);
    setError(null);
    try {
      let progress = "";
      await silentAutoProcessTasks((msg) => {
        progress = msg;
        setMessage(msg);
      });
      await loadSchedules(true);
      setMessage(progress || "Đã kiểm tra lịch auto log và Resolve.");
    } catch (err: any) {
      setError(err?.message || "Chạy xử lý tự động thất bại.");
    } finally {
      setRunning(false);
    }
  };

  const removeSchedule = (key: string) => {
    removeAutoResolveIssueKey(key);
    loadSchedules(true);
  };

  const clearFinished = () => {
    clearFinishedAutoResolveSchedules();
    loadSchedules(true);
  };

  return (
    <>
      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">Lịch Auto Log & Resolve</h1>
          <p className="page-subtitle">Theo dõi các task được lên lịch từ màn tạo issue nhanh</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary btn-sm" onClick={runNow} disabled={running || loading || stats.active === 0}>
            <span className={running ? "spinning" : ""}>▶</span> Chạy ngay
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => loadSchedules()} disabled={loading || running}>
            <span className={loading ? "spinning" : ""}>↻</span> Refresh
          </button>
          <button className="btn btn-secondary btn-sm" onClick={clearFinished} disabled={loading || running || stats.completed === 0}>
            Xóa đã xử lý
          </button>
        </div>
      </div>

      <div className="page-body auto-schedule-page">
        <div className="stats-grid auto-schedule-stats">
          <div className="stat-card">
            <div className="stat-value">{stats.active}</div>
            <div className="stat-label">Đang lên lịch</div>
          </div>
          <div className="stat-card">
            <div className="stat-value" style={{ color: "var(--accent-orange)" }}>{stats.due}</div>
            <div className="stat-label">Đến hạn xử lý</div>
          </div>
          <div className="stat-card">
            <div className="stat-value" style={{ color: "var(--accent-green)" }}>{stats.completed}</div>
            <div className="stat-label">Đã xử lý</div>
          </div>
          <div className="stat-card">
            <div className="stat-value" style={{ color: stats.errors > 0 ? "var(--accent-red)" : "var(--text-primary)" }}>{stats.errors}</div>
            <div className="stat-label">Lỗi</div>
          </div>
        </div>

        {(message || error) && (
          <div className={`auto-schedule-alert ${error ? "error" : "success"}`}>
            {error || message}
          </div>
        )}

        <div className="filter-bar auto-schedule-filter">
          <input
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Tìm theo key, summary, assignee..."
          />
          <select value={filter} onChange={(e) => setFilter(e.target.value as ScheduleFilter)}>
            <option value="active">Đang lên lịch</option>
            <option value="due">Đến hạn</option>
            <option value="completed">Đã xử lý</option>
            <option value="error">Lỗi</option>
            <option value="all">Tất cả</option>
          </select>
        </div>

        <div className="table-wrap auto-schedule-table-wrap">
          {loading ? (
            <div className="empty-state">
              <div className="loading-spinner" />
              <div className="empty-state-title" style={{ marginTop: 12 }}>Đang tải lịch...</div>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">⏳</div>
              <div className="empty-state-title">Chưa có lịch phù hợp</div>
              <div className="empty-state-text">Các task bật Auto Resolve ở màn tạo issue nhanh sẽ xuất hiện tại đây.</div>
            </div>
          ) : (
            <table className="auto-schedule-table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Tóm tắt</th>
                  <th>Dự án</th>
                  <th>Assignee</th>
                  <th>End Date</th>
                  <th>Estimate</th>
                  <th>Logged</th>
                  <th>Jira status</th>
                  <th>Lịch</th>
                  <th>Cập nhật</th>
                  <th>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map(item => {
                  const issue = issuesByKey[item.key];
                  const summary = issue?.fields.summary || item.summary || "—";
                  const projectKey = issue?.fields.project?.key || item.projectKey || "—";
                  const assignee = issue?.fields.assignee?.displayName || item.assigneeName || "Chưa gán";
                  const endDate = getEndDate(item, issue);
                  const estimateSeconds = getIssueEstimateSeconds(issue, item);
                  const loggedSeconds = getIssueLoggedSeconds(issue);
                  const jiraStatus = issue?.fields.status?.name || "Chưa tải";
                  const issueUrl = `${jiraBaseUrl.replace(/\/$/, "")}/browse/${item.key}`;

                  return (
                    <tr key={item.key}>
                      <td data-label="Key">
                        <a href={issueUrl} target="_blank" rel="noreferrer" className="auto-schedule-key">{item.key}</a>
                      </td>
                      <td data-label="Tóm tắt">
                        <div className="auto-schedule-summary" title={summary}>{summary}</div>
                        {item.lastMessage && <div className="auto-schedule-message">{item.lastMessage}</div>}
                      </td>
                      <td data-label="Dự án">{projectKey}</td>
                      <td data-label="Assignee">{assignee}</td>
                      <td data-label="End Date">{formatDateTime(endDate)}</td>
                      <td data-label="Estimate">{estimateSeconds ? formatSeconds(estimateSeconds) : item.estimate || "—"}</td>
                      <td data-label="Logged">{loggedSeconds ? formatSeconds(loggedSeconds) : "—"}</td>
                      <td data-label="Jira status"><span className="badge badge-todo">{jiraStatus}</span></td>
                      <td data-label="Lịch"><span className={getScheduleBadgeClass(item, issue)}>{getScheduleLabel(item, issue)}</span></td>
                      <td data-label="Cập nhật">{formatDateTime(item.completedAt || item.updatedAt)}</td>
                      <td data-label="Thao tác">
                        <div className="auto-schedule-actions">
                          <a className="btn btn-secondary btn-sm" href={issueUrl} target="_blank" rel="noreferrer">Mở Jira</a>
                          <button className="btn btn-danger btn-sm" onClick={() => removeSchedule(item.key)}>Xóa</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
