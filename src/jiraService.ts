import axios from "axios";

// Jira PAT được lưu trong localStorage
const getAuthHeader = () => {
  const pat = localStorage.getItem("jira_pat");
  if (pat) {
    return { Authorization: `Bearer ${pat}` };
  }
  const basic = localStorage.getItem("jira_basic");
  if (basic) {
    return { Authorization: `Basic ${basic}` };
  }
  return {};
};

const jiraApi = axios.create({
  // Dùng proxy của Vite để tránh CORS + SSL self-signed
  // /jira-api được rewrite thành https://20.84.97.109:3033 bởi vite.config.ts
  baseURL: "/jira-api/rest/api/2",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Atlassian-Token": "no-check",
  },
});

jiraApi.interceptors.request.use((config) => {
  config.headers = {
    ...config.headers,
    ...getAuthHeader(),
  } as typeof config.headers;
  return config;
});

// ===============================================
// TYPES
// ===============================================
export type JiraUser = {
  accountId: string;
  name?: string;
  displayName: string;
  emailAddress: string;
  avatarUrls: { "48x48": string };
};

export type JiraIssue = {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: { name: string; statusCategory: { colorName: string } };
    priority: { name: string; iconUrl: string };
    assignee: JiraUser | null;
    reporter: JiraUser | null;
    timetracking: {
      originalEstimate?: string;
      remainingEstimate?: string;
      timeSpent?: string;
      originalEstimateSeconds?: number;
      remainingEstimateSeconds?: number;
      timeSpentSeconds?: number;
    };
    worklog?: {
      total: number;
      worklogs: JiraWorklog[];
    };
    created: string;
    updated: string;
    duedate?: string;
    project: { key: string; name: string };
    issuetype: { name: string; iconUrl: string };
    description?: string;
    customfield_10300?: string;
  };
};

export type JiraWorklog = {
  id: string;
  author: JiraUser;
  comment?: string;
  started: string;
  timeSpentSeconds: number;
  timeSpent: string;
  updated: string;
};

export type JiraSprint = {
  id: number;
  name: string;
  state: "active" | "closed" | "future";
  startDate?: string;
  endDate?: string;
};

// ===============================================
// API FUNCTIONS
// ===============================================

/** Test kết nối Jira */
export async function testConnection(): Promise<{ success: boolean; user?: JiraUser; error?: string }> {
  try {
    const res = await jiraApi.get("/myself");
    return { success: true, user: res.data };
  } catch (err: unknown) {
    const error = err as { response?: { status: number; data?: { errorMessages?: string[] } }; message?: string };
    const msg = error.response?.data?.errorMessages?.[0] || error.message || "Không thể kết nối";
    return { success: false, error: msg };
  }
}

/** Lấy thông tin user hiện tại */
export async function getCurrentUser(): Promise<JiraUser> {
  const res = await jiraApi.get("/myself");
  return res.data;
}

/** Lấy issues theo project với filter */
export async function getIssuesByProject(
  projectKey: string,
  options: {
    assigneeAccountId?: string;
    maxResults?: number;
    startAt?: number;
    fields?: string[];
  } = {}
): Promise<{ issues: JiraIssue[]; total: number }> {
  const { assigneeAccountId, maxResults = 50, startAt = 0 } = options;

  let jql = `project = ${projectKey} ORDER BY updated DESC`;
  if (assigneeAccountId) {
    jql = `project = ${projectKey} AND assignee = "${assigneeAccountId}" ORDER BY updated DESC`;
  }

  const fields = options.fields || [
    "summary", "status", "priority", "assignee", "reporter",
    "timetracking", "worklog", "created", "updated", "duedate",
    "project", "issuetype", "description", "customfield_10300",
  ];

  const res = await jiraApi.get("/search", {
    params: {
      jql,
      maxResults,
      startAt,
      fields: fields.join(","),
    },
  });

  return {
    issues: res.data.issues,
    total: res.data.total,
  };
}

/** Lấy thông tin chi tiết một Issue theo Key */
export async function getIssue(issueKey: string): Promise<JiraIssue> {
  const res = await jiraApi.get(`/issue/${issueKey}`);
  return res.data;
}

/** Lấy tất cả issues của user (all projects) hoặc theo assignee cụ thể */
export async function getMyIssues(options: {
  projectKeys?: string[];
  maxResults?: number;
  assignee?: string;
} = {}): Promise<{ issues: JiraIssue[]; total: number }> {
  const { projectKeys, maxResults = 100, assignee } = options;

  const assigneeSelector = assignee && assignee.trim() ? `"${assignee.trim()}"` : `currentUser()`;
  let jql = `assignee = ${assigneeSelector} ORDER BY updated DESC`;
  if (projectKeys && projectKeys.length > 0) {
    const projectFilter = projectKeys.map((k) => `"${k}"`).join(", ");
    jql = `project in (${projectFilter}) AND assignee = ${assigneeSelector} ORDER BY updated DESC`;
  }

  const res = await jiraApi.get("/search", {
    params: {
      jql,
      maxResults,
      fields: "summary,status,priority,assignee,timetracking,worklog,created,updated,duedate,project,issuetype,customfield_10300",
    },
  });

  return {
    issues: res.data.issues,
    total: res.data.total,
  };
}

/** Lấy worklogs của issue */
export async function getWorklogs(issueKey: string): Promise<JiraWorklog[]> {
  const res = await jiraApi.get(`/issue/${issueKey}/worklog`);
  return res.data.worklogs;
}

/** Thêm worklog vào issue */
export async function addWorklog(
  issueKey: string,
  options: {
    timeSpentSeconds: number;
    comment?: string;
    started?: string; // ISO date string
    adjustEstimate?: "auto" | "leave" | "manual" | "new";
  }
): Promise<JiraWorklog> {
  const { timeSpentSeconds, comment, started, adjustEstimate = "auto" } = options;

  const startedDate = started || new Date().toISOString().replace("Z", "+0000");

  const res = await jiraApi.post(
    `/issue/${issueKey}/worklog`,
    {
      timeSpentSeconds,
      comment: comment || "",
      started: startedDate,
    },
    {
      params: { adjustEstimate },
    }
  );

  return res.data;
}

/** Cập nhật estimate của issue */
export async function updateEstimate(
  issueKey: string,
  originalEstimateSeconds: number
): Promise<void> {
  await jiraApi.put(`/issue/${issueKey}`, {
    fields: {
      timetracking: {
        originalEstimate: `${Math.floor(originalEstimateSeconds / 3600)}h`,
      },
    },
  });
}

/** Lấy tất cả projects user có quyền truy cập */
export async function getProjects(): Promise<{ key: string; name: string; id: string }[]> {
  const res = await jiraApi.get("/project");
  return res.data.map((p: { key: string; name: string; id: string }) => ({
    key: p.key,
    name: p.name,
    id: p.id,
  }));
}

/** Lấy metadata tạo issue động cho dự án (Hỗ trợ Jira 9.0+ và các bản cũ hơn) */
export async function getProjectCreateMeta(projectKey: string): Promise<{ projectId: string; issuetypeId: string } | null> {
  try {
    let projectId = "";
    let issuetypeId = "10200"; // default fallback

    // 1. Lấy Project ID từ /project/{projectKey} (Hoạt động trên mọi phiên bản)
    try {
      const projRes = await jiraApi.get(`/project/${projectKey}`);
      if (projRes.data && projRes.data.id) {
        projectId = projRes.data.id;
      }
    } catch (err) {
      console.warn("Failed to fetch project details from /project/", projectKey, err);
    }

    // 2. Lấy Issue Types cho project qua endpoint mới của Jira 9.0+
    try {
      const res = await jiraApi.get(`/issue/createmeta/${projectKey}/issuetypes`);
      const list = Array.isArray(res.data) ? res.data : (res.data.values || []);
      const taskType = list.find((t: any) => 
        t.name.toLowerCase().includes("task") || 
        t.name.toLowerCase().includes("công việc") ||
        t.name.toLowerCase().includes("work")
      ) || list[0];

      if (taskType) {
        issuetypeId = taskType.id;
      }
      
      if (projectId && issuetypeId) {
        return { projectId, issuetypeId };
      }
    } catch (err) {
      console.warn("Failed to fetch /issue/createmeta/{key}/issuetypes, trying legacy endpoint", err);
    }

    // 3. Fallback cho Jira cũ (<9.0)
    try {
      const legacyRes = await jiraApi.get("/issue/createmeta", {
        params: {
          projectKeys: projectKey,
          expand: "projects.issuetypes",
        },
      });
      const project = legacyRes.data.projects?.[0];
      if (project) {
        const taskType = project.issuetypes.find((t: any) => 
          t.name.toLowerCase().includes("task") || 
          t.name.toLowerCase().includes("công việc") ||
          t.name.toLowerCase().includes("work")
        ) || project.issuetypes[0];

        return {
          projectId: projectId || project.id,
          issuetypeId: taskType?.id || "10200",
        };
      }
    } catch (legacyErr) {
      console.warn("Legacy createmeta failed too", legacyErr);
    }

    if (projectId) {
      return { projectId, issuetypeId };
    }
  } catch (e) {
    console.warn("Failed to fetch create metadata for project", projectKey, e);
  }
  return null;
}

/** Tạo mới Issue trên Jira với option Estimate và Assignee */
export async function createIssue(options: {
  projectKey: string;
  summary: string;
  assigneeName?: string;
  originalEstimate?: string;
  customFields?: Record<string, any>;
}): Promise<JiraIssue> {
  const meta = await getProjectCreateMeta(options.projectKey);

  const fields: any = {
    project: meta ? { id: meta.projectId } : { key: options.projectKey },
    summary: options.summary,
    issuetype: meta ? { id: meta.issuetypeId } : { name: "Task" },
  };

  if (options.customFields) {
    Object.assign(fields, options.customFields);
  }

  if (options.originalEstimate) {
    fields.timetracking = {
      originalEstimate: options.originalEstimate,
    };
  }

  if (options.assigneeName && options.assigneeName.trim()) {
    fields.assignee = { name: options.assigneeName.trim() };
  } else {
    try {
      const me = await getCurrentUser();
      const meName = me.name || me.accountId;
      fields.assignee = { name: meName };
    } catch (e) {
      console.warn("Auto-assignment failed, creating without assignee:", e);
    }
  }

  const res = await jiraApi.post("/issue", { fields });
  return res.data;
}

/** Format seconds sang string hiển thị */
export function formatSeconds(seconds: number): string {
  if (!seconds) return "0h";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/** Convert time string (e.g. "2h 30m", "1d", "90m") sang seconds */
export function parseTimeToSeconds(timeStr: string): number {
  if (!timeStr) return 0;
  let total = 0;
  const days = timeStr.match(/(\d+)\s*d/);
  const hours = timeStr.match(/(\d+)\s*h/);
  const minutes = timeStr.match(/(\d+)\s*m/);
  if (days) total += parseInt(days[1]) * 8 * 3600;
  if (hours) total += parseInt(hours[1]) * 3600;
  if (minutes) total += parseInt(minutes[1]) * 60;
  return total;
}

/** Lấy danh sách các transitions khả dụng của một Issue */
export async function getTransitions(issueKey: string): Promise<{ id: string; name: string; to: { name: string } }[]> {
  const res = await jiraApi.get(`/issue/${issueKey}/transitions`);
  return res.data.transitions;
}

/** Thực hiện chuyển đổi trạng thái (Transition) cho một Issue */
export async function transitionIssue(issueKey: string, transitionId: string): Promise<void> {
  await jiraApi.post(`/issue/${issueKey}/transitions`, {
    transition: { id: transitionId },
  });
}
