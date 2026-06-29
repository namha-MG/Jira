import { useEffect, useState, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";
import {
  getMyIssues, JiraIssue, formatSeconds, getTransitions, transitionIssue, getJiraFields, generateAiOutput, addComment, uploadAttachment, getCurrentUser, getAllIssuesByJql, JiraUser
} from "../jiraService";
import { JIRA_PROJECTS } from "../config";
import NotificationBell from "../components/NotificationBell";
import { getHolidays } from "../utils";

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

function getIssueLoggedSeconds(issue: JiraIssue): number {
  return issue.fields.aggregatetimespent ?? (issue.fields.timetracking?.timeSpentSeconds || 0);
}

function getIssueEstimatedSeconds(issue: JiraIssue): number {
  return issue.fields.aggregatetimeoriginalestimate ?? (issue.fields.timetracking?.originalEstimateSeconds || 0);
}

export default function Dashboard() {
  const [currentUser, setCurrentUser] = useState<JiraUser | null>(null);
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [timeRange, setTimeRange] = useState<"month" | "prevMonth" | "all">("month");
  const [otHours, setOtHours] = useState<number>(() => Number(localStorage.getItem("dashboard_ot")) || 0);
  const [leaveHours, setLeaveHours] = useState<number>(() => Number(localStorage.getItem("dashboard_leave")) || 0);
  const [detailedConfig, setDetailedConfig] = useState<Record<string, { ot: number, leave: number }>>(() => {
    try {
      return JSON.parse(localStorage.getItem("dashboard_detailed_config") || "{}");
    } catch {
      return {};
    }
  });
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [tempDetailedConfig, setTempDetailedConfig] = useState<Record<string, { ot: number, leave: number }>>({});
  
  const [suggestionText, setSuggestionText] = useState("");
  const [isGeneratingSuggestion, setIsGeneratingSuggestion] = useState(false);

  const [transitioning, setTransitioning] = useState(false);
  const [transitionStatus, setTransitionStatus] = useState("");
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [closableTargets, setClosableTargets] = useState<JiraIssue[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());

  const [showTeamCloseModal, setShowTeamCloseModal] = useState(false);
  const [teamSelectedProject, setTeamSelectedProject] = useState(() => localStorage.getItem("default_project") || JIRA_PROJECTS[0].key);
  const [teamClosableTargets, setTeamClosableTargets] = useState<JiraIssue[]>([]);
  const [teamSelectedTargets, setTeamSelectedTargets] = useState<Set<string>>(new Set());
  const [teamLoadingTasks, setTeamLoadingTasks] = useState(false);

  const [commentIssueKey, setCommentIssueKey] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [commentFile, setCommentFile] = useState<File | null>(null);
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);

  const isConfigured = !!localStorage.getItem("jira_pat") || !!localStorage.getItem("jira_basic");

  const saveConfig = () => {
    localStorage.setItem("dashboard_ot", String(otHours));
    localStorage.setItem("dashboard_leave", String(leaveHours));
    localStorage.setItem("dashboard_detailed_config", JSON.stringify(detailedConfig));
    alert("Đã lưu cấu hình OT/Nghỉ thành công!");
  };

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

      const isSubTask = i.fields.issuetype?.name?.toLowerCase().includes("sub-task") || i.fields.issuetype?.name?.toLowerCase().includes("subtask");

      // Tránh các task đã hoàn thành/hủy bỏ
      const isClosedOrCancelled =
        statusName.includes("close") ||
        statusName.includes("cancel") ||
        statusName.includes("hủy") ||
        statusName.includes("đóng");

      const isResolved =
        statusName.includes("resolve") ||
        statusName.includes("done") ||
        statusName.includes("hoàn thành") ||
        statusName.includes("đã giải quyết");

      // Với Sub-task, Resolved chưa phải là kết thúc, cho phép tiếp tục chạy auto close để chuyển sang Closed
      const isCompleted = isSubTask ? isClosedOrCancelled : (isClosedOrCancelled || isResolved);

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

  const fetchTeamTasks = useCallback(async () => {
    if (!teamSelectedProject) return;
    try {
      setTeamLoadingTasks(true);
      const jql = `project = "${teamSelectedProject}" AND assignee != currentUser() AND statusCategory != Done`;
      const allOtherIssues = await getAllIssuesByJql(jql, 500);
      
      const targets = allOtherIssues.filter((i) => {
        const statusName = i.fields.status?.name?.toLowerCase() || "";
        const est = i.fields.timetracking?.originalEstimateSeconds || 0;
        const logged = i.fields.timetracking?.timeSpentSeconds || 0;
        const remain = i.fields.timetracking?.remainingEstimateSeconds || 0;

        const isSubTask = i.fields.issuetype?.name?.toLowerCase().includes("sub-task") || i.fields.issuetype?.name?.toLowerCase().includes("subtask");

        const isClosedOrCancelled =
          statusName.includes("close") ||
          statusName.includes("cancel") ||
          statusName.includes("hủy") ||
          statusName.includes("đóng");

        const isResolved =
          statusName.includes("resolve") ||
          statusName.includes("done") ||
          statusName.includes("hoàn thành") ||
          statusName.includes("ready for test") ||
          statusName.includes("đã giải quyết");

        return isResolved && logged > 0;
      });

      setTeamClosableTargets(targets);
      setTeamSelectedTargets(new Set(targets.map(t => t.key)));
    } catch (e: any) {
      console.error("Lỗi khi tải task team:", e);
    } finally {
      setTeamLoadingTasks(false);
    }
  }, [teamSelectedProject]);

  useEffect(() => {
    if (showTeamCloseModal) {
      fetchTeamTasks();
    }
  }, [showTeamCloseModal, fetchTeamTasks]);

  const autoCloseOtherEmployeesTasks = () => {
    if (!teamSelectedProject) {
      setTeamSelectedProject(localStorage.getItem("default_project") || JIRA_PROJECTS[0].key);
    }
    setShowTeamCloseModal(true);
  };

  const executeTeamAutoClose = async () => {
    if (teamSelectedTargets.size === 0) return;
    setShowTeamCloseModal(false);

    setTransitioning(true);
    let successCount = 0;
    const targetsToClose = teamClosableTargets.filter(t => teamSelectedTargets.has(t.key));

    for (const task of targetsToClose) {
      const key = task.key;
      setTransitionStatus(`Đang xử lý (${successCount + 1}/${targetsToClose.length}): ${key}`);
      try {
        let transitions = await getTransitions(key);

        const inprogressKeywords = ["in progress", "đang thực hiện", "đang làm", "to do", "cần làm"];
        const resolvedKeywords = ["resolved", "done", "đã giải quyết", "hoàn thành", "ready for test", "resolved / done"];
        const closedKeywords = ["closed", "đóng", "close"];

        const currentStatusName = task.fields.status.name.toLowerCase();
        const isAlreadyResolved = resolvedKeywords.some(kw => currentStatusName.includes(kw));
        const isAlreadyClosed = closedKeywords.some(kw => currentStatusName.includes(kw));

        if (!isAlreadyResolved && !isAlreadyClosed) {
          const toInProgress = transitions.find(t =>
            inprogressKeywords.includes(t.to.name.toLowerCase()) ||
            inprogressKeywords.some(kw => t.name.toLowerCase().includes(kw))
          );
          if (toInProgress) {
            setTransitionStatus(`Đang xử lý (${successCount + 1}/${targetsToClose.length}): ${key} ➔ ${toInProgress.to.name}`);
            await transitionIssue(key, toInProgress.id);
            transitions = await getTransitions(key);
          }

          const getJiraErrorMsg = (err: any) => {
            const data = err?.response?.data;
            if (!data) return err.message;
            if (data.errorMessages && data.errorMessages.length > 0) return data.errorMessages[0];
            if (data.errors) return JSON.stringify(data.errors);
            return err.message;
          };

          const toResolved = transitions.find(t =>
            resolvedKeywords.includes(t.to.name.toLowerCase()) ||
            resolvedKeywords.some(kw => t.name.toLowerCase().includes(kw))
          );
          if (toResolved) {
            setTransitionStatus(`Đang xử lý (${successCount + 1}/${targetsToClose.length}): ${key} ➔ ${toResolved.to.name}`);
            const allFields = await getJiraFields();
            const outputField = allFields.find(f => f.name.toLowerCase() === "output" || f.name.toLowerCase() === "out put");
            const transitionFields: any = { resolution: { id: "10000" } };
            if (outputField) {
              const aiOutput = await generateAiOutput(task.fields.summary);
              transitionFields[outputField.id] = aiOutput;
            }

            try {
              await transitionIssue(key, toResolved.id, transitionFields);
            } catch (e) {
              console.warn(`Chuyển sang Resolved với fields thất bại cho ${key}. Lỗi:`, getJiraErrorMsg(e));
              await transitionIssue(key, toResolved.id);
            }
            transitions = await getTransitions(key);
          }
        }

        const toClosed = transitions.find(t =>
          closedKeywords.includes(t.to.name.toLowerCase()) ||
          closedKeywords.some(kw => t.name.toLowerCase().includes(kw))
        );
        if (toClosed) {
          setTransitionStatus(`Đang xử lý (${successCount + 1}/${targetsToClose.length}): ${key} ➔ ${toClosed.to.name}`);
          await transitionIssue(key, toClosed.id);
        }

        successCount++;
      } catch (err: any) {
        console.warn(`Lỗi khi xử lý ${key}`, err);
      }
    }
    
    setTransitioning(false);
    setTransitionStatus("");
  };

  const executeAutoClose = async () => {
    if (selectedTargets.size === 0) return;
    setShowCloseModal(false);

    setTransitioning(true);
    let successCount = 0;

    const targetsToClose = closableTargets.filter(t => selectedTargets.has(t.key));

    for (const task of targetsToClose) {
      const key = task.key;
      setTransitionStatus(`Đang xử lý (${successCount + 1}/${targetsToClose.length}): ${key}`);
      try {
        let transitions = await getTransitions(key);

        const inprogressKeywords = ["in progress", "đang thực hiện", "đang làm", "to do", "cần làm"];
        const resolvedKeywords = ["resolved", "done", "đã giải quyết", "hoàn thành", "ready for test", "resolved / done"];
        const closedKeywords = ["closed", "đóng", "close"];

        const currentStatusName = task.fields.status.name.toLowerCase();
        const isAlreadyResolved = resolvedKeywords.some(kw => currentStatusName.includes(kw));
        const isAlreadyClosed = closedKeywords.some(kw => currentStatusName.includes(kw));

        if (!isAlreadyResolved && !isAlreadyClosed) {
          // 1. Chuyển sang In Progress (nếu có)
          const toInProgress = transitions.find(t =>
            inprogressKeywords.includes(t.to.name.toLowerCase()) ||
            inprogressKeywords.some(kw => t.name.toLowerCase().includes(kw))
          );
          if (toInProgress) {
            setTransitionStatus(`Đang xử lý (${successCount + 1}/${targetsToClose.length}): ${key} ➔ ${toInProgress.to.name}`);
            await transitionIssue(key, toInProgress.id);
            transitions = await getTransitions(key);
          }

          const getJiraErrorMsg = (err: any) => {
            const data = err?.response?.data;
            if (!data) return err.message;
            if (data.errorMessages && data.errorMessages.length > 0) return data.errorMessages[0];
            if (data.errors) return JSON.stringify(data.errors);
            return err.message;
          };

          // 2. Chuyển sang Resolved/Hoàn thành
          const toResolved = transitions.find(t =>
            resolvedKeywords.includes(t.to.name.toLowerCase()) ||
            resolvedKeywords.some(kw => t.name.toLowerCase().includes(kw))
          );
          if (toResolved) {
            setTransitionStatus(`Đang xử lý (${successCount + 1}/${targetsToClose.length}): ${key} ➔ ${toResolved.to.name}`);
            const allFields = await getJiraFields();
            const outputField = allFields.find(f => f.name.toLowerCase() === "output" || f.name.toLowerCase() === "out put");
            const transitionFields: any = { resolution: { id: "10000" } };
            if (outputField) {
              const aiOutput = await generateAiOutput(task.fields.summary);
              transitionFields[outputField.id] = aiOutput;
            }

            try {
              await transitionIssue(key, toResolved.id, transitionFields);
            } catch (e) {
              console.warn(`Chuyển sang Resolved với fields thất bại cho ${key}. Lỗi:`, getJiraErrorMsg(e));
              await transitionIssue(key, toResolved.id);
            }
            transitions = await getTransitions(key);
          }
        }

        // 2.5 Chuyển sang Commit (nếu có) - CHỈ DÀNH CHO BUG
        const isBug = task.fields.issuetype?.name?.toLowerCase().includes("bug");
        if (isBug) {
          const toCommit = transitions.find(t => t.to.name.toLowerCase().includes("commit") || t.name.toLowerCase().includes("commit"));
          if (toCommit) {
            setTransitionStatus(`Đang xử lý (${successCount + 1}/${targetsToClose.length}): ${key} ➔ ${toCommit.to.name}`);
            await transitionIssue(key, toCommit.id);
            transitions = await getTransitions(key);
          }
        }

        // 2.7 Chuyển sang UAT (nếu là UAT bug)
        const isUatBug = task.fields.issuetype?.name?.toLowerCase() === "uat bug";
        if (isUatBug) {
          const toUat = transitions.find(t => t.to.name.toLowerCase().includes("uat") || t.name.toLowerCase().includes("uat"));
          if (toUat) {
            setTransitionStatus(`Đang xử lý (${successCount + 1}/${targetsToClose.length}): ${key} ➔ ${toUat.to.name}`);
            await transitionIssue(key, toUat.id);
            transitions = await getTransitions(key);
          }
        }

        // 3. Chuyển sang Closed/Đóng
        const toClosed = transitions.find(t =>
          closedKeywords.includes(t.to.name.toLowerCase()) ||
          closedKeywords.some(kw => t.name.toLowerCase().includes(kw))
        );
        if (toClosed) {
          setTransitionStatus(`Đang xử lý (${successCount + 1}/${targetsToClose.length}): ${key} ➔ ${toClosed.to.name}`);
          const allFields = await getJiraFields();
          const outputField = allFields.find(f => f.name.toLowerCase() === "output" || f.name.toLowerCase() === "out put");
          const transitionFields: any = { resolution: { id: "10000" } };
          if (outputField) {
            const aiOutput = await generateAiOutput(task.fields.summary);
            transitionFields[outputField.id] = aiOutput;
          }

          try {
            await transitionIssue(key, toClosed.id, transitionFields);
          } catch (e: any) {
            const data = e?.response?.data;
            let msg = e.message;
            if (data?.errorMessages?.length) msg = data.errorMessages[0];
            else if (data?.errors) msg = JSON.stringify(data.errors);
            console.warn(`Chuyển sang Closed với fields thất bại cho ${key}, thử lại không dùng fields. Lỗi: ${msg}`);

            try {
              await transitionIssue(key, toClosed.id);
            } catch (innerE: any) {
              const innerData = innerE?.response?.data;
              let innerMsg = innerE.message;
              if (innerData?.errorMessages?.length) innerMsg = innerData.errorMessages[0];
              else if (innerData?.errors) innerMsg = JSON.stringify(innerData.errors);

              alert(`Không thể chuyển ${key} sang Closed. Lỗi Jira: ${innerMsg}`);
              throw innerE;
            }
          }
        } else {
          const avail = transitions.map(t => t.name).join(", ");
          console.warn(`Không tìm thấy transition Closed cho ${key}. Các transition hiện có:`, avail);
          alert(`Task ${key} không có bước nào để chuyển sang Closed!\nCác bước hiện có: ${avail || "Không có bước nào"}`);
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

  const handleCommentSubmit = async () => {
    if (!commentIssueKey) return;
    if (!commentText.trim() && !commentFile) {
      alert("Vui lòng nhập nội dung comment hoặc chọn ảnh.");
      return;
    }

    setIsSubmittingComment(true);
    try {
      let finalCommentText = commentText;

      if (commentFile) {
        // Upload file first
        const uploadRes = await uploadAttachment(commentIssueKey, commentFile);
        const filename = uploadRes && uploadRes.length > 0 && uploadRes[0].filename
          ? uploadRes[0].filename
          : commentFile.name;

        // Append image reference using Jira markup
        finalCommentText += `\n\n!${filename}!`;
      }

      await addComment(commentIssueKey, finalCommentText);
      alert("Đã thêm comment thành công!");
      setCommentIssueKey(null);
      setCommentText("");
      setCommentFile(null);
    } catch (e: any) {
      console.error("Failed to add comment:", e);
      alert("Lỗi khi thêm comment: " + (e.response?.data?.errorMessages?.[0] || e.message));
    } finally {
      setIsSubmittingComment(false);
    }
  };

  const fetchData = useCallback(async () => {
    if (!isConfigured) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      try {
        const user = await getCurrentUser();
        setCurrentUser(user);
        
        // Fetch config from DB to sync locally
        fetch("/api/configs/authorized_close_team")
          .then(r => r.json())
          .then(data => {
            if (data && data.value !== null) {
              localStorage.setItem("authorized_close_team", data.value);
            }
          })
          .catch(e => console.warn("Lỗi đồng bộ phân quyền từ DB", e));
      } catch (e) {
        console.warn("Lỗi lấy thông tin user", e);
      }

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
  const totalEstimated = filteredIssues.reduce((s, i) => {
    const hasParent = i.fields.parent && filteredIssues.some(p => p.key === i.fields.parent?.key);
    if (hasParent) return s;
    return s + getIssueEstimatedSeconds(i);
  }, 0);

  // Tính tổng thời gian đã log: chỉ tính những ticket đã được closed
  const totalLogged = filteredIssues.reduce((sum, issue) => {
    const statusName = issue.fields.status?.name?.toLowerCase() || "";
    if (
      !statusName.includes("close") &&
      !statusName.includes("đóng") &&
      !statusName.includes("done") &&
      !statusName.includes("hoàn thành")
    ) {
      return sum;
    }

    if (timeRange === "all") {
      const hasParent = issue.fields.parent && filteredIssues.some(p => p.key === issue.fields.parent?.key);
      if (hasParent) return sum;
      return sum + getIssueLoggedSeconds(issue);
    } else {
      let rangeStart = startOfMonth;
      let rangeEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      if (timeRange === "prevMonth") {
        rangeStart = startOfPrevMonth;
        rangeEnd = endOfPrevMonth;
      }

      const taskDateStr = issue.fields.customfield_10300 || issue.fields.duedate || issue.fields.customfield_10302;
      const periodLogs = issue.fields.worklog?.worklogs?.reduce((s, wl) => {
        const wlDate = taskDateStr ? new Date(taskDateStr) : new Date(wl.started);
        return (wlDate >= rangeStart && wlDate <= rangeEnd) ? s + wl.timeSpentSeconds : s;
      }, 0) || 0;
      return sum + periodLogs;
    }
  }, 0);

  const totalRemaining = filteredIssues.reduce((s, i) => {
    const hasParent = i.fields.parent && filteredIssues.some(p => p.key === i.fields.parent?.key);
    if (hasParent) return s;
    // For remaining, we can subtract logged from estimated
    const est = getIssueEstimatedSeconds(i);
    const log = getIssueLoggedSeconds(i);
    return s + Math.max(0, est - log);
  }, 0);
  const logPct = totalEstimated > 0 ? Math.round((totalLogged / totalEstimated) * 100) : 0;

  // ── KPI Calculation ──
  let workingDays = 0;
  let workingDaysToDate = 0;
  if (timeRange !== "all") {
    const holidaysList = getHolidays();
    let d = new Date(timeRange === "prevMonth" ? startOfPrevMonth : startOfMonth);
    const end = timeRange === "prevMonth" ? endOfPrevMonth : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    while (d <= end) {
      const day = d.getDay();
      if (day !== 0 && day !== 6) { // Not weekend
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const dt = String(d.getDate()).padStart(2, '0');
        const dateStr = `${y}-${m}-${dt}`;

        if (!holidaysList.includes(dateStr)) {
          workingDays++;
          // Tính workingDaysToDate (nếu ngày d nhỏ hơn hoặc bằng ngày hiện tại)
          // Để đảm bảo so sánh đúng ngày, ta reset giờ phút giây của "now"
          const today = new Date();
          today.setHours(23, 59, 59, 999);
          if (d.getTime() <= today.getTime()) {
            workingDaysToDate++;
          }
        }
      }
      d.setDate(d.getDate() + 1);
    }
  }

  const standardHours = workingDays * 7;
  const actualHours = standardHours + otHours - leaveHours;
  const closedLogWorkHours = totalLogged / 3600;
  const kpiMonth = closedLogWorkHours > 0 ? (actualHours / closedLogWorkHours) : 0;
  const missingHoursMonth = Math.max(0, actualHours - closedLogWorkHours);

  const standardHoursToDate = workingDaysToDate * 7;
  const actualHoursToDate = standardHoursToDate + otHours - leaveHours;
  const kpiToDate = closedLogWorkHours > 0 ? (actualHoursToDate / closedLogWorkHours) : 0;
  const missingHoursToDate = Math.max(0, actualHoursToDate - closedLogWorkHours);

  // ── Status & Type distribution ──
  const statusCounts: Record<string, number> = {};
  let uatBugCount = 0;
  let prodBugCount = 0;
  let subTaskCount = 0;

  filteredIssues.forEach((i) => {
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

        const taskDateStr = issue.fields.customfield_10300 || issue.fields.duedate || issue.fields.customfield_10302;
        const periodLogs = issue.fields.worklog?.worklogs?.reduce((s, wl) => {
          const wlDate = taskDateStr ? new Date(taskDateStr) : new Date(wl.started);
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
    "Logged (h)": Math.round(p.loggedSeconds / 3600),
    "Remaining (h)": Math.round(p.remainingSeconds / 3600),
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

  const dayNames = ["Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7", "Chủ Nhật"];

  const getDaysInView = useCallback(() => {
    const days: any[] = [];
    let start = startOfMonth;
    let end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    if (timeRange === "prevMonth") {
      start = startOfPrevMonth;
      end = endOfPrevMonth;
    }
    const holidaysList = getHolidays();
    let d = new Date(start);
    while (d <= end) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dt = String(d.getDate()).padStart(2, '0');
      const dateStr = `${y}-${m}-${dt}`;
      
      const day = d.getDay();
      const isWeekend = day === 0 || day === 6;
      const isHoliday = holidaysList.includes(dateStr);
      
      days.push({
         dateStr,
         isWeekend,
         isHoliday,
         dayOfWeek: dayNames[day === 0 ? 6 : day - 1]
      });
      d.setDate(d.getDate() + 1);
    }
    return days;
  }, [timeRange, startOfMonth, startOfPrevMonth, endOfPrevMonth]);

  const dailyLoggedMap: Record<string, number> = {};
  filteredIssues.forEach(issue => {
    const taskDateStr = issue.fields.customfield_10300 || issue.fields.duedate || issue.fields.customfield_10302;
    issue.fields.worklog?.worklogs?.forEach((wl) => {
      const wlDate = taskDateStr ? new Date(taskDateStr) : new Date(wl.started);
      const y = wlDate.getFullYear();
      const m = String(wlDate.getMonth() + 1).padStart(2, '0');
      const dt = String(wlDate.getDate()).padStart(2, '0');
      const dateStr = `${y}-${m}-${dt}`;
      dailyLoggedMap[dateStr] = (dailyLoggedMap[dateStr] || 0) + wl.timeSpentSeconds;
    });
  });

  const detailedOtSum = Object.values(detailedConfig).reduce((sum, c) => sum + (c.ot || 0), 0);
  const detailedLeaveSum = Object.values(detailedConfig).reduce((sum, c) => sum + (c.leave || 0), 0);
  const configMatches = detailedOtSum === otHours && detailedLeaveSum === leaveHours && Object.keys(detailedConfig).length > 0;

  const handleGenerateSuggestion = async () => {
    if (configMatches) {
      const missingDays = [];
      const days = getDaysInView();
      for (const d of days) {
        const logH = (dailyLoggedMap[d.dateStr] || 0) / 3600;
        const targetH = (d.isWeekend || d.isHoliday ? 0 : 7) + (detailedConfig[d.dateStr]?.ot || 0) - (detailedConfig[d.dateStr]?.leave || 0);
        if (logH < targetH) {
          missingDays.push(`- ${d.dateStr}: Cần ${targetH}h, Đã log ${logH.toFixed(1)}h ➔ Thiếu ${(targetH - logH).toFixed(1)}h`);
        }
      }
      if (missingDays.length > 0) {
        setSuggestionText(`Bạn đang log thiếu giờ ở các ngày sau (theo cấu hình chi tiết):\n${missingDays.join("\n")}`);
      } else {
        setSuggestionText("✅ Không phát hiện ngày nào log thiếu giờ so với cấu hình chi tiết.");
      }
    } else {
      setIsGeneratingSuggestion(true);
      try {
        const geminiKey = localStorage.getItem("gemini_api_key");
        if (!geminiKey) throw new Error("Vui lòng cấu hình Gemini API Key trong phần Cài đặt để sử dụng tính năng AI.");
        
        const logSummary = getDaysInView().map(d => {
          const logH = (dailyLoggedMap[d.dateStr] || 0) / 3600;
          return `${d.dateStr} (${d.dayOfWeek}): ${logH.toFixed(1)}h`;
        }).join("\n");

        const prompt = `Bạn là một trợ lý quản lý thời gian. KPI log work của tôi đang bị thiếu giờ. 
Tổng giờ OT khai báo: ${otHours}h, Tổng giờ nghỉ: ${leaveHours}h.
Số giờ đã log theo từng ngày trong kỳ như sau:
${logSummary}

Quy định log work: Ngày thường phải log 7 giờ + số giờ OT - số giờ nghỉ. Ngày lễ/cuối tuần không cần log nhưng nếu có làm thì vẫn tính vào tổng.
Hãy phân tích và đưa ra một đoạn văn đề xuất tôi nên log bù vào ngày nào cho hợp lý nhất để đạt chỉ tiêu (tổng giờ = số ngày thường * 7 + ${otHours} - ${leaveHours}), ưu tiên bù vào những ngày thường chưa log đủ 7h. Phân tích ngắn gọn. Đừng dùng markdown format quá phức tạp.`;
        
        const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        if (aiRes.ok) {
          const data = await aiRes.json();
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          setSuggestionText(text || "Không có gợi ý nào từ AI.");
        } else {
          throw new Error("Lỗi khi gọi AI API");
        }
      } catch (e: any) {
        setSuggestionText("Lỗi: " + e.message);
      } finally {
        setIsGeneratingSuggestion(false);
      }
    }
  };

  const lastMonday = new Date(currentMonday);
  lastMonday.setDate(lastMonday.getDate() - 7);

  const nextMonday = new Date(currentMonday);
  nextMonday.setDate(nextMonday.getDate() + 7);

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
            <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => { }}>
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
        <div style={{ display: "flex", gap: 6, marginLeft: "auto", alignItems: "center" }}>
          <NotificationBell />
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
          {(() => {
            const isNamha = currentUser?.emailAddress?.includes("namha@etc.vn") || currentUser?.name?.includes("namha@etc.vn");
            const authStr = localStorage.getItem("authorized_close_team") || "";
            const authList = authStr.toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
            const userEmail = currentUser?.emailAddress?.toLowerCase() || "";
            const userName = currentUser?.name?.toLowerCase() || "";
            const isAuthorized = isNamha || authList.some(a => userEmail.includes(a) || userName.includes(a));
            
            if (!isAuthorized) return null;
            return (
              <button
                className="btn btn-sm"
                onClick={autoCloseOtherEmployeesTasks}
                disabled={loading || transitioning}
                title="Tìm và đóng task của nhân viên khác trong dự án"
                style={{
                  background: "linear-gradient(135deg, #f59e0b, #ef4444)",
                  color: "white",
                  border: "none",
                  fontWeight: 500,
                  padding: "6px 14px",
                  borderRadius: 8,
                  cursor: "pointer",
                  boxShadow: "0 4px 12px rgba(239, 68, 68, 0.25)"
                }}
              >
                ⚡ Auto Close Task Team
              </button>
            );
          })()}
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
        {/* Progress Modal */}
        {transitioning && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
            <div style={{ background: "var(--bg-secondary)", borderRadius: 16, width: 400, padding: 32, display: "flex", flexDirection: "column", alignItems: "center", border: "1px solid var(--border)", boxShadow: "var(--shadow-lg)", textAlign: "center" }}>
              <div className="spinning" style={{ fontSize: 48, marginBottom: 16 }}>⚙️</div>
              <h3 style={{ margin: 0, fontSize: 18, color: "var(--text-primary)", marginBottom: 8 }}>Đang đóng task...</h3>
              <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>{transitionStatus}</div>
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

        {/* Team Close Modal */}
        {showTeamCloseModal && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
            <div style={{ background: "var(--bg-secondary)", borderRadius: 16, width: 700, maxWidth: "95vw", maxHeight: "85vh", display: "flex", flexDirection: "column", border: "1px solid var(--border)", boxShadow: "var(--shadow-lg)" }}>
              <div style={{ padding: 20, borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 18, color: "var(--text-primary)" }}>Đóng Task Team theo Dự án</h3>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
                    <select
                      value={teamSelectedProject}
                      onChange={(e) => setTeamSelectedProject(e.target.value)}
                      style={{ padding: "6px 12px", borderRadius: 6, background: "var(--bg-primary)", color: "var(--text-primary)", border: "1px solid var(--border)", cursor: "pointer", outline: "none", fontSize: 14 }}
                    >
                      {JIRA_PROJECTS.map(p => (
                        <option key={p.key} value={p.key}>{p.name} ({p.key})</option>
                      ))}
                    </select>
                  </div>
                </div>
                <button onClick={() => setShowTeamCloseModal(false)} className="btn btn-ghost btn-sm">❌</button>
              </div>
              
              <div style={{ padding: 20, overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
                {teamLoadingTasks ? (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 40, color: "var(--text-secondary)" }}>
                    <div className="spinning" style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
                    Đang tìm các task đã Resolved và có Log work của dự án {teamSelectedProject}...
                  </div>
                ) : teamClosableTargets.length === 0 ? (
                  <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>
                    🎉 Không tìm thấy task nào của nhân viên khác (dự án {teamSelectedProject}) đang ở trạng thái Resolved và có log work cần đóng.
                  </div>
                ) : (
                  teamClosableTargets.map(t => (
                    <label key={t.key} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)", borderRadius: 10, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        style={{ width: 18, height: 18, cursor: "pointer", flexShrink: 0 }}
                        checked={teamSelectedTargets.has(t.key)}
                        onChange={(e) => {
                          const newSet = new Set(teamSelectedTargets);
                          if (e.target.checked) newSet.add(t.key);
                          else newSet.delete(t.key);
                          setTeamSelectedTargets(newSet);
                        }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                          <span style={{ color: "var(--accent-blue-light)", fontWeight: 600, fontSize: 13 }}>{t.key}</span>
                          <span className={getBadgeClass(t.fields.status.name)} style={{ fontSize: 10, padding: "2px 6px" }}>{t.fields.status.name}</span>
                          <span style={{ fontSize: 11, background: "var(--bg-primary)", padding: "2px 8px", borderRadius: 10, border: "1px solid var(--border)" }}>
                            👤 {t.fields.assignee?.displayName || t.fields.assignee?.name || "Unassigned"}
                          </span>
                        </div>
                        <div style={{ color: "var(--text-primary)", fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 6 }}>
                          {t.fields.summary}
                        </div>
                        <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--text-secondary)" }}>
                          <span>⏱️ Đã log: <strong style={{ color: "var(--accent-green)" }}>{formatSeconds(t.fields.timetracking?.timeSpentSeconds || 0)}</strong></span>
                          <span>⏳ Estimate: <strong>{formatSeconds(t.fields.timetracking?.originalEstimateSeconds || 0)}</strong></span>
                        </div>
                      </div>
                    </label>
                  ))
                )}
              </div>
              <div style={{ padding: 20, borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", color: "var(--text-secondary)", opacity: teamClosableTargets.length === 0 ? 0.5 : 1 }}>
                  <input
                    type="checkbox"
                    disabled={teamClosableTargets.length === 0}
                    checked={teamClosableTargets.length > 0 && teamSelectedTargets.size === teamClosableTargets.length}
                    onChange={(e) => {
                      if (e.target.checked) setTeamSelectedTargets(new Set(teamClosableTargets.map(t => t.key)));
                      else setTeamSelectedTargets(new Set());
                    }}
                  />
                  Chọn tất cả
                </label>
                <div style={{ display: "flex", gap: 12 }}>
                  <button onClick={() => setShowTeamCloseModal(false)} className="btn btn-secondary">Đóng</button>
                  <button onClick={executeTeamAutoClose} className="btn btn-primary" disabled={teamSelectedTargets.size === 0}>
                    Xác nhận đóng ({teamSelectedTargets.size}) task
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Comment Modal */}
        {commentIssueKey && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
            <div style={{ background: "var(--bg-secondary)", borderRadius: 16, width: 500, maxWidth: "90vw", display: "flex", flexDirection: "column", border: "1px solid var(--border)", boxShadow: "var(--shadow-lg)" }}>
              <div style={{ padding: 20, borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3 style={{ margin: 0, fontSize: 18, color: "var(--text-primary)" }}>Thêm Comment - {commentIssueKey}</h3>
                <button onClick={() => { setCommentIssueKey(null); setCommentText(""); setCommentFile(null); }} className="btn btn-ghost btn-sm">❌</button>
              </div>
              <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
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
              </div>
              <div style={{ padding: 20, borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 12 }}>
                <button onClick={() => { setCommentIssueKey(null); setCommentText(""); setCommentFile(null); }} className="btn btn-secondary">Hủy</button>
                <button onClick={handleCommentSubmit} className="btn btn-primary" disabled={isSubmittingComment}>
                  {isSubmittingComment ? "Đang gửi..." : "Gửi Comment"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Detailed Config Modal */}
        {showConfigModal && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
            <div style={{ background: "var(--bg-secondary)", borderRadius: 16, width: 640, maxWidth: "90vw", maxHeight: "80vh", display: "flex", flexDirection: "column", border: "1px solid var(--border)", boxShadow: "var(--shadow-lg)" }}>
              <div style={{ padding: 20, borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 18, color: "var(--text-primary)" }}>Cấu hình OT/Nghỉ chi tiết</h3>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>Nhập số giờ OT và Nghỉ cho từng ngày trong tháng hiện tại.</div>
                </div>
                <button onClick={() => setShowConfigModal(false)} className="btn btn-ghost btn-sm">❌</button>
              </div>
              <div style={{ padding: 20, overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
                {getDaysInView().map((d: any) => (
                  <div key={d.dateStr} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)", borderRadius: 10 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: d.isWeekend || d.isHoliday ? "var(--accent-orange)" : "var(--text-primary)" }}>{d.dateStr}</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{d.dayOfWeek} {d.isHoliday ? "(Nghỉ lễ)" : d.isWeekend ? "(Cuối tuần)" : ""}</div>
                    </div>
                    <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-secondary)" }}>
                        OT (h):
                        <input type="number" min="0" value={tempDetailedConfig[d.dateStr]?.ot || ""} onChange={e => {
                          const val = Number(e.target.value) || 0;
                          setTempDetailedConfig(prev => ({ ...prev, [d.dateStr]: { ...prev[d.dateStr], ot: val, leave: prev[d.dateStr]?.leave || 0 } }));
                        }} style={{ width: 60, padding: "4px 8px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-primary)" }} placeholder="0" />
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-secondary)" }}>
                        Nghỉ (h):
                        <input type="number" min="0" value={tempDetailedConfig[d.dateStr]?.leave || ""} onChange={e => {
                          const val = Number(e.target.value) || 0;
                          setTempDetailedConfig(prev => ({ ...prev, [d.dateStr]: { ...prev[d.dateStr], ot: prev[d.dateStr]?.ot || 0, leave: val } }));
                        }} style={{ width: 60, padding: "4px 8px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-primary)" }} placeholder="0" />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ padding: 20, borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                  Tổng OT: {Object.values(tempDetailedConfig).reduce((sum, c) => sum + (c.ot || 0), 0)}h | Tổng Nghỉ: {Object.values(tempDetailedConfig).reduce((sum, c) => sum + (c.leave || 0), 0)}h
                </div>
                <div style={{ display: "flex", gap: 12 }}>
                  <button onClick={() => setShowConfigModal(false)} className="btn btn-secondary">Hủy</button>
                  <button onClick={() => {
                    setDetailedConfig(tempDetailedConfig);
                    localStorage.setItem("dashboard_detailed_config", JSON.stringify(tempDetailedConfig));
                    setShowConfigModal(false);
                    alert("Đã lưu cấu hình chi tiết ngày!");
                  }} className="btn btn-primary">
                    Lưu cấu hình chi tiết
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="stats-grid">
              {[1, 2, 3, 4].map(i => (
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
                <div className="stat-change neutral">
                  Trong kỳ này
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-icon">🚨</div>
                <div className="stat-value" style={{ color: "var(--accent-red)" }}>{prodBugCount}</div>
                <div className="stat-label">Production Bug</div>
                <div className="stat-change neutral">
                  Trong kỳ này
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-icon">✅</div>
                <div className="stat-value" style={{ color: "var(--accent-blue)" }}>{subTaskCount}</div>
                <div className="stat-label">Sub-task</div>
                <div className="stat-change neutral">
                  Trong kỳ này
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

            {/* KPI Section */}
            <div className="chart-card" style={{ marginBottom: 16 }}>
              <div className="chart-title">📊 Đánh giá KPI</div>
              <div className="chart-subtitle">
                {timeRange === "all" ? "Vui lòng chọn Tháng này hoặc Tháng trước để tính KPI" : "KPI = Số giờ thực tế / Giờ đã log cho task Closed"}
              </div>

              {timeRange !== "all" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginTop: 16 }}>
                  {/* Cấu hình thời gian */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ width: 120, fontSize: 13, color: "var(--text-secondary)" }}>Số ngày chuẩn:</div>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{workingDays} ngày</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>(Trừ T7, CN và Nghỉ lễ)</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ width: 120, fontSize: 13, color: "var(--text-secondary)" }}>Giờ chuẩn (x7):</div>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{standardHours}h</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ width: 120, fontSize: 13, color: "var(--text-secondary)" }}>Số giờ OT:</div>
                      <input
                        type="number"
                        min="0"
                        value={otHours}
                        onChange={(e) => setOtHours(Number(e.target.value) || 0)}
                        style={{ width: 80, padding: "4px 8px" }}
                      />
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ width: 120, fontSize: 13, color: "var(--text-secondary)" }}>Số giờ Nghỉ:</div>
                      <input
                        type="number"
                        min="0"
                        value={leaveHours}
                        onChange={(e) => setLeaveHours(Number(e.target.value) || 0)}
                        style={{ width: 80, padding: "4px 8px" }}
                      />
                    </div>
                    
                    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
                      <button className="btn btn-primary btn-sm" onClick={saveConfig} style={{ padding: "6px 12px", fontSize: 12 }}>💾 Lưu cấu hình</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => {
                        setTempDetailedConfig(detailedConfig);
                        setShowConfigModal(true);
                      }} style={{ padding: "6px 12px", fontSize: 12 }}>⚙️ Cấu hình chi tiết ngày</button>
                    </div>
                  </div>

                  {/* Kết quả KPI */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    
                    {/* KPI Đến Hiện Tại */}
                    <div style={{ background: "rgba(79, 142, 247, 0.05)", border: "1px solid rgba(79, 142, 247, 0.2)", borderRadius: 12, padding: "16px 20px" }}>
                      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: "var(--accent-blue-light)" }}>KPI Đến Ngày Hiện Tại</div>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 13 }}>
                        <span style={{ color: "var(--text-secondary)" }}>Số giờ thực tế (Đến hôm nay):</span>
                        <span style={{ fontWeight: 600 }}>{actualHoursToDate}h</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 13 }}>
                        <span style={{ color: "var(--text-secondary)" }}>Giờ Log Work (Closed):</span>
                        <span style={{ fontWeight: 600 }}>{closedLogWorkHours.toFixed(1)}h</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 13 }}>
                        <span style={{ color: "var(--text-secondary)" }}>Số giờ còn thiếu:</span>
                        <span style={{ fontWeight: 600, color: missingHoursToDate > 0 ? "var(--accent-orange)" : "var(--accent-green)" }}>
                          {missingHoursToDate.toFixed(1)}h
                        </span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, borderTop: "1px solid rgba(79, 142, 247, 0.2)", paddingTop: 8 }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>Chỉ số KPI:</span>
                        <span style={{ fontSize: 24, fontWeight: 800, color: kpiToDate === 0 ? "var(--text-secondary)" : kpiToDate <= 1 ? "var(--accent-green)" : "var(--accent-red)" }}>
                          {kpiToDate.toFixed(2)}
                        </span>
                      </div>
                    </div>

                    {/* KPI Cả Tháng */}
                    <div style={{ background: "rgba(16, 185, 129, 0.05)", border: "1px solid rgba(16, 185, 129, 0.2)", borderRadius: 12, padding: "16px 20px" }}>
                      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: "var(--accent-green)" }}>KPI Dự Kiến Cả Tháng</div>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 13 }}>
                        <span style={{ color: "var(--text-secondary)" }}>Số giờ thực tế (Cả tháng):</span>
                        <span style={{ fontWeight: 600 }}>{actualHours}h</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 13 }}>
                        <span style={{ color: "var(--text-secondary)" }}>Giờ Log Work (Closed):</span>
                        <span style={{ fontWeight: 600 }}>{closedLogWorkHours.toFixed(1)}h</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 13 }}>
                        <span style={{ color: "var(--text-secondary)" }}>Số giờ còn thiếu:</span>
                        <span style={{ fontWeight: 600, color: missingHoursMonth > 0 ? "var(--accent-orange)" : "var(--accent-green)" }}>
                          {missingHoursMonth.toFixed(1)}h
                        </span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, borderTop: "1px solid rgba(16, 185, 129, 0.2)", paddingTop: 8 }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>Chỉ số KPI:</span>
                        <span style={{ fontSize: 24, fontWeight: 800, color: kpiMonth === 0 ? "var(--text-secondary)" : kpiMonth <= 1 ? "var(--accent-green)" : "var(--accent-red)" }}>
                          {kpiMonth.toFixed(2)}
                        </span>
                      </div>
                    </div>

                    {/* Suggestion Box */}
                    {(kpiMonth > 1 || kpiToDate > 1) && (
                      <div style={{ background: "rgba(245, 158, 11, 0.05)", border: "1px solid rgba(245, 158, 11, 0.2)", borderRadius: 12, padding: "16px 20px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--accent-orange)" }}>💡 Gợi ý Log bù giờ</div>
                          <button 
                            className="btn btn-secondary btn-sm" 
                            onClick={handleGenerateSuggestion}
                            disabled={isGeneratingSuggestion}
                          >
                            {isGeneratingSuggestion ? "Đang phân tích..." : configMatches ? "Kiểm tra ngày thiếu" : "✨ Nhờ AI phân tích"}
                          </button>
                        </div>
                        {suggestionText && (
                          <div style={{ fontSize: 13, color: "var(--text-secondary)", whiteSpace: "pre-wrap", background: "rgba(0,0,0,0.2)", padding: 12, borderRadius: 8 }}>
                            {suggestionText}
                          </div>
                        )}
                        {!suggestionText && (
                          <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                            Bấm nút bên trên để xem bạn nên log bù vào ngày nào để đạt đủ KPI.
                          </div>
                        )}
                      </div>
                    )}

                  </div>
                </div>
              )}
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
                      <Bar dataKey="Giờ đã log (h)" fill="#10b981" radius={[4, 4, 0, 0]} barSize={24} />
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
                    <Bar dataKey="Estimate (h)" fill="#4f8ef7" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Logged (h)" fill="#10b981" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Remaining (h)" fill="#f59e0b" radius={[4, 4, 0, 0]} />
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
                      <th>Hành động</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentIssues.map((issue) => {
                      const est = getIssueEstimatedSeconds(issue);
                      const log = getIssueLoggedSeconds(issue);
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
                          <td style={{ textAlign: "center", width: 60 }}>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => setCommentIssueKey(issue.key)}
                              title="Thêm Comment"
                              style={{ padding: "4px 8px", fontSize: 14 }}
                            >
                              💬
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {recentIssues.length === 0 && (
                      <tr>
                        <td colSpan={8}>
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
