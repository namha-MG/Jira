import { useEffect, useState, useCallback } from "react";
import {
  getIssuesByProject, getAllIssuesByJql, getWorklogs, JiraIssue, JiraUser, JiraWorklog, formatSeconds, createSubTask, getIssue, addWorklog, getAssignableUsers, getTransitions, transitionIssue, getJiraFields, generateAiOutput, addComment, uploadAttachment, updateIssueEstimate, updateIssue, getCurrentUser
} from "../jiraService";
import { getDefaultProjectKey, getSelectedJiraProjects } from "../config";
import NotificationBell from "../components/NotificationBell";
import UserSelect from "../components/UserSelect";
import { jobStore } from "../stores/jobStore";

function normalizeText(str?: string) {
  if (!str) return "";
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "d").toLowerCase();
}

function userIdentityKeys(user: JiraUser | null | undefined): string[] {
  if (!user) return [];
  return [user.accountId, user.name, user.emailAddress]
    .filter((value): value is string => !!value)
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

function isWorklogByUser(worklog: JiraWorklog, user: JiraUser | null): boolean {
  if (!user) return true;

  const userKeys = userIdentityKeys(user);
  const authorKeys = userIdentityKeys(worklog.author);
  return userKeys.some(key => authorKeys.includes(key));
}

function isDateInRange(date: Date, range?: { start: Date; end: Date }): boolean {
  const time = date.getTime();
  if (Number.isNaN(time)) return false;
  if (!range) return true;
  return time >= range.start.getTime() && time <= range.end.getTime();
}

function userMatchesFilter(user: JiraUser | null, filter: string): boolean {
  if (!user || filter === "all" || filter === "unassigned") return false;
  return userIdentityKeys(user).includes(filter.trim().toLowerCase());
}

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
  const jiraProjects = getSelectedJiraProjects();
  const projectOptionsKey = jiraProjects.map((project) => project.key).join("|");
  const [selectedProject, setSelectedProject] = useState(() => getDefaultProjectKey());
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);
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

  // Comment states
  const [commentIssueKey, setCommentIssueKey] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [commentFile, setCommentFile] = useState<File | null>(null);
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);

  // Edit Estimate states
  const [estimateModalOpen, setEstimateModalOpen] = useState<{ key: string; summary: string; estimate: string } | null>(null);
  const [newEstimate, setNewEstimate] = useState("");
  const [updatingEstimate, setUpdatingEstimate] = useState(false);

  // Edit Start/End Date states
  const [dateModalOpen, setDateModalOpen] = useState<{ key: string; summary: string; startDate: string; endDate: string } | null>(null);
  const [newStartDate, setNewStartDate] = useState("");
  const [newEndDate, setNewEndDate] = useState("");
  const [updatingDates, setUpdatingDates] = useState(false);

  // Status transition states
  const [statusTransitionModalOpen, setStatusTransitionModalOpen] = useState<JiraIssue | null>(null);
  const [availableTransitions, setAvailableTransitions] = useState<any[]>([]);
  const [selectedTransition, setSelectedTransition] = useState<string>("");
  const [statusTransitionLoading, setStatusTransitionLoading] = useState(false);
  const [statusTransitioning, setStatusTransitioning] = useState(false);
  const [currentUser, setCurrentUser] = useState<JiraUser | null>(null);

  const isConfigured = !!localStorage.getItem("jira_pat") || !!localStorage.getItem("jira_basic");

  useEffect(() => {
    if (!jiraProjects.some((project) => project.key === selectedProject)) {
      setSelectedProject(jiraProjects[0]?.key || "");
    }
  }, [projectOptionsKey, selectedProject]);

  useEffect(() => {
    setStatusFilter([]);
    setAssigneeFilter("all");
    
    // Fetch all assignable users for the selected project
    if (isConfigured) {
      getCurrentUser()
        .then(user => setCurrentUser(user))
        .catch(e => console.warn("Lỗi khi tải user hiện tại", e));

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
      let baseJql = `project = "${selectedProject}"`;
      if (loadScope === "me") {
        baseJql += ` AND assignee = currentUser()`;
      }
      const monthClause = ` AND (updated >= startOfMonth() OR worklogDate >= startOfMonth() OR (cf[10300] >= startOfMonth() AND cf[10300] <= endOfMonth()))`;
      const orderBy = ` ORDER BY updated DESC`;
      let jql = baseJql;
      if (timeRange === "month") {
        jql += monthClause;
      }
      jql += orderBy;

      let result: JiraIssue[];
      try {
        result = await getAllIssuesByJql(jql);
      } catch (err) {
        if (timeRange !== "month") throw err;
        console.warn("Month JQL with Start Date failed, retrying broad project query", err);
        result = await getAllIssuesByJql(`${baseJql}${orderBy}`);
      }

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

      const issuesWithFullWorklogs = [...result];
      const issuesNeedingFullWorklogs = issuesWithFullWorklogs.filter((issue) => {
        const worklog = issue.fields.worklog;
        return worklog && worklog.total > (worklog.worklogs?.length || 0);
      });

      const batchSize = 8;
      for (let i = 0; i < issuesNeedingFullWorklogs.length; i += batchSize) {
        const batch = issuesNeedingFullWorklogs.slice(i, i + batchSize);
        const entries = await Promise.all(batch.map(async (issue) => {
          try {
            const logs = await getWorklogs(issue.key);
            return { key: issue.key, worklogs: logs };
          } catch (e) {
            console.warn(`Lỗi lấy đầy đủ worklog cho ${issue.key}`, e);
            return { key: issue.key, worklogs: issue.fields.worklog?.worklogs || [] };
          }
        }));

        entries.forEach(({ key, worklogs }) => {
          const issueIndex = issuesWithFullWorklogs.findIndex(issue => issue.key === key);
          if (issueIndex < 0) return;

          const issue = issuesWithFullWorklogs[issueIndex];
          issuesWithFullWorklogs[issueIndex] = {
            ...issue,
            fields: {
              ...issue.fields,
              worklog: {
                total: worklogs.length,
                worklogs,
              },
            },
          };
        });
      }

      setIssues(issuesWithFullWorklogs);
      setPage(1); // Reset trang về 1 mỗi khi load lại
    } catch (err: unknown) {
      const e = err as { message?: string };
      setError(e.message || "Lỗi khi tải issues");
    } finally {
      setLoading(false);
    }
  }, [selectedProject, timeRange, loadScope, isConfigured]);

  useEffect(() => { fetchIssues(); }, [fetchIssues]);

  useEffect(() => {
    const unsubscribe = jobStore.on("REFRESH_ISSUES", () => {
      fetchIssues();
      // Optionally could refresh selectedIssue here if we had its key easily, but fetchIssues will at least update the list.
    });
    return unsubscribe;
  }, [fetchIssues]);

  const openDetail = async (issue: JiraIssue) => {
    setSelectedIssue(issue);
    setWorklogs([]);
    setWorklogLoading(true);
    try {
      const logs = await getWorklogs(issue.key);
      setWorklogs(logs);
      
      const fullIssue = await getIssue(issue.key);
      setSelectedIssue(prev => prev?.key === issue.key ? { ...prev, ...fullIssue } : prev);
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

  const getDateInputValue = (dateStr?: string) => {
    if (!dateStr) return "";
    const match = dateStr.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return "";
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  const formatDateForDisplay = (dateStr?: string) => {
    if (!dateStr) return "-";
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleDateString("vi-VN");
  };

  const formatJiraDateField = (dateStr: string, hour: number) => {
    const [year, month, day] = dateStr.split("-").map(Number);
    const date = new Date(year, month - 1, day, hour, 0, 0, 0);
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const offsetHours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
    const offsetMins = String(Math.abs(offset) % 60).padStart(2, "0");
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}T${hh}:00:00.000${sign}${offsetHours}${offsetMins}`;
  };

  const isBugTask = useCallback((type?: string) => {
    if (!type) return false;
    const t = type.toLowerCase();
    return t === "bug in development" || t === "uat bug" || t === "production bug";
  }, []);

  const handleResolveClick = async (issue: JiraIssue) => {
    const status = issue.fields.status.name.toLowerCase();
    
    if (status === "open" || status === "mở") {
      const jobId = jobStore.addJob({ type: "Cập nhật", title: `Chuyển In Progress: ${issue.key}` });
      (async () => {
        try {
          const transitions = await getTransitions(issue.key);
          const toInProgress = transitions.find(t => 
            t.to.name.toLowerCase() === "in progress" || 
            t.to.name.toLowerCase() === "đang thực hiện"
          );
          if (toInProgress) {
            await transitionIssue(issue.key, toInProgress.id);
            jobStore.updateJobStatus(jobId, "success");
            jobStore.emit("REFRESH_ISSUES");
          } else {
            jobStore.updateJobStatus(jobId, "error", `Không tìm thấy transition In Progress cho task ${issue.key}`);
          }
        } catch (e: any) {
          jobStore.updateJobStatus(jobId, "error", e.message || "Lỗi khi chuyển trạng thái");
        }
      })();
    } else if (status === "in progress" || status === "đang thực hiện" || status === "đang làm") {
      setResolveModalOpen(issue as JiraIssue);
      setResolveResolution("10000");
      setResolveOutput("");
      setResolveComment("");
    } else if (status === "fixed" || status === "resolved" || status === "done" || status === "hoàn thành") {
      const jobId = jobStore.addJob({ type: "Cập nhật", title: `Đóng task: ${issue.key}` });
      (async () => {
        try {
          let newTransitions = await getTransitions(issue.key);
          let toCommit = newTransitions.find(t => t.to.name.toLowerCase().includes("commit") || t.name.toLowerCase().includes("commit"));
          if (toCommit) {
            await transitionIssue(issue.key, toCommit.id);
            newTransitions = await getTransitions(issue.key);
          }
          
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
          jobStore.updateJobStatus(jobId, "success");
          jobStore.emit("REFRESH_ISSUES");
        } catch (e: any) {
          jobStore.updateJobStatus(jobId, "error", e.message || "Lỗi khi chuyển trạng thái");
        }
      })();
    } else {
      alert("Tính năng này chỉ hỗ trợ chuyển từ Open -> In Progress -> Fixed -> Commit -> Closed");
    }
  };

  const handleCommentSubmit = async () => {
    if (!commentIssueKey) return;
    if (!commentText.trim() && !commentFile) {
      alert("Vui lòng nhập nội dung comment hoặc chọn ảnh.");
      return;
    }
    
    const issueKey = commentIssueKey;
    const text = commentText;
    const file = commentFile;
    
    setCommentIssueKey(null);
    setCommentText("");
    setCommentFile(null);
    const jobId = jobStore.addJob({ type: "Bình luận", title: `Thêm comment cho ${issueKey}` });

    (async () => {
      try {
        let finalCommentText = text;
        
        if (file) {
          const uploadRes = await uploadAttachment(issueKey, file);
          const filename = uploadRes && uploadRes.length > 0 && uploadRes[0].filename 
                           ? uploadRes[0].filename 
                           : file.name;
          finalCommentText += `\n\n!${filename}!`;
        }
        
        await addComment(issueKey, finalCommentText);
        jobStore.updateJobStatus(jobId, "success");
        jobStore.emit("REFRESH_ISSUES");
      } catch (e: any) {
        console.error("Failed to add comment:", e);
        jobStore.updateJobStatus(jobId, "error", e.response?.data?.errorMessages?.[0] || e.message);
      }
    })();
  };

  const handleEstimateSubmit = async () => {
    if (!estimateModalOpen) return;
    const issueKey = estimateModalOpen.key;
    const estimateValue = newEstimate;
    setEstimateModalOpen(null);
    const jobId = jobStore.addJob({ type: "Cập nhật", title: `Sửa estimate cho ${issueKey}` });

    (async () => {
      try {
        await updateIssueEstimate(issueKey, estimateValue);
        jobStore.updateJobStatus(jobId, "success");
        jobStore.emit("REFRESH_ISSUES");
      } catch (e: any) {
        jobStore.updateJobStatus(jobId, "error", e.response?.data?.errorMessages?.[0] || e.message);
      }
    })();
  };

  const handleDateSubmit = async () => {
    if (!dateModalOpen) return;
    const issueKey = dateModalOpen.key;
    const startValue = newStartDate;
    const endValue = newEndDate;

    if (startValue && endValue && new Date(endValue).getTime() < new Date(startValue).getTime()) {
      alert("End Date không được trước Start Date.");
      return;
    }

    setUpdatingDates(true);
    const jobId = jobStore.addJob({ type: "Cập nhật", title: `Sửa Start/End Date cho ${issueKey}` });

    try {
      await updateIssue(issueKey, {
        fields: {
          customfield_10300: startValue ? formatJiraDateField(startValue, 8) : null,
          customfield_10302: endValue ? formatJiraDateField(endValue, 17) : null,
        },
      });
      jobStore.updateJobStatus(jobId, "success");
      setDateModalOpen(null);
      jobStore.emit("REFRESH_ISSUES");
    } catch (e: any) {
      jobStore.updateJobStatus(jobId, "error", e.response?.data?.errorMessages?.[0] || e.message);
    } finally {
      setUpdatingDates(false);
    }
  };

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  const loggedRange = timeRange === "month" ? { start: startOfMonth, end: endOfMonth } : undefined;
  const shouldUseCurrentUserWorklogs =
    loadScope === "me" ||
    userMatchesFilter(currentUser, assigneeFilter);
  const worklogUserForView = shouldUseCurrentUserWorklogs ? currentUser : null;
  const getLoggedForIssue = (issue: JiraIssue) => {
    const worklogTotal = issue.fields.worklog?.worklogs?.reduce((sum, wl) => sum + (wl.timeSpentSeconds || 0), 0) || 0;
    return issue.fields.aggregatetimespent ?? issue.fields.timetracking?.timeSpentSeconds ?? worklogTotal;
  };

  // Filter + sort
  const filtered = issues
    .filter((i) => {
      const search = normalizeText(searchText);
      const matchText = !searchText || 
        normalizeText(i.key).includes(search) || 
        normalizeText(i.fields.summary).includes(search) ||
        (i.fields.assignee && normalizeText(i.fields.assignee.displayName).includes(search));
        
      const matchStatus = statusFilter.length === 0 || statusFilter.includes(i.fields.status.name);
      
      let matchTime = true;
      if (timeRange === "month") {
        const updatedDate = new Date(i.fields.updated);
        const startDate = i.fields.customfield_10300 ? new Date(i.fields.customfield_10300) : null;
        const hasStartDateThisMonth = !!startDate && isDateInRange(startDate, loggedRange);
        const hasWorklogThisMonth = i.fields.worklog?.worklogs?.some(
          (wl) => isWorklogByUser(wl, worklogUserForView) && isDateInRange(new Date(wl.started), loggedRange)
        );
        matchTime = isDateInRange(updatedDate, loggedRange) || hasStartDateThisMonth || !!hasWorklogThisMonth;
      }

      const matchAssignee = assigneeFilter === "all" ||
        (assigneeFilter === "unassigned" && !i.fields.assignee) ||
        userIdentityKeys(i.fields.assignee).includes(assigneeFilter.trim().toLowerCase());

      let matchAdvanced = true;
      if (advancedFilter !== "all") {
        const statusName = i.fields.status.name.toLowerCase();
        const isDone = statusName === "done" || statusName === "resolved" || statusName === "closed" || statusName === "hoàn thành" || statusName === "đã giải quyết";
        const log = getLoggedForIssue(i);
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

      const matchType = typeFilter.length === 0 || (i.fields.issuetype?.name && typeFilter.includes(i.fields.issuetype.name));

      return matchText && matchStatus && matchTime && matchAssignee && matchAdvanced && matchType;
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
        va = getLoggedForIssue(a);
        vb = getLoggedForIssue(b);
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
  const uniqueTypes = [...new Set(issues.map((i) => i.fields.issuetype?.name).filter(Boolean))];
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
        <div className="page-actions" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <NotificationBell />
          <button id="btn-refresh-issues" className="btn btn-secondary btn-sm" onClick={fetchIssues} disabled={loading}>
            <span className={loading ? "spinning" : ""}>🔄</span> {loading ? "Đang tải..." : "Refresh"}
          </button>
        </div>
      </div>

      <div className="page-body">
        {/* Filters */}
        <div className="filter-bar issues-filter-bar" style={{ flexWrap: "wrap", gap: 12 }}>
          {/* Project tabs */}
          <div className="project-tab-list" style={{ display: "flex", gap: 4 }}>
            {jiraProjects.map((p) => (
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
          <div className="segmented-control" style={{ display: "flex", gap: 4, background: "rgba(255,255,255,0.03)", padding: 3, borderRadius: 8, border: "1px solid var(--border)" }}>
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
          <div className="segmented-control" style={{ display: "flex", gap: 4, background: "rgba(255,255,255,0.03)", padding: 3, borderRadius: 8, border: "1px solid var(--border)" }}>
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

          <div className="issues-filter-controls" style={{ flex: 1, display: "flex", gap: 8, minWidth: 200, marginLeft: "auto" }}>
            <input
              id="input-search-issues"
              type="text"
              placeholder="🔍  Tìm kiếm issue..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              style={{ flex: 1, minWidth: 120 }}
            />
            <div className="filter-field filter-status-field" style={{ position: "relative", width: 170 }}>
              <div
                id="select-status-filter"
                onClick={() => setStatusDropdownOpen(!statusDropdownOpen)}
                style={{
                  width: "100%", padding: "8px 12px", borderRadius: 6, background: "var(--bg-primary)",
                  border: `1px solid ${statusFilter.length > 0 ? "var(--accent-blue)" : "var(--border)"}`,
                  cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center",
                  fontSize: 13, height: "100%", userSelect: "none",
                  color: statusFilter.length > 0 ? "var(--accent-blue)" : "var(--text-primary)"
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {statusFilter.length === 0 ? "Tất cả status" : `${statusFilter.length} status đã chọn`}
                </span>
                <span style={{ fontSize: 10, marginLeft: 4, opacity: 0.7 }}>{statusDropdownOpen ? "▲" : "▼"}</span>
              </div>
              {statusDropdownOpen && (
                <div style={{
                  position: "absolute", top: "calc(100% + 4px)", left: 0, minWidth: "100%",
                  background: "var(--bg-elevated, var(--bg-secondary))",
                  border: "1px solid var(--border)", borderRadius: 8, zIndex: 110,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.4)", overflow: "hidden"
                }}>
                  <div style={{ display: "flex", gap: 6, padding: "8px 8px 4px", borderBottom: "1px solid var(--border)" }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ flex: 1, minHeight: 26, padding: "4px 8px" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setStatusFilter(uniqueStatuses);
                      }}
                    >
                      Chọn tất cả
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ flex: 1, minHeight: 26, padding: "4px 8px" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setStatusFilter([]);
                      }}
                    >
                      Bỏ chọn
                    </button>
                  </div>
                  <div style={{ padding: "6px 4px", maxHeight: 240, overflowY: "auto" }}>
                    {uniqueStatuses.map((s) => {
                      const checked = statusFilter.includes(s);
                      return (
                        <label
                          key={s}
                          style={{
                            display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
                            cursor: "pointer", fontSize: 12, color: "var(--text-primary)",
                            borderRadius: 4, background: checked ? "rgba(79, 142, 247, 0.12)" : "transparent",
                            marginBottom: 2
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setStatusFilter(prev => e.target.checked ? [...prev, s] : prev.filter(item => item !== s));
                            }}
                            style={{ margin: 0 }}
                          />
                          <span>{s}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            <div className="filter-field filter-type-field" style={{ position: "relative", width: 180 }}>
              <div 
                onClick={() => setTypeDropdownOpen(!typeDropdownOpen)}
                style={{ 
                  width: "100%", padding: "8px 12px", borderRadius: 6, background: "var(--bg-primary)", 
                  border: `1px solid ${typeFilter.length > 0 ? "var(--accent-blue)" : "var(--border)"}`,
                  cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center",
                  fontSize: 13, height: "100%", userSelect: "none",
                  color: typeFilter.length > 0 ? "var(--accent-blue)" : "var(--text-primary)"
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {typeFilter.length === 0 ? "Tất cả loại task" : `${typeFilter.length} loại đã chọn`}
                </span>
                <span style={{ fontSize: 10, marginLeft: 4, opacity: 0.7 }}>{typeDropdownOpen ? "▲" : "▼"}</span>
              </div>
              {typeDropdownOpen && (
                <div style={{ 
                  position: "absolute", top: "calc(100% + 4px)", left: 0, minWidth: "100%", 
                  background: "var(--bg-elevated, var(--bg-secondary))", 
                  border: "1px solid var(--border)", borderRadius: 8, zIndex: 100, 
                  boxShadow: "0 8px 24px rgba(0,0,0,0.4)", overflow: "hidden"
                }}>
                  <div style={{ padding: "6px 4px", maxHeight: 240, overflowY: "auto" }}>
                    {uniqueTypes.map((t) => {
                      const checked = typeFilter.includes(t as string);
                      return (
                        <div
                          key={t as string}
                          onClick={() => {
                            if (checked) {
                              setTypeFilter(typeFilter.filter(item => item !== t));
                            } else {
                              setTypeFilter([...typeFilter, t as string]);
                            }
                          }}
                          style={{ 
                            display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 13,
                            padding: "7px 10px", borderRadius: 6, transition: "background 0.15s",
                            background: checked ? "rgba(79,142,247,0.12)" : "transparent",
                            color: checked ? "var(--accent-blue)" : "var(--text-primary)"
                          }}
                          onMouseEnter={(e) => { if (!checked) e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = checked ? "rgba(79,142,247,0.12)" : "transparent"; }}
                        >
                          <div style={{
                            width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                            border: `2px solid ${checked ? "var(--accent-blue)" : "var(--border)"}`,
                            background: checked ? "var(--accent-blue)" : "transparent",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            transition: "all 0.15s"
                          }}>
                            {checked && <span style={{ color: "#fff", fontSize: 10, lineHeight: 1 }}>✓</span>}
                          </div>
                          <span style={{ whiteSpace: "nowrap" }}>{t as string}</span>
                        </div>
                      );
                    })}
                  </div>
                  {uniqueTypes.length > 0 && (
                    <div style={{ padding: "8px 10px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", gap: 8, background: "rgba(0,0,0,0.1)" }}>
                      <button 
                        className="btn btn-ghost btn-sm" 
                        style={{ fontSize: 11, padding: "4px 8px", flex: 1, opacity: typeFilter.length === 0 ? 0.4 : 1 }} 
                        onClick={(e) => { e.stopPropagation(); setTypeFilter([]); }}
                      >
                        Bỏ chọn tất cả
                      </button>
                      <button 
                        className="btn btn-primary btn-sm" 
                        style={{ fontSize: 11, padding: "4px 8px", flex: 1 }} 
                        onClick={(e) => { e.stopPropagation(); setTypeDropdownOpen(false); }}
                      >
                        Xong
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="filter-field filter-assignee-field" style={{ width: 150 }}>
              <UserSelect
                users={[
                  { accountId: "all", displayName: "Tất cả Assignee", name: "all" } as JiraUser,
                  { accountId: "unassigned", displayName: "Chưa phân công", name: "unassigned" } as JiraUser,
                  ...uniqueAssignees
                ]}
                value={assigneeFilter}
                onChange={setAssigneeFilter}
                placeholder="-- Assignee --"
              />
            </div>
            <select
              className="filter-field"
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
        {(() => {
          const totalFilteredLoggedSeconds = filtered.reduce((sum, issue) => {
            return sum + getLoggedForIssue(issue);
          }, 0);
          const totalFilteredLoggedHours = (totalFilteredLoggedSeconds / 3600).toFixed(1);
          const issueTableLabels = ["Key", "Tóm tắt", "Người xử lý", "Trạng thái", "Loại", "Start - End", "Estimate", "Logged", "Tiến độ", "Cập nhật", "Hành động"];

          return (
            <div className="table-wrap">
              <table className="issues-table">
                <thead>
                  <tr>
                    <th onClick={() => handleSort("key")} style={{ cursor: "pointer" }}>Key{sortIndicator("key")}</th>
                    <th>Tóm tắt</th>
                    <th>Người xử lý</th>
                    <th>Trạng thái</th>
                    <th>Loại</th>
                    <th onClick={() => handleSort("startDate")} style={{ cursor: "pointer" }}>Start - End{sortIndicator("startDate")}</th>
                    <th onClick={() => handleSort("estimate")} style={{ cursor: "pointer" }}>Estimate{sortIndicator("estimate")}</th>
                    <th onClick={() => handleSort("logged")} style={{ cursor: "pointer" }}>Logged ({totalFilteredLoggedHours}h){sortIndicator("logged")}</th>
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
                      <td key={j} data-label={issueTableLabels[j]}><div className="skeleton" style={{ height: 16, borderRadius: 4 }} /></td>
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
                  const log = getLoggedForIssue(issue);
                  const pct = est > 0 ? Math.round((log / est) * 100) : (log > 0 ? 100 : 0);
                  const updatedDate = new Date(issue.fields.updated).toLocaleDateString("vi-VN");
                  const startDateStr = formatDateForDisplay(issue.fields.customfield_10300);
                  const endDateStr = formatDateForDisplay(issue.fields.customfield_10302 || issue.fields.duedate);

                  return (
                    <tr key={issue.id}>
                      <td data-label="Key">
                        <a
                          href={`https://20.84.97.109:3033/browse/${issue.key}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: "var(--accent-blue-light)", fontWeight: 700, textDecoration: "none", fontSize: 12 }}
                        >
                          {issue.key}
                        </a>
                      </td>
                      <td data-label="Tóm tắt" style={{ maxWidth: 280 }}>
                        <div title={issue.fields.summary} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-primary)", fontSize: 13 }}>
                          {issue.fields.summary}
                        </div>
                      </td>
                      <td data-label="Người xử lý">
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
                      <td data-label="Trạng thái">
                        <span className={getBadgeClass(issue.fields.status.name)}>
                          {issue.fields.status.name}
                        </span>
                      </td>
                      <td data-label="Loại" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {issue.fields.issuetype?.name || "—"}
                      </td>
                      <td data-label="Start - End" style={{ fontSize: 11, color: "var(--text-primary)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <span style={{ whiteSpace: "nowrap" }}>{startDateStr} - {endDateStr}</span>
                          <button
                            className="btn btn-ghost btn-sm"
                            style={{ padding: "0 4px", height: 20, fontSize: 11, minHeight: 20 }}
                            onClick={() => {
                              setDateModalOpen({
                                key: issue.key,
                                summary: issue.fields.summary,
                                startDate: getDateInputValue(issue.fields.customfield_10300),
                                endDate: getDateInputValue(issue.fields.customfield_10302 || issue.fields.duedate),
                              });
                              setNewStartDate(getDateInputValue(issue.fields.customfield_10300));
                              setNewEndDate(getDateInputValue(issue.fields.customfield_10302 || issue.fields.duedate));
                            }}
                            title="Sửa Start/End Date"
                          >
                            ✏️
                          </button>
                        </div>
                      </td>
                      <td data-label="Estimate" style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 500 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          {est ? formatSeconds(est) : <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>—</span>}
                          <button 
                            className="btn btn-ghost btn-sm" 
                            style={{ padding: "0 4px", height: 20, fontSize: 11, minHeight: 20 }}
                            onClick={() => {
                              setEstimateModalOpen({ key: issue.key, summary: issue.fields.summary, estimate: est ? formatSeconds(est) : "" });
                              setNewEstimate(est ? formatSeconds(est) : "");
                            }}
                            title="Sửa Estimate"
                          >
                            ✏️
                          </button>
                        </div>
                      </td>
                      <td data-label="Logged" style={{ fontSize: 12, color: "var(--accent-green)", fontWeight: 700 }}>
                        {log ? formatSeconds(log) : <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>—</span>}
                      </td>
                      <td data-label="Tiến độ" style={{ width: 100 }}>
                        {est > 0 ? (
                          <div>
                            <div style={{ fontSize: 10, color: pct > 100 ? "var(--accent-red)" : "var(--text-muted)", marginBottom: 3 }}>{pct}%</div>
                            <div className="progress-bar-wrap">
                              <div className={`progress-bar-fill ${getProgressClass(pct)}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                            </div>
                          </div>
                        ) : <span style={{ color: "var(--text-muted)", fontSize: 11 }}>—</span>}
                      </td>
                      <td data-label="Cập nhật" style={{ fontSize: 11, color: "var(--text-muted)" }}>{updatedDate}</td>
                      <td data-label="Hành động" className="issues-actions-cell">
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ padding: "4px 8px", fontSize: 14 }}
                          onClick={() => setCommentIssueKey(issue.key)}
                          title="Thêm Comment"
                        >
                          💬
                        </button>
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
                        {log === 0 && (
                          <button
                            className="btn btn-ghost btn-sm"
                            style={{ color: "var(--accent-green)", marginLeft: 4 }}
                            onClick={() => {
                              setLogWorkModalOpen({ key: issue.key, summary: issue.fields.summary });
                              setLogWorkTime("");
                              setLogWorkComment("");
                            }}
                            title="Log Work"
                          >
                            ⏱️ Log Work
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
                        {!isBugTask(issue.fields.issuetype?.name) && (
                            <button
                              className="btn btn-ghost btn-sm"
                              style={{ color: "var(--accent-orange)", marginLeft: 4 }}
                              onClick={async () => {
                                setStatusTransitionModalOpen(issue);
                                setStatusTransitionLoading(true);
                                try {
                                  const transitions = await getTransitions(issue.key);
                                  setAvailableTransitions(transitions);
                                  if (transitions.length > 0) {
                                    setSelectedTransition(transitions[0].id);
                                  } else {
                                    setSelectedTransition("");
                                  }
                                } catch (e) {
                                  alert("Không thể tải danh sách status");
                                } finally {
                                  setStatusTransitionLoading(false);
                                }
                              }}
                              title="Đổi Status"
                            >
                              🔄 Status
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
        );
      })()}

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

            {/* Description for Bug tasks */}
            {isBugTask(selectedIssue.fields.issuetype?.name) && (
              <div style={{ marginBottom: 16, background: "var(--bg-card)", padding: 16, borderRadius: 8, border: "1px solid var(--border)" }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: "var(--text-primary)" }}>
                  📝 Mô tả chi tiết
                </div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                  {selectedIssue.fields.description || <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>Không có mô tả</span>}
                </div>
                {selectedIssue.fields.attachment && selectedIssue.fields.attachment.length > 0 && (
                  <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {selectedIssue.fields.attachment.map((att: any) => {
                      const isImage = att.mimeType && att.mimeType.startsWith("image/");
                      return isImage ? (
                        <a key={att.id} href={att.content} target="_blank" rel="noreferrer" style={{ display: "block", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
                          <img src={att.thumbnail || att.content} alt={att.filename} style={{ height: 80, objectFit: "cover", display: "block" }} title={att.filename} />
                        </a>
                      ) : (
                        <a key={att.id} href={att.content} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm" style={{ padding: "4px 8px", border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--text-primary)", fontSize: 11 }}>
                          📎 {att.filename}
                        </a>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

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
                        style={{ padding: "2px 8px", fontSize: 11 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setCommentIssueKey(st.key);
                        }}
                        title="Thêm Comment"
                      >
                        💬
                      </button>

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

            {/* Hoạt động & Bình luận */}
            <div style={{ marginTop: 24 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, color: "var(--text-primary)" }}>
                🕒 Lịch sử & Bình luận
              </div>
              {worklogLoading ? (
                 <div style={{ fontSize: 13, color: "var(--text-muted)", textAlign: "center", padding: "16px 0" }}>Đang tải...</div>
              ) : (
                <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
                  {(() => {
                    const items: any[] = [];
                    if (selectedIssue.fields.comment?.comments) {
                      selectedIssue.fields.comment.comments.forEach((c) => {
                        items.push({ type: "comment", id: c.id, author: c.author, created: c.created, body: c.body });
                      });
                    }
                    if (selectedIssue.changelog?.histories) {
                      selectedIssue.changelog.histories.forEach((h) => {
                        items.push({ type: "history", id: h.id, author: h.author, created: h.created, items: h.items });
                      });
                    }
                    
                    items.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
                    
                    if (items.length === 0) {
                      return <div style={{ fontSize: 13, color: "var(--text-muted)", textAlign: "center", padding: "16px 0" }}>Chưa có hoạt động nào</div>;
                    }

                    return items.map(item => (
                      <div key={`${item.type}-${item.id}`} style={{ padding: "12px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-card)" }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                          {item.author?.avatarUrls?.["48x48"] ? (
                            <img src={item.author.avatarUrls["48x48"]} alt="" style={{ width: 24, height: 24, borderRadius: "50%" }} />
                          ) : (
                            <div style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--border)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>
                              {(item.author?.displayName || item.author?.name || "?").charAt(0)}
                            </div>
                          )}
                          <div style={{ fontSize: 13, display: "flex", flexWrap: "wrap", alignItems: "center" }}>
                            <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{item.author?.displayName || item.author?.name || "Unknown"}</span>
                            <span style={{ color: "var(--text-secondary)", marginLeft: 4, fontSize: 12 }}>
                              {item.type === "comment" ? "đã bình luận" : "made changes"} - {new Date(item.created).toLocaleString("vi-VN")}
                            </span>
                          </div>
                        </div>
                        
                        <div style={{ paddingLeft: 32 }}>
                          {item.type === "comment" ? (
                            <div style={{ fontSize: 13, color: "var(--text-primary)", whiteSpace: "pre-wrap" }}>{item.body}</div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                              {item.items.map((ch: any, idx: number) => (
                                <div key={idx} style={{ fontSize: 13, display: "flex", alignItems: "flex-start", flexWrap: "wrap", gap: 6 }}>
                                  <span style={{ color: "var(--text-secondary)", minWidth: 100 }}>{ch.field}</span>
                                  {ch.fromString && <span style={{ textDecoration: "line-through", color: "var(--text-muted)", background: "rgba(255,255,255,0.05)", padding: "0 4px", borderRadius: 4 }}>{ch.fromString}</span>}
                                  {ch.fromString && <span style={{ color: "var(--text-secondary)" }}>➔</span>}
                                  <span style={{ color: "var(--text-primary)", fontWeight: 500, background: "rgba(255,255,255,0.05)", padding: "0 4px", borderRadius: 4 }}>{ch.toString || "trống"}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ));
                  })()}
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
                  
                  const parentKey = subTaskModalOpen.key;
                  const projectKey = subTaskModalOpen.fields.project.key;
                  setSubTaskModalOpen(null);
                  const jobId = jobStore.addJob({ type: "Tạo Task", title: `Tạo ${validTasks.length} sub-tasks cho ${parentKey}` });
                  
                  (async () => {
                    try {
                      for (const st of validTasks) {
                        await createSubTask({
                          parentKey,
                          projectKey,
                          summary: st.summary.trim(),
                          originalEstimate: st.estimate.trim() || undefined,
                          assigneeName: st.assigneeName || undefined
                        });
                      }
                      jobStore.updateJobStatus(jobId, "success");
                      jobStore.emit("REFRESH_ISSUES");
                    } catch (e: any) {
                      let msg = e.message || "Unknown error";
                      if (e.response?.data?.errorMessages?.length) {
                        msg = e.response.data.errorMessages[0];
                      } else if (e.response?.data?.errors) {
                        msg = Object.values(e.response.data.errors).join(", ");
                      }
                      jobStore.updateJobStatus(jobId, "error", msg);
                    }
                  })();
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
                      alert("Định dạng thời gian không đúng. VD: 2h, 30m");
                      return;
                    }

                    const issueKey = logWorkModalOpen.key;
                    const issueSummary = logWorkModalOpen.summary;
                    const commentInput = logWorkComment.trim();
                    setLogWorkModalOpen(null);
                    
                    const jobId = jobStore.addJob({ type: "Log Work", title: `Log work ${logWorkTime} cho ${issueKey}` });

                    (async () => {
                      try {
                        let finalComment = commentInput;
                        if (!finalComment) {
                          const geminiKey = localStorage.getItem("gemini_api_key");
                          if (geminiKey) {
                            try {
                              const prompt = `Bạn là một kỹ sư phần mềm chuyên nghiệp. Hãy viết 1 câu ngắn gọn (dưới 15 từ) ghi chú lại công việc đã thực hiện cho task Jira có tiêu đề: "${issueSummary}". Ví dụ: "Đã hoàn thành tối ưu hóa truy vấn SQL và sửa lỗi bộ lọc". Viết bằng tiếng Việt, trực tiếp, bắt đầu bằng từ hành động như "Hoàn thành...", "Cải tiến...", "Tối ưu...", "Sửa lỗi...", không dài dòng, không có phần giới thiệu, không thêm bất kỳ định dạng markdown hay dấu ngoặc kép nào xung quanh.`;
                              const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
                              });
                              if (response.ok) {
                                const data = await response.json();
                                finalComment = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
                              }
                            } catch (e) {
                              console.warn("Auto AI generation failed", e);
                            }
                          }
                          if (!finalComment) {
                            finalComment = `Thực hiện công việc: ${issueSummary}`;
                          }
                        }

                        await addWorklog(issueKey, {
                          timeSpentSeconds: totalSeconds,
                          comment: finalComment,
                        });
                        
                        jobStore.updateJobStatus(jobId, "success");
                        jobStore.emit("REFRESH_ISSUES");
                      } catch (e: any) {
                        jobStore.updateJobStatus(jobId, "error", e.message || "Unknown error");
                      }
                    })();
                  } catch (e: any) {
                    alert("Lỗi khi log work: " + (e.message || "Unknown error"));
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
                  const issueKey = resolveModalOpen.key;
                  const issueSummary = resolveModalOpen.fields.summary;
                  const resolution = resolveResolution;
                  const output = resolveOutput;
                  const comment = resolveComment;
                  setResolveModalOpen(null);
                  
                  const jobId = jobStore.addJob({ type: "Cập nhật", title: `Fixed bug ${issueKey}` });

                  (async () => {
                    try {
                      // Lấy transition Fixed
                      const transitions = await getTransitions(issueKey);
                      const toFixed = transitions.find(t => t.to.name.toLowerCase() === "fixed" || t.to.name.toLowerCase() === "resolved" || t.to.name.toLowerCase() === "done");
                      
                      if (toFixed) {
                        // Tìm ID của custom field Output
                        const allFields = await getJiraFields();
                        const outputField = allFields.find(f => f.name.toLowerCase() === "output" || f.name.toLowerCase() === "out put");
                        const outputFieldId = outputField ? outputField.id : "customfield_10000"; // fallback

                        const transitionFields: any = {
                          resolution: { id: resolution }
                        };
                        
                        let finalOutput = output.trim();
                        if (!finalOutput) {
                           finalOutput = await generateAiOutput(issueSummary);
                        }
                        if (!finalOutput) {
                          finalOutput = `Đã hoàn thành: ${issueSummary}`;
                        }

                        if (outputFieldId) {
                          transitionFields[outputFieldId] = finalOutput;
                        }

                        try {
                          await transitionIssue(issueKey, toFixed.id, transitionFields, comment.trim() || undefined);
                        } catch (transitionErr: any) {
                          const errors = transitionErr.response?.data?.errors || {};
                          const hasScreenError = Object.values(errors).some((msg: any) => typeof msg === 'string' && msg.includes("appropriate screen"));
                          if (hasScreenError) {
                            await transitionIssue(issueKey, toFixed.id, undefined, comment.trim() || undefined);
                            if (outputFieldId) {
                              try {
                                await updateIssue(issueKey, {
                                  fields: { [outputFieldId]: finalOutput }
                                });
                              } catch (putErr) {
                                console.warn("Could not PUT output field", putErr);
                              }
                            }
                          } else {
                            throw transitionErr;
                          }
                        }
                      }
                      
                      let newTransitions = await getTransitions(issueKey);
                      const isBug = true; // Modal is only opened for bugs
                      if (isBug) {
                        let toCommit = newTransitions.find(t => t.to.name.toLowerCase().includes("commit") || t.name.toLowerCase().includes("commit"));
                        if (toCommit) {
                          await transitionIssue(issueKey, toCommit.id);
                          newTransitions = await getTransitions(issueKey);
                        }
                      }
                      
                      let toClosed = newTransitions.find(t => t.to.name.toLowerCase() === "closed" || t.to.name.toLowerCase() === "đóng" || t.name.toLowerCase().includes("close"));
                      if (toClosed) {
                        await transitionIssue(issueKey, toClosed.id);
                      }
                      
                      jobStore.updateJobStatus(jobId, "success");
                      jobStore.emit("REFRESH_ISSUES");
                    } catch (e: any) {
                      jobStore.updateJobStatus(jobId, "error", e.message || "Unknown error");
                    }
                  })();
                }}
              >
                {resolvingIssue ? "Đang xử lý..." : "Fixed"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Comment Modal */}
      {commentIssueKey && (
        <div className="modal-overlay" onClick={() => { setCommentIssueKey(null); setCommentText(""); setCommentFile(null); }}>
          <div className="modal" style={{ maxWidth: 500 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">Thêm Comment - {commentIssueKey}</div>
              <button className="modal-close" onClick={() => { setCommentIssueKey(null); setCommentText(""); setCommentFile(null); }}>✕</button>
            </div>
            
            <div className="form-group">
              <label>Nội dung Comment</label>
              <textarea 
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                rows={4}
                placeholder="Nhập nội dung..."
                style={{ width: "100%", fontFamily: "inherit" }}
              />
            </div>
            
            <div className="form-group">
              <label>Đính kèm ảnh (Tùy chọn)</label>
              <input 
                type="file" 
                accept="image/*"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    setCommentFile(e.target.files[0]);
                  } else {
                    setCommentFile(null);
                  }
                }}
              />
              {commentFile && <div style={{ fontSize: 12, marginTop: 4, color: "var(--accent-green)" }}>Đã chọn: {commentFile.name}</div>}
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => { setCommentIssueKey(null); setCommentText(""); setCommentFile(null); }}>Hủy</button>
              <button onClick={handleCommentSubmit} className="btn btn-primary">
                Gửi Comment
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Estimate Modal */}
      {estimateModalOpen && (
        <div className="modal-overlay" onClick={() => setEstimateModalOpen(null)}>
          <div className="modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">Cập nhật Estimate - {estimateModalOpen.key}</div>
              <button className="modal-close" onClick={() => setEstimateModalOpen(null)}>✕</button>
            </div>
            <div className="form-group">
              <label>Estimate hiện tại: {estimateModalOpen.estimate || "Trống"}</label>
              <input
                type="text"
                value={newEstimate}
                onChange={(e) => setNewEstimate(e.target.value)}
                placeholder="VD: 2h, 30m, 1d"
                autoFocus
              />
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setEstimateModalOpen(null)}>Hủy</button>
              <button
                className="btn btn-primary"
                disabled={!newEstimate.trim()}
                onClick={handleEstimateSubmit}
              >
                Lưu Estimate
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Start/End Date Modal */}
      {dateModalOpen && (
        <div className="modal-overlay" onClick={() => !updatingDates && setDateModalOpen(null)}>
          <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">Cập nhật Start/End Date - {dateModalOpen.key}</div>
              <button className="modal-close" onClick={() => !updatingDates && setDateModalOpen(null)}>✕</button>
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16, lineHeight: 1.45 }}>
              {dateModalOpen.summary}
            </div>
            <div className="form-group">
              <label>Start Date</label>
              <input
                type="date"
                value={newStartDate}
                onChange={(e) => setNewStartDate(e.target.value)}
                disabled={updatingDates}
              />
            </div>
            <div className="form-group">
              <label>End Date</label>
              <input
                type="date"
                value={newEndDate}
                onChange={(e) => setNewEndDate(e.target.value)}
                disabled={updatingDates}
              />
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setDateModalOpen(null)} disabled={updatingDates}>Hủy</button>
              <button
                className="btn btn-primary"
                disabled={updatingDates}
                onClick={handleDateSubmit}
              >
                {updatingDates ? "Đang lưu..." : "Lưu ngày"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Change Status Modal */}
      {statusTransitionModalOpen && (
        <div className="modal-overlay" onClick={() => !statusTransitioning && setStatusTransitionModalOpen(null)}>
          <div className="modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">Đổi Status - {statusTransitionModalOpen.key}</div>
              <button className="modal-close" onClick={() => !statusTransitioning && setStatusTransitionModalOpen(null)}>✕</button>
            </div>
            
            <div className="form-group">
              <label>Chọn Status Mới *</label>
              {statusTransitionLoading ? (
                <div style={{ padding: 8, color: "var(--text-muted)", fontSize: 13 }}>Đang tải danh sách status...</div>
              ) : availableTransitions.length === 0 ? (
                <div style={{ padding: 8, color: "var(--accent-red)", fontSize: 13 }}>Không có status nào khả dụng để chuyển lúc này.</div>
              ) : (
                <select 
                  value={selectedTransition} 
                  onChange={e => setSelectedTransition(e.target.value)}
                  disabled={statusTransitioning}
                  required
                >
                  <option value="" disabled>-- Chọn status --</option>
                  {availableTransitions.map(t => (
                    <option key={t.id} value={t.id}>{t.name} ➔ {t.to.name}</option>
                  ))}
                </select>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setStatusTransitionModalOpen(null)} disabled={statusTransitioning}>Hủy</button>
              <button
                className="btn btn-primary"
                disabled={statusTransitioning || statusTransitionLoading || !selectedTransition || availableTransitions.length === 0}
                onClick={() => {
                  const issueKey = statusTransitionModalOpen.key;
                  const transitionId = selectedTransition;
                  setStatusTransitionModalOpen(null);
                  const jobId = jobStore.addJob({ type: "Cập nhật", title: `Đổi status: ${issueKey}` });
                  (async () => {
                    try {
                      await transitionIssue(issueKey, transitionId);
                      jobStore.updateJobStatus(jobId, "success");
                      jobStore.emit("REFRESH_ISSUES");
                    } catch (e: any) {
                      jobStore.updateJobStatus(jobId, "error", e.message || "Unknown error");
                    }
                  })();
                }}
              >
                {statusTransitioning ? "Đang xử lý..." : "Chuyển"}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
