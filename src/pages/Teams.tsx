import React, { useState, useEffect, useCallback } from "react";
import TeamDashboardMetrics from "../components/TeamDashboardMetrics";
import {
  getIssue,
  getAssignableUsers,
  createSubTask,
  getAllIssuesByJql,
  formatSeconds,
  JiraIssue,
  JiraUser,
} from "../jiraService";
import { JIRA_PROJECTS } from "../config";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Team {
  id: number;
  name: string;
  description: string;
  project_key: string;
  created_at: string;
  member_count: number;
}

interface TeamMember {
  id: number;
  team_id: number;
  jira_username: string;
  display_name: string;
  role: string;
  created_at: string;
}

interface GeneratedSubTask {
  summary: string;
  assignee: string;
  reason: string;
}

interface SubTaskCreationLog {
  summary: string;
  assignee: string;
  status: "pending" | "processing" | "success" | "error";
  key?: string;
  error?: string;
}

type Tab = "teams" | "members" | "subtasks" | "tasks" | "statistics";

const STATUS_OPTIONS = [
  { value: "all", label: "Tất cả trạng thái" },
  { value: "To Do", label: "To Do" },
  { value: "In Progress", label: "In Progress" },
  { value: "In Review", label: "In Review" },
  { value: "Done", label: "Done" },
  { value: "Closed", label: "Closed" },
];

function getBadgeClass(status: string): string {
  if (status === "In Progress") return "badge badge-inprogress";
  if (status === "Done" || status === "Closed") return "badge badge-done";
  if (status === "In Review") return "badge badge-review";
  return "badge badge-todo";
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function Teams() {
  const [activeTab, setActiveTab] = useState<Tab>("teams");
  const isConfigured = !!localStorage.getItem("jira_pat") || !!localStorage.getItem("jira_basic");

  // ── Tab 1: Teams ──────────────────────────────────────────────────────────
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  const [teamForm, setTeamForm] = useState({ name: "", description: "", project_key: "" });
  const [teamSaving, setTeamSaving] = useState(false);
  const [teamError, setTeamError] = useState("");

  // ── Tab 2: Members ────────────────────────────────────────────────────────
  const [selectedTeamId, setSelectedTeamId] = useState<number | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);
  const [memberForm, setMemberForm] = useState({ jira_username: "", display_name: "", role: "" });
  const [memberSaving, setMemberSaving] = useState(false);
  const [memberError, setMemberError] = useState("");
  const [assignableUsers, setAssignableUsers] = useState<JiraUser[]>([]);

  // ── Tab 3: Sub-task generation ────────────────────────────────────────────
  const [subTaskTeamId, setSubTaskTeamId] = useState<number | null>(null);
  const [subTaskMembers, setSubTaskMembers] = useState<TeamMember[]>([]);
  const [parentIssueKey, setParentIssueKey] = useState("");
  const [parentIssue, setParentIssue] = useState<JiraIssue | null>(null);
  const [fetchingParent, setFetchingParent] = useState(false);
  const [parentError, setParentError] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [generatedTasks, setGeneratedTasks] = useState<GeneratedSubTask[]>([]);
  const [subTaskLogs, setSubTaskLogs] = useState<SubTaskCreationLog[]>([]);
  const [creatingSubTasks, setCreatingSubTasks] = useState(false);

  // ── Tab 4: Team tasks ─────────────────────────────────────────────────────
  const [taskTeamId, setTaskTeamId] = useState<number | null>(null);
  const [taskMembers, setTaskMembers] = useState<TeamMember[]>([]);
  const [taskProjects, setTaskProjects] = useState<string[]>([JIRA_PROJECTS[0].key]);
  const [taskStatusFilter, setTaskStatusFilter] = useState("all");
  const [taskMemberFilter, setTaskMemberFilter] = useState("all");
  const [taskDateFrom, setTaskDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().slice(0, 10);
  });
  const [taskDateTo, setTaskDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [useDateFilter, setUseDateFilter] = useState(true);
  const [teamTasks, setTeamTasks] = useState<JiraIssue[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState("");

  // ── Tab 5: Statistics ─────────────────────────────────────────────────────
  const [statTeamId, setStatTeamId] = useState<number | null>(null);
  const [statMembers, setStatMembers] = useState<TeamMember[]>([]);
  const [statProjects, setStatProjects] = useState<string[]>([JIRA_PROJECTS[0].key]);
  const [statStatusFilter, setStatStatusFilter] = useState("all");
  const [statMemberFilter, setStatMemberFilter] = useState("all");
  const [statDateFrom, setStatDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().slice(0, 10);
  });
  const [statDateTo, setStatDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [useStatDateFilter, setUseStatDateFilter] = useState(true);
  const [statTasks, setStatTasks] = useState<JiraIssue[]>([]);
  const [statLoading, setStatLoading] = useState(false);
  const [statError, setStatError] = useState("");

  // ─── Data fetching ─────────────────────────────────────────────────────────

  const fetchTeams = useCallback(async () => {
    setTeamsLoading(true);
    try {
      const res = await fetch("/api/teams");
      const data = await res.json();
      setTeams(data);
    } catch {
      console.error("Failed to fetch teams");
    } finally {
      setTeamsLoading(false);
    }
  }, []);

  useEffect(() => { fetchTeams(); }, [fetchTeams]);

  const fetchMembers = useCallback(async (teamId: number) => {
    setMembersLoading(true);
    try {
      const res = await fetch(`/api/teams/${teamId}/members`);
      const data = await res.json();
      setMembers(data);
    } catch {
      console.error("Failed to fetch members");
    } finally {
      setMembersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedTeamId) fetchMembers(selectedTeamId);
    else setMembers([]);
  }, [selectedTeamId, fetchMembers]);

  // Load assignable users when a project is selected in members tab
  const selectedTeam = teams.find(t => t.id === selectedTeamId);
  useEffect(() => {
    if (selectedTeam?.project_key && isConfigured) {
      getAssignableUsers(selectedTeam.project_key).then(setAssignableUsers).catch(() => {});
    }
  }, [selectedTeam?.project_key, isConfigured]);

  // Load sub-task team members when team changes
  useEffect(() => {
    if (!subTaskTeamId) { setSubTaskMembers([]); return; }
    fetch(`/api/teams/${subTaskTeamId}/members`)
      .then(r => r.json())
      .then(setSubTaskMembers)
      .catch(() => {});
  }, [subTaskTeamId]);

  // Load task-tab team members
  useEffect(() => {
    if (!taskTeamId) { setTaskMembers([]); return; }
    fetch(`/api/teams/${taskTeamId}/members`)
      .then(r => r.json())
      .then(setTaskMembers)
      .catch(() => {});
  }, [taskTeamId]);

  // Load stat-tab team members
  useEffect(() => {
    if (!statTeamId) { setStatMembers([]); return; }
    fetch(`/api/teams/${statTeamId}/members`)
      .then(r => r.json())
      .then(setStatMembers)
      .catch(() => {});
  }, [statTeamId]);

  // ─── Tab 1: Team CRUD ──────────────────────────────────────────────────────

  const startCreateTeam = () => {
    setEditingTeam(null);
    setTeamForm({ name: "", description: "", project_key: "" });
    setTeamError("");
  };

  const startEditTeam = (t: Team) => {
    setEditingTeam(t);
    setTeamForm({ name: t.name, description: t.description, project_key: t.project_key });
    setTeamError("");
  };

  const handleSaveTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!teamForm.name.trim()) { setTeamError("Tên team không được để trống"); return; }
    setTeamSaving(true);
    setTeamError("");
    try {
      const url = editingTeam ? `/api/teams/${editingTeam.id}` : "/api/teams";
      const method = editingTeam ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(teamForm),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Lỗi lưu team");
      }
      setTeamForm({ name: "", description: "", project_key: "" });
      setEditingTeam(null);
      await fetchTeams();
    } catch (err: any) {
      setTeamError(err.message);
    } finally {
      setTeamSaving(false);
    }
  };

  const handleDeleteTeam = async (id: number, name: string) => {
    if (!confirm(`Xóa team "${name}"? Tất cả thành viên sẽ bị xóa theo.`)) return;
    try {
      await fetch(`/api/teams/${id}`, { method: "DELETE" });
      if (selectedTeamId === id) setSelectedTeamId(null);
      if (subTaskTeamId === id) setSubTaskTeamId(null);
      if (taskTeamId === id) setTaskTeamId(null);
      await fetchTeams();
    } catch {
      alert("Lỗi khi xóa team");
    }
  };

  // ─── Tab 2: Member CRUD ────────────────────────────────────────────────────

  const startAddMember = () => {
    setEditingMember(null);
    setMemberForm({ jira_username: "", display_name: "", role: "" });
    setMemberError("");
  };

  const startEditMember = (m: TeamMember) => {
    setEditingMember(m);
    setMemberForm({ jira_username: m.jira_username, display_name: m.display_name, role: m.role });
    setMemberError("");
  };

  const handleSaveMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTeamId) return;
    if (!memberForm.jira_username.trim()) { setMemberError("Tên đăng nhập Jira không được để trống"); return; }
    setMemberSaving(true);
    setMemberError("");
    try {
      const url = editingMember
        ? `/api/teams/${selectedTeamId}/members/${editingMember.id}`
        : `/api/teams/${selectedTeamId}/members`;
      const method = editingMember ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(memberForm),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Lỗi lưu thành viên");
      }
      setMemberForm({ jira_username: "", display_name: "", role: "" });
      setEditingMember(null);
      await fetchMembers(selectedTeamId);
      await fetchTeams();
    } catch (err: any) {
      setMemberError(err.message);
    } finally {
      setMemberSaving(false);
    }
  };

  const handleDeleteMember = async (m: TeamMember) => {
    if (!confirm(`Xóa thành viên "${m.display_name || m.jira_username}" khỏi team?`)) return;
    try {
      await fetch(`/api/teams/${m.team_id}/members/${m.id}`, { method: "DELETE" });
      await fetchMembers(m.team_id);
      await fetchTeams();
    } catch {
      alert("Lỗi khi xóa thành viên");
    }
  };

  // Fill display_name when user picked from assignable list
  const handleMemberUsernameChange = (username: string) => {
    const user = assignableUsers.find(u => (u.name || u.accountId) === username);
    setMemberForm(f => ({
      ...f,
      jira_username: username,
      display_name: user ? user.displayName : f.display_name,
    }));
  };

  // ─── Tab 3: Sub-task generation ────────────────────────────────────────────

  const handleFetchParent = async () => {
    if (!parentIssueKey.trim()) return;
    setFetchingParent(true);
    setParentError("");
    setParentIssue(null);
    setGeneratedTasks([]);
    setSubTaskLogs([]);
    try {
      const issue = await getIssue(parentIssueKey.trim().toUpperCase());
      setParentIssue(issue);
    } catch {
      setParentError(`Không tìm thấy issue "${parentIssueKey}". Kiểm tra lại key và kết nối Jira.`);
    } finally {
      setFetchingParent(false);
    }
  };

  const handleAnalyzeSubTasks = async () => {
    if (!parentIssue) return;
    const geminiKey = localStorage.getItem("gemini_api_key");
    if (!geminiKey) { alert("Vui lòng cấu hình Google Gemini API Key trong phần Cài đặt trước."); return; }
    if (subTaskMembers.length === 0) { alert("Team chưa có thành viên nào."); return; }

    setAnalyzing(true);
    try {
      const memberList = subTaskMembers
        .map(m => `- ${m.display_name || m.jira_username} (username: ${m.jira_username}), vai trò: ${m.role || "chưa rõ"}`)
        .join("\n");

      const descriptionText = typeof parentIssue.fields.description === "string"
        ? parentIssue.fields.description
        : parentIssue.fields.description
          ? JSON.stringify(parentIssue.fields.description).substring(0, 800)
          : "(không có mô tả)";

      const prompt = `Bạn là một project manager chuyên nghiệp. Hãy phân tích Story/Task lớn sau và phân công các sub-task cho các thành viên trong nhóm.

STORY/TASK GỐC:
Tiêu đề: ${parentIssue.fields.summary}
Mô tả: ${descriptionText.substring(0, 1000)}

THÀNH VIÊN NHÓM:
${memberList}

YÊU CẦU:
- Phân chia thành 3-8 sub-task cụ thể, có thể thực hiện độc lập
- Mỗi sub-task bắt đầu bằng động từ hành động (Thiết kế, Viết, Implement, Kiểm thử, Review...)
- Phân công cho thành viên phù hợp nhất dựa trên vai trò
- Sử dụng đúng jira_username từ danh sách thành viên

Trả về JSON array THUẦN TÚY, không có markdown, không có text thêm:
[{"summary": "...", "assignee": "jira_username", "reason": "lý do phân công"}]`;

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        }
      );

      if (!response.ok) throw new Error(`AI API lỗi: HTTP ${response.status}`);

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

      // Strip markdown code blocks if present
      const cleaned = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
      const parsed: GeneratedSubTask[] = JSON.parse(cleaned);
      setGeneratedTasks(parsed);
    } catch (err: any) {
      alert("Lỗi phân tích AI: " + err.message);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleCreateSubTasks = async () => {
    if (!parentIssue || generatedTasks.length === 0) return;
    const projectKey = parentIssue.fields.project.key;
    setCreatingSubTasks(true);
    const logs: SubTaskCreationLog[] = generatedTasks.map(t => ({ ...t, status: "pending" }));
    setSubTaskLogs([...logs]);

    for (let i = 0; i < generatedTasks.length; i++) {
      const task = generatedTasks[i];
      setSubTaskLogs(prev => prev.map((l, idx) => idx === i ? { ...l, status: "processing" } : l));
      try {
        const created = await createSubTask({
          parentKey: parentIssue.key,
          projectKey,
          summary: task.summary,
          assigneeName: task.assignee || undefined,
          originalEstimate: "7h",
        });
        setSubTaskLogs(prev =>
          prev.map((l, idx) => idx === i ? { ...l, status: "success", key: created.key } : l)
        );
      } catch (err: any) {
        const msg = err.response?.data?.errorMessages?.[0] || err.message || "Lỗi tạo sub-task";
        setSubTaskLogs(prev =>
          prev.map((l, idx) => idx === i ? { ...l, status: "error", error: msg } : l)
        );
      }
    }
    setCreatingSubTasks(false);
    setGeneratedTasks([]);
  };

  // ─── Tab 4: Team tasks ─────────────────────────────────────────────────────

  const handleFetchTeamTasks = async () => {
    if (taskMembers.length === 0) { setTasksError("Team chưa có thành viên nào."); return; }
    const filtered = taskMemberFilter === "all" ? taskMembers : taskMembers.filter(m => m.jira_username === taskMemberFilter);
    if (filtered.length === 0) { setTasksError("Không có thành viên nào được chọn."); return; }

    const usernames = filtered.map(m => `"${m.jira_username}"`).join(", ");
    const projectFilter = taskProjects.length > 0
      ? `project in (${taskProjects.map(p => `"${p}"`).join(", ")}) AND `
      : "";
    const statusClause = taskStatusFilter !== "all" ? ` AND status = "${taskStatusFilter}"` : "";
    const dateClause = useDateFilter
      ? ` AND updated >= "${taskDateFrom}" AND updated <= "${taskDateTo}"`
      : "";

    const jql = `${projectFilter}assignee in (${usernames})${statusClause}${dateClause} ORDER BY updated DESC`;

    setTasksLoading(true);
    setTasksError("");
    setTeamTasks([]);
    try {
      const issues = await getAllIssuesByJql(jql, 500);
      setTeamTasks(issues);
    } catch (err: any) {
      setTasksError("Lỗi tải dữ liệu: " + (err.message || "Không xác định"));
    } finally {
      setTasksLoading(false);
    }
  };

  const handleFetchStatTasks = async () => {
    if (statMembers.length === 0) { setStatError("Team chưa có thành viên nào."); return; }
    const filtered = statMemberFilter === "all" ? statMembers : statMembers.filter(m => m.jira_username === statMemberFilter);
    if (filtered.length === 0) { setStatError("Không có thành viên nào được chọn."); return; }

    const usernames = filtered.map(m => `"${m.jira_username}"`).join(", ");
    const projectFilter = statProjects.length > 0
      ? `project in (${statProjects.map(p => `"${p}"`).join(", ")}) AND `
      : "";
    const statusClause = statStatusFilter !== "all" ? ` AND status = "${statStatusFilter}"` : "";
    const dateClause = useStatDateFilter
      ? ` AND "Start date" >= "${statDateFrom}" AND "Start date" <= "${statDateTo}"`
      : "";

    const jql = `${projectFilter}assignee in (${usernames})${statusClause}${dateClause} ORDER BY updated DESC`;

    setStatLoading(true);
    setStatError("");
    setStatTasks([]);
    try {
      const issues = await getAllIssuesByJql(jql, 500);
      setStatTasks(issues);
    } catch (err: any) {
      setStatError("Lỗi tải dữ liệu: " + (err.message || "Không xác định"));
    } finally {
      setStatLoading(false);
    }
  };

  // Effort summary: only closed/done tasks
  const effortByMember = useCallback(() => {
    const closedStatuses = ["closed", "done"];
    const closed = statTasks.filter(i =>
      closedStatuses.includes(i.fields.status.name.toLowerCase())
    );
    const map: Record<string, { displayName: string; username: string; timeSpent: number; count: number }> = {};
    closed.forEach(issue => {
      const a = issue.fields.assignee;
      if (!a) return;
      const key = a.name || a.accountId;
      if (!map[key]) map[key] = { displayName: a.displayName, username: key, timeSpent: 0, count: 0 };
      map[key].timeSpent += issue.fields.timetracking?.timeSpentSeconds || 0;
      map[key].count += 1;
    });
    return Object.values(map).sort((a, b) => b.timeSpent - a.timeSpent);
  }, [statTasks]);

  const statTasksByMember = React.useMemo(() => {
    const groups: Record<string, { member: { displayName: string; username: string }, issues: JiraIssue[] }> = {};
    
    // Khởi tạo sẵn tất cả các thành viên được filter, để ai cũng có dashboard dù chưa có task
    const relevantMembers = statMemberFilter === "all" 
      ? statMembers 
      : statMembers.filter(m => m.jira_username === statMemberFilter);
      
    relevantMembers.forEach(m => {
      groups[m.jira_username] = { 
        member: { displayName: m.display_name || m.jira_username, username: m.jira_username }, 
        issues: [] 
      };
    });

    statTasks.forEach(issue => {
      const a = issue.fields.assignee;
      const username = a?.name || a?.accountId || a?.emailAddress || "unassigned";
      const displayName = a?.displayName || "Chưa assign";
      
      if (!groups[username]) {
        groups[username] = { member: { displayName, username }, issues: [] };
      }
      groups[username].issues.push(issue);
    });
    return Object.values(groups).sort((a, b) => b.issues.length - a.issues.length);
  }, [statTasks, statMembers, statMemberFilter]);

  const teamStats = React.useMemo(() => {
    let uatBugs = 0;
    let prodBugs = 0;
    let tasks = 0;
    let estimateSecs = 0;
    let loggedSecs = 0;

    statTasks.forEach(t => {
      const type = t.fields.issuetype?.name?.toLowerCase() || "";
      if (type.includes("uat bug")) {
        uatBugs++;
      } else if (type.includes("production bug") || type === "bug") {
        prodBugs++;
      } else {
        tasks++;
      }
      
      estimateSecs += t.fields.timetracking?.originalEstimateSeconds || 0;
      loggedSecs += t.fields.timetracking?.timeSpentSeconds || 0;
    });

    return { uatBugs, prodBugs, tasks, estimateSecs, loggedSecs };
  }, [statTasks]);

  // ─── Render helpers ────────────────────────────────────────────────────────

  const tabs: { id: Tab; icon: string; label: string }[] = [
    { id: "teams",    icon: "🏢", label: "Quản lý Teams" },
    { id: "members",  icon: "👥", label: "Thành viên" },
    { id: "subtasks", icon: "🤖", label: "Tạo Sub-tasks AI" },
    { id: "tasks",    icon: "📋", label: "Danh sách Task" },
    { id: "statistics", icon: "📈", label: "Thống kê" },
  ];

  if (!isConfigured) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div className="page-header">
          <div className="page-title-group">
            <h1 className="page-title">Quản lý Team</h1>
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
          <h1 className="page-title">Quản lý Team</h1>
          <p className="page-subtitle">Quản lý nhóm, thành viên, phân công sub-task và theo dõi nỗ lực</p>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ padding: "0 24px", borderBottom: "1px solid var(--border)", display: "flex", gap: 4 }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "10px 16px",
              fontSize: 13,
              fontWeight: activeTab === tab.id ? 600 : 400,
              color: activeTab === tab.id ? "var(--accent-blue)" : "var(--text-secondary)",
              borderBottom: activeTab === tab.id ? "2px solid var(--accent-blue)" : "2px solid transparent",
              marginBottom: -1,
              display: "flex",
              alignItems: "center",
              gap: 6,
              transition: "color 0.15s",
            }}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      <div className="page-body" style={{ overflowY: "auto" }}>

        {/* ─── TAB 1: Quản lý Teams ─────────────────────────────────────────── */}
        {activeTab === "teams" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 24, alignItems: "start" }}>
            {/* Team list */}
            <div className="settings-section">
              <div className="settings-section-title">Danh sách Teams</div>
              <div className="settings-section-desc">Click vào team để chỉnh sửa, hoặc nhấn Thêm Team để tạo mới.</div>

              {teamsLoading ? (
                <div style={{ textAlign: "center", padding: 32, opacity: 0.5 }}>Đang tải...</div>
              ) : teams.length === 0 ? (
                <div className="empty-state" style={{ padding: "40px 0" }}>
                  <div className="empty-state-icon">🏢</div>
                  <div className="empty-state-title">Chưa có team nào</div>
                  <p className="empty-state-text">Nhấn "Thêm Team" để tạo team đầu tiên.</p>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
                  {teams.map(team => (
                    <div
                      key={team.id}
                      style={{
                        background: "var(--bg-card)",
                        border: `1px solid ${editingTeam?.id === team.id ? "var(--accent-blue)" : "var(--border)"}`,
                        borderRadius: 10,
                        padding: "12px 16px",
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text-primary)" }}>{team.name}</div>
                        {team.description && (
                          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {team.description}
                          </div>
                        )}
                        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                          {team.project_key && (
                            <span className="badge badge-todo" style={{ fontSize: 11 }}>{team.project_key}</span>
                          )}
                          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>👥 {team.member_count} thành viên</span>
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => startEditTeam(team)}>✏️</button>
                        <button className="btn btn-secondary btn-sm" style={{ color: "var(--accent-red)" }} onClick={() => handleDeleteTeam(team.id, team.name)}>🗑️</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Team form */}
            <div className="settings-section" style={{ position: "sticky", top: 0 }}>
              <div className="settings-section-title">{editingTeam ? "Chỉnh sửa Team" : "Thêm Team mới"}</div>

              <form onSubmit={handleSaveTeam} style={{ marginTop: 12 }}>
                <div className="form-group">
                  <label>Tên Team *</label>
                  <input
                    type="text"
                    placeholder="Ví dụ: Team Backend, Nhóm Frontend..."
                    value={teamForm.name}
                    onChange={e => setTeamForm(f => ({ ...f, name: e.target.value }))}
                    disabled={teamSaving}
                    required
                  />
                </div>

                <div className="form-group">
                  <label>Mô tả</label>
                  <textarea
                    placeholder="Mô tả ngắn về team..."
                    value={teamForm.description}
                    onChange={e => setTeamForm(f => ({ ...f, description: e.target.value }))}
                    disabled={teamSaving}
                    rows={3}
                  />
                </div>

                <div className="form-group">
                  <label>Dự án mặc định</label>
                  <select
                    value={teamForm.project_key}
                    onChange={e => setTeamForm(f => ({ ...f, project_key: e.target.value }))}
                    disabled={teamSaving}
                  >
                    <option value="">-- Không gán --</option>
                    {JIRA_PROJECTS.map(p => (
                      <option key={p.key} value={p.key}>{p.name} ({p.key})</option>
                    ))}
                  </select>
                </div>

                {teamError && (
                  <div style={{ color: "var(--accent-red)", fontSize: 12, marginBottom: 8 }}>⚠️ {teamError}</div>
                )}

                <div style={{ display: "flex", gap: 8 }}>
                  <button type="submit" className="btn btn-primary" disabled={teamSaving} style={{ flex: 1 }}>
                    {teamSaving ? "Đang lưu..." : editingTeam ? "Cập nhật Team" : "Thêm Team"}
                  </button>
                  {editingTeam && (
                    <button type="button" className="btn btn-secondary" onClick={startCreateTeam} disabled={teamSaving}>
                      Hủy
                    </button>
                  )}
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ─── TAB 2: Thành viên ────────────────────────────────────────────── */}
        {activeTab === "members" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Team selector */}
            <div className="settings-section">
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Chọn Team</label>
                <select
                  value={selectedTeamId || ""}
                  onChange={e => {
                    const v = Number(e.target.value);
                    setSelectedTeamId(v || null);
                    startAddMember();
                  }}
                >
                  <option value="">-- Chọn team --</option>
                  {teams.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {selectedTeamId && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 24, alignItems: "start" }}>
                {/* Member list */}
                <div className="settings-section">
                  <div className="settings-section-title">Thành viên của "{selectedTeam?.name}"</div>

                  {membersLoading ? (
                    <div style={{ textAlign: "center", padding: 32, opacity: 0.5 }}>Đang tải...</div>
                  ) : members.length === 0 ? (
                    <div className="empty-state" style={{ padding: "32px 0" }}>
                      <div className="empty-state-icon">👤</div>
                      <div className="empty-state-title">Chưa có thành viên</div>
                      <p className="empty-state-text">Thêm thành viên từ form bên phải.</p>
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
                      {members.map(m => (
                        <div
                          key={m.id}
                          style={{
                            background: "var(--bg-card)",
                            border: `1px solid ${editingMember?.id === m.id ? "var(--accent-blue)" : "var(--border)"}`,
                            borderRadius: 10,
                            padding: "12px 16px",
                            display: "flex",
                            alignItems: "center",
                            gap: 12,
                          }}
                        >
                          <div
                            style={{
                              width: 36, height: 36, borderRadius: "50%",
                              background: "var(--accent-blue)",
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: 14, fontWeight: 700, color: "#fff", flexShrink: 0,
                            }}
                          >
                            {(m.display_name || m.jira_username).charAt(0).toUpperCase()}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 13 }}>{m.display_name || m.jira_username}</div>
                            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>@{m.jira_username}</div>
                            {m.role && <span className="badge badge-todo" style={{ fontSize: 11, marginTop: 2 }}>{m.role}</span>}
                          </div>
                          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                            <button className="btn btn-secondary btn-sm" onClick={() => startEditMember(m)}>✏️</button>
                            <button className="btn btn-secondary btn-sm" style={{ color: "var(--accent-red)" }} onClick={() => handleDeleteMember(m)}>🗑️</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Member form */}
                <div className="settings-section" style={{ position: "sticky", top: 0 }}>
                  <div className="settings-section-title">{editingMember ? "Sửa thành viên" : "Thêm thành viên"}</div>

                  <form onSubmit={handleSaveMember} style={{ marginTop: 12 }}>
                    <div className="form-group">
                      <label>Tài khoản Jira *</label>
                      {assignableUsers.length > 0 ? (
                        <select
                          value={memberForm.jira_username}
                          onChange={e => handleMemberUsernameChange(e.target.value)}
                          disabled={memberSaving}
                        >
                          <option value="">-- Chọn hoặc nhập thủ công --</option>
                          {assignableUsers.map(u => (
                            <option key={u.accountId || u.name} value={u.name || u.accountId}>
                              {u.displayName} ({u.name || u.accountId})
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          placeholder="Nhập username Jira, ví dụ: nguyenvana"
                          value={memberForm.jira_username}
                          onChange={e => setMemberForm(f => ({ ...f, jira_username: e.target.value }))}
                          disabled={memberSaving}
                        />
                      )}
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                        {assignableUsers.length > 0
                          ? "Danh sách từ project mặc định của team."
                          : "Team chưa có project mặc định. Bạn có thể nhập thủ công."}
                      </div>
                    </div>

                    <div className="form-group">
                      <label>Tên hiển thị</label>
                      <input
                        type="text"
                        placeholder="Ví dụ: Nguyễn Văn A"
                        value={memberForm.display_name}
                        onChange={e => setMemberForm(f => ({ ...f, display_name: e.target.value }))}
                        disabled={memberSaving}
                      />
                    </div>

                    <div className="form-group">
                      <label>Vai trò</label>
                      <input
                        type="text"
                        placeholder="Ví dụ: Backend, Frontend, Tester, BA..."
                        value={memberForm.role}
                        onChange={e => setMemberForm(f => ({ ...f, role: e.target.value }))}
                        disabled={memberSaving}
                      />
                    </div>

                    {memberError && (
                      <div style={{ color: "var(--accent-red)", fontSize: 12, marginBottom: 8 }}>⚠️ {memberError}</div>
                    )}

                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="submit" className="btn btn-primary" disabled={memberSaving} style={{ flex: 1 }}>
                        {memberSaving ? "Đang lưu..." : editingMember ? "Cập nhật" : "Thêm thành viên"}
                      </button>
                      {editingMember && (
                        <button type="button" className="btn btn-secondary" onClick={startAddMember} disabled={memberSaving}>
                          Hủy
                        </button>
                      )}
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ─── TAB 3: Tạo Sub-tasks AI ──────────────────────────────────────── */}
        {activeTab === "subtasks" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, alignItems: "start" }}>
            {/* Input panel */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div className="settings-section">
                <div className="settings-section-title">🤖 Cấu hình phân tích</div>
                <div className="settings-section-desc">
                  Chọn team và nhập key của Story/Task lớn. AI sẽ phân tích và phân công sub-task cho từng thành viên dựa trên vai trò.
                </div>

                <div className="form-group" style={{ marginTop: 12 }}>
                  <label>Chọn Team</label>
                  <select
                    value={subTaskTeamId || ""}
                    onChange={e => { setSubTaskTeamId(Number(e.target.value) || null); setParentIssue(null); setGeneratedTasks([]); setSubTaskLogs([]); }}
                  >
                    <option value="">-- Chọn team --</option>
                    {teams.map(t => <option key={t.id} value={t.id}>{t.name} ({t.member_count} TV)</option>)}
                  </select>
                </div>

                {subTaskTeamId && (
                  <>
                    {subTaskMembers.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
                        {subTaskMembers.map(m => (
                          <span key={m.id} style={{ background: "rgba(79,142,247,0.12)", color: "var(--accent-blue)", borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 500 }}>
                            {m.display_name || m.jira_username}{m.role ? ` · ${m.role}` : ""}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="form-group">
                      <label>Key của Issue cha *</label>
                      <div style={{ display: "flex", gap: 8 }}>
                        <input
                          type="text"
                          placeholder="Ví dụ: BXDCSDL-123"
                          value={parentIssueKey}
                          onChange={e => setParentIssueKey(e.target.value.toUpperCase())}
                          onKeyDown={e => e.key === "Enter" && handleFetchParent()}
                          style={{ flex: 1 }}
                        />
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={handleFetchParent}
                          disabled={fetchingParent || !parentIssueKey.trim()}
                        >
                          {fetchingParent ? "..." : "Tìm"}
                        </button>
                      </div>
                      {parentError && <div style={{ color: "var(--accent-red)", fontSize: 12, marginTop: 4 }}>⚠️ {parentError}</div>}
                    </div>

                    {parentIssue && (
                      <div style={{ background: "rgba(var(--accent-blue-rgb),0.05)", border: "1px solid var(--accent-blue)", borderRadius: 10, padding: "12px 14px", marginTop: 4 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                          <span style={{ fontWeight: 700, color: "var(--accent-blue)", fontSize: 13 }}>{parentIssue.key}</span>
                          <span className={getBadgeClass(parentIssue.fields.status.name)}>{parentIssue.fields.status.name}</span>
                          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{parentIssue.fields.issuetype.name}</span>
                        </div>
                        <div style={{ fontWeight: 500, fontSize: 13 }}>{parentIssue.fields.summary}</div>
                        {parentIssue.fields.description && (
                          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 6, maxHeight: 60, overflow: "hidden" }}>
                            {typeof parentIssue.fields.description === "string"
                              ? parentIssue.fields.description.substring(0, 200)
                              : "(mô tả dạng rich text)"}
                            ...
                          </div>
                        )}
                        {(parentIssue.fields.subtasks?.length ?? 0) > 0 && (
                          <div style={{ fontSize: 11, color: "var(--accent-orange)", marginTop: 6 }}>
                            ⚠️ Issue này đã có {parentIssue.fields.subtasks!.length} sub-task
                          </div>
                        )}
                      </div>
                    )}

                    {parentIssue && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={handleAnalyzeSubTasks}
                        disabled={analyzing || subTaskMembers.length === 0}
                        style={{ width: "100%", marginTop: 12 }}
                      >
                        {analyzing ? <><span className="spinning">⏳</span> Đang phân tích AI...</> : "✨ Phân tích & Phân công AI"}
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* Generated tasks editor */}
              {generatedTasks.length > 0 && (
                <div className="settings-section">
                  <div className="settings-section-title">📝 Sub-tasks được đề xuất (có thể chỉnh sửa)</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
                    {generatedTasks.map((task, idx) => (
                      <div key={idx} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
                        <input
                          type="text"
                          value={task.summary}
                          onChange={e => {
                            const n = [...generatedTasks];
                            n[idx].summary = e.target.value;
                            setGeneratedTasks(n);
                          }}
                          style={{ width: "100%", marginBottom: 8 }}
                          disabled={creatingSubTasks}
                        />
                        <div style={{ display: "flex", gap: 8 }}>
                          <select
                            value={task.assignee}
                            onChange={e => {
                              const n = [...generatedTasks];
                              n[idx].assignee = e.target.value;
                              setGeneratedTasks(n);
                            }}
                            style={{ flex: 1 }}
                            disabled={creatingSubTasks}
                          >
                            <option value="">-- Không assign --</option>
                            {subTaskMembers.map(m => (
                              <option key={m.id} value={m.jira_username}>
                                {m.display_name || m.jira_username}{m.role ? ` (${m.role})` : ""}
                              </option>
                            ))}
                          </select>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => setGeneratedTasks(generatedTasks.filter((_, i) => i !== idx))}
                            disabled={creatingSubTasks}
                          >🗑️</button>
                        </div>
                        {task.reason && (
                          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>💡 {task.reason}</div>
                        )}
                      </div>
                    ))}
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => setGeneratedTasks([...generatedTasks, { summary: "", assignee: "", reason: "" }])}
                      disabled={creatingSubTasks}
                      style={{ alignSelf: "flex-start" }}
                    >
                      ➕ Thêm sub-task
                    </button>
                  </div>

                  <button
                    className="btn btn-primary"
                    onClick={handleCreateSubTasks}
                    disabled={creatingSubTasks || generatedTasks.filter(t => t.summary.trim()).length === 0}
                    style={{ width: "100%", marginTop: 16 }}
                  >
                    {creatingSubTasks ? <><span className="spinning">🌀</span> Đang tạo...</> : `🚀 Tạo ${generatedTasks.filter(t => t.summary.trim()).length} Sub-tasks`}
                  </button>
                </div>
              )}
            </div>

            {/* Log panel */}
            <div className="settings-section" style={{ minHeight: 300 }}>
              <div className="settings-section-title">📋 Kết quả tạo Sub-tasks</div>
              <div
                style={{
                  background: "rgba(0,0,0,0.15)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: 16,
                  marginTop: 12,
                  minHeight: 200,
                  maxHeight: 600,
                  overflowY: "auto",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                {subTaskLogs.length === 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 160, opacity: 0.5 }}>
                    <span style={{ fontSize: 32, marginBottom: 8 }}>🤖</span>
                    <span style={{ fontSize: 13 }}>Kết quả tạo sub-task sẽ hiển thị ở đây.</span>
                  </div>
                ) : (
                  subTaskLogs.map((log, idx) => (
                    <div key={idx} style={{ background: "var(--bg-card)", borderRadius: 8, padding: "10px 14px", border: "1px solid var(--border)", fontSize: 13 }}>
                      <div style={{ fontWeight: 500, marginBottom: 2 }}>{log.summary}</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>👤 {log.assignee || "Không assign"}</div>
                      {log.status === "pending" && <span style={{ color: "var(--text-muted)" }}>⏳ Đang chờ</span>}
                      {log.status === "processing" && <span style={{ color: "var(--accent-blue)" }} className="spinning-slow">🌀 Đang tạo...</span>}
                      {log.status === "success" && (
                        <a
                          href={`https://20.84.97.109:3033/browse/${log.key}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: "var(--accent-green)", fontWeight: 700, textDecoration: "none", background: "rgba(16,185,129,0.1)", padding: "3px 8px", borderRadius: 6 }}
                        >
                          ✅ {log.key} ↗
                        </a>
                      )}
                      {log.status === "error" && <span style={{ color: "var(--accent-red)" }}>❌ {log.error}</span>}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* ─── TAB 4: Danh sách Task ───────────────────────────────────── */}
        {activeTab === "tasks" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Filters */}
            <div className="settings-section">
              <div className="settings-section-title">Bộ lọc</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginTop: 12 }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label>Team</label>
                  <select value={taskTeamId || ""} onChange={e => { setTaskTeamId(Number(e.target.value) || null); setTeamTasks([]); }}>
                    <option value="">-- Chọn team --</option>
                    {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label>Thành viên</label>
                  <select value={taskMemberFilter} onChange={e => setTaskMemberFilter(e.target.value)} disabled={!taskTeamId}>
                    <option value="all">Tất cả thành viên</option>
                    {taskMembers.map(m => (
                      <option key={m.id} value={m.jira_username}>{m.display_name || m.jira_username}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label>Trạng thái</label>
                  <select value={taskStatusFilter} onChange={e => setTaskStatusFilter(e.target.value)}>
                    {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label>Dự án</label>
                  <select
                    multiple
                    value={taskProjects}
                    onChange={e => setTaskProjects(Array.from(e.target.selectedOptions, o => o.value))}
                    style={{ height: 60 }}
                  >
                    {JIRA_PROJECTS.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", fontWeight: "normal" }}>
                  <input
                    type="checkbox"
                    checked={useDateFilter}
                    onChange={e => setUseDateFilter(e.target.checked)}
                    style={{ margin: 0, cursor: "pointer" }}
                  />
                  Lọc theo khoảng thời gian cập nhật
                </label>
                {useDateFilter && (
                  <>
                    <input type="date" value={taskDateFrom} onChange={e => setTaskDateFrom(e.target.value)} style={{ width: 150 }} />
                    <span style={{ color: "var(--text-muted)", fontSize: 12 }}>đến</span>
                    <input type="date" value={taskDateTo} onChange={e => setTaskDateTo(e.target.value)} style={{ width: 150 }} />
                  </>
                )}
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleFetchTeamTasks}
                  disabled={tasksLoading || !taskTeamId || taskMembers.length === 0}
                  style={{ marginLeft: "auto" }}
                >
                  {tasksLoading ? <><span className="spinning">🌀</span> Đang tải...</> : "🔍 Tìm kiếm"}
                </button>
              </div>

              {tasksError && <div style={{ color: "var(--accent-red)", fontSize: 12, marginTop: 8 }}>⚠️ {tasksError}</div>}
            </div>
            {/* Task list */}
            {teamTasks.length > 0 && (
              <div className="settings-section">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div className="settings-section-title" style={{ margin: 0 }}>
                    Danh sách Issues ({teamTasks.length})
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    Closed/Done: {teamTasks.filter(i => ["closed","done"].includes(i.fields.status.name.toLowerCase())).length} task
                  </div>
                </div>

                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-secondary)" }}>
                        <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 500, width: 100 }}>Key</th>
                        <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 500 }}>Tiêu đề</th>
                        <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 500, width: 110 }}>Trạng thái</th>
                        <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 500, width: 140 }}>Assignee</th>
                        <th style={{ padding: "8px 12px", textAlign: "right", fontWeight: 500, width: 80 }}>Estimate</th>
                        <th style={{ padding: "8px 12px", textAlign: "right", fontWeight: 500, width: 80 }}>Logged</th>
                      </tr>
                    </thead>
                    <tbody>
                      {teamTasks.map(issue => {
                        const isClosed = ["closed","done"].includes(issue.fields.status.name.toLowerCase());
                        return (
                          <tr
                            key={issue.key}
                            style={{
                              borderBottom: "1px solid var(--border)",
                              background: isClosed ? "rgba(16,185,129,0.04)" : undefined,
                            }}
                          >
                            <td style={{ padding: "8px 12px" }}>
                              <a
                                href={`https://20.84.97.109:3033/browse/${issue.key}`}
                                target="_blank"
                                rel="noreferrer"
                                style={{ color: "var(--accent-blue)", fontWeight: 600, textDecoration: "none", fontSize: 12 }}
                              >
                                {issue.key}
                              </a>
                            </td>
                            <td style={{ padding: "8px 12px", color: "var(--text-primary)", maxWidth: 300 }}>
                              <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {issue.fields.summary}
                              </div>
                            </td>
                            <td style={{ padding: "8px 12px" }}>
                              <span className={getBadgeClass(issue.fields.status.name)}>{issue.fields.status.name}</span>
                            </td>
                            <td style={{ padding: "8px 12px", fontSize: 12, color: "var(--text-secondary)" }}>
                              {issue.fields.assignee?.displayName || "—"}
                            </td>
                            <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 12 }}>
                              {formatSeconds(issue.fields.timetracking?.originalEstimateSeconds || 0) || "—"}
                            </td>
                            <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 12, color: isClosed ? "var(--accent-green)" : undefined }}>
                              {formatSeconds(issue.fields.timetracking?.timeSpentSeconds || 0) || "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {activeTab === "tasks" && !tasksLoading && teamTasks.length === 0 && taskTeamId && (
              <div className="empty-state" style={{ padding: "48px 0" }}>
                <div className="empty-state-icon">📋</div>
                <div className="empty-state-title">Chưa có dữ liệu</div>
                <p className="empty-state-text">Nhấn "Tìm kiếm" để tải danh sách task của team.</p>
              </div>
            )}
          </div>
        )}

        {/* ─── TAB 5: Thống kê ───────────────────────────────────── */}
        {activeTab === "statistics" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Bộ lọc riêng cho Thống kê */}
            <div className="settings-section">
              <div className="settings-section-title">Bộ lọc Thống kê</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginTop: 12 }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label>Team</label>
                  <select value={statTeamId || ""} onChange={e => { setStatTeamId(Number(e.target.value) || null); setStatTasks([]); }}>
                    <option value="">-- Chọn team --</option>
                    {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label>Thành viên</label>
                  <select value={statMemberFilter} onChange={e => setStatMemberFilter(e.target.value)} disabled={!statTeamId}>
                    <option value="all">Tất cả thành viên</option>
                    {statMembers.map(m => (
                      <option key={m.id} value={m.jira_username}>{m.display_name || m.jira_username}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label>Trạng thái</label>
                  <select value={statStatusFilter} onChange={e => setStatStatusFilter(e.target.value)}>
                    {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label>Dự án</label>
                  <select
                    multiple
                    value={statProjects}
                    onChange={e => setStatProjects(Array.from(e.target.selectedOptions, o => o.value))}
                    style={{ height: 60 }}
                  >
                    {JIRA_PROJECTS.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", fontWeight: "normal" }}>
                  <input
                    type="checkbox"
                    checked={useStatDateFilter}
                    onChange={e => setUseStatDateFilter(e.target.checked)}
                    style={{ margin: 0, cursor: "pointer" }}
                  />
                  Lọc theo khoảng thời gian (Start Date)
                </label>
                {useStatDateFilter && (
                  <>
                    <input type="date" value={statDateFrom} onChange={e => setStatDateFrom(e.target.value)} style={{ width: 150 }} />
                    <span style={{ color: "var(--text-muted)", fontSize: 12 }}>đến</span>
                    <input type="date" value={statDateTo} onChange={e => setStatDateTo(e.target.value)} style={{ width: 150 }} />
                  </>
                )}
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleFetchStatTasks}
                  disabled={statLoading || !statTeamId || statMembers.length === 0}
                  style={{ marginLeft: "auto" }}
                >
                  {statLoading ? <><span className="spinning">🌀</span> Đang tải...</> : "🔍 Tìm kiếm"}
                </button>
              </div>

              {statError && <div style={{ color: "var(--accent-red)", fontSize: 12, marginTop: 8 }}>⚠️ {statError}</div>}
            </div>

            {/* Team Dashboard Metrics (Per Member) */}
            {statTasksByMember.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
                {statTasksByMember.map(group => (
                  <div key={group.member.username} style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 16, padding: "20px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, paddingBottom: 16, borderBottom: "1px solid var(--border)" }}>
                      <div style={{ width: 40, height: 40, borderRadius: 20, background: "rgba(79, 142, 247, 0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>
                        👤
                      </div>
                      <div>
                        <div style={{ fontSize: 18, fontWeight: 700 }}>{group.member.displayName}</div>
                        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>@{group.member.username}</div>
                      </div>
                      <div style={{ marginLeft: "auto", background: "rgba(16, 185, 129, 0.1)", color: "var(--accent-green)", padding: "4px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600 }}>
                        {group.issues.length} Issues
                      </div>
                    </div>
                    <TeamDashboardMetrics issues={group.issues} member={group.member} />
                  </div>
                ))}
              </div>
            )}

            {/* Effort summary list */}
            {statTasks.length > 0 && effortByMember().length > 0 && (
              <div className="settings-section">
                <div className="settings-section-title">📊 Tổng hợp nỗ lực (Task Closed/Done)</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
                  Chỉ tính các task có trạng thái <strong>Closed</strong> hoặc <strong>Done</strong>. Dùng để báo cáo nỗ lực cuối tháng cho QA.
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
                  {effortByMember().map(item => (
                    <div key={item.username} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 16px" }}>
                      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{item.displayName}</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>@{item.username}</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color: "var(--accent-green)" }}>{formatSeconds(item.timeSpent)}</div>
                      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>{item.count} task đã đóng</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!statLoading && statTasks.length === 0 && statTeamId && (
              <div className="empty-state" style={{ padding: "48px 0" }}>
                <div className="empty-state-icon">📈</div>
                <div className="empty-state-title">Chưa có dữ liệu thống kê</div>
                <p className="empty-state-text">Nhấn "Tìm kiếm" để tải danh sách và thống kê cho team.</p>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
