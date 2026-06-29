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

export const jiraAgileApi = axios.create({
  baseURL: "/jira-api/rest/agile/1.0",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Atlassian-Token": "no-check",
  },
});

export const greenhopperApi = axios.create({
  baseURL: "/jira-api/rest/greenhopper/1.0",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Atlassian-Token": "no-check",
  },
});

jiraApi.interceptors.request.use((config) => {
  config.headers = { ...config.headers, ...getAuthHeader() } as typeof config.headers;
  return config;
});
jiraAgileApi.interceptors.request.use((config) => {
  config.headers = { ...config.headers, ...getAuthHeader() } as typeof config.headers;
  return config;
});
greenhopperApi.interceptors.request.use((config) => {
  config.headers = { ...config.headers, ...getAuthHeader() } as typeof config.headers;
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
    aggregatetimespent?: number;
    aggregatetimeoriginalestimate?: number;
    aggregateprogress?: {
      progress: number;
      total: number;
      percent: number;
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
    customfield_10302?: string;
    parent?: { key: string; fields?: any; };
    subtasks?: {
      id: string;
      key: string;
      fields: {
        summary: string;
        status: { name: string; statusCategory: { colorName: string } };
        issuetype: { name: string; iconUrl: string };
        priority: { name: string; iconUrl: string };
      };
    }[];
    comment?: {
      comments: JiraComment[];
      total: number;
    };
    attachment?: any[];
  };
  changelog?: {
    histories: JiraChangelogHistory[];
    total: number;
  };
};

export type JiraChangelogItem = {
  field: string;
  fieldtype: string;
  from: string | null;
  fromString: string | null;
  to: string | null;
  toString: string | null;
};

export type JiraChangelogHistory = {
  id: string;
  author: JiraUser;
  created: string;
  items: JiraChangelogItem[];
};

export type JiraComment = {
  id: string;
  author: JiraUser;
  body: string;
  created: string;
  updated: string;
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
    "project", "issuetype", "description", "customfield_10300", "attachment",
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
  const res = await jiraApi.get(`/issue/${issueKey}?expand=changelog`);
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
  let jql = `(assignee = ${assigneeSelector} OR worklogAuthor = ${assigneeSelector}) ORDER BY updated DESC`;
  if (projectKeys && projectKeys.length > 0) {
    const projectFilter = projectKeys.map((k) => `"${k}"`).join(", ");
    jql = `project in (${projectFilter}) AND (assignee = ${assigneeSelector} OR worklogAuthor = ${assigneeSelector}) ORDER BY updated DESC`;
  }

  const fields = "summary,status,priority,assignee,timetracking,aggregatetimespent,aggregatetimeoriginalestimate,aggregateprogress,worklog,created,updated,duedate,project,issuetype,customfield_10300,customfield_10302,parent,attachment";
  const pageSize = Math.min(maxResults, 100);
  let startAt = 0;
  let allIssues: JiraIssue[] = [];
  let total = 0;

  while (allIssues.length < maxResults) {
    const res = await jiraApi.get("/search", {
      params: {
        jql,
        maxResults: pageSize,
        startAt,
        fields,
      },
    });

    const issues = res.data.issues || [];
    total = res.data.total || 0;
    allIssues = allIssues.concat(issues);

    if (issues.length === 0 || allIssues.length >= total) {
      break;
    }

    startAt += pageSize;
  }

  return {
    issues: allIssues.slice(0, maxResults),
    total,
  };
}

/** Lấy TẤT CẢ issues thỏa mãn JQL (tự động phân trang ngầm để vượt qua giới hạn 100) */
export async function getAllIssuesByJql(
  jql: string,
  maxLimit: number = 2000
): Promise<JiraIssue[]> {
  const fields = [
    "summary", "status", "priority", "assignee", "reporter",
    "timetracking", "worklog", "created", "updated", "duedate",
    "project", "issuetype", "description", "customfield_10300", "customfield_10302", "parent", "subtasks", "attachment"
  ];
  let allIssues: JiraIssue[] = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const res = await jiraApi.get("/search", {
      params: { jql, maxResults, startAt, fields: fields.join(",") },
    });

    const { issues, total } = res.data;
    if (issues && issues.length > 0) {
      allIssues = allIssues.concat(issues);
    }

    if (!issues || issues.length === 0 || allIssues.length >= total || allIssues.length >= maxLimit) {
      break;
    }
    startAt += maxResults;
  }

  return allIssues;
}

/** Lấy worklogs của issue */
export async function getWorklogs(issueKey: string): Promise<JiraWorklog[]> {
  const maxResults = 100;
  let startAt = 0;
  let allWorklogs: JiraWorklog[] = [];

  while (true) {
    const res = await jiraApi.get(`/issue/${issueKey}/worklog`, {
      params: { startAt, maxResults },
    });
    const worklogs = res.data.worklogs || [];
    allWorklogs = allWorklogs.concat(worklogs);

    const total = res.data.total ?? allWorklogs.length;
    if (worklogs.length === 0 || allWorklogs.length >= total) {
      break;
    }

    startAt += maxResults;
  }

  return allWorklogs;
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

/** Xóa worklog của issue */
export async function deleteWorklog(
  issueKey: string,
  worklogId: string,
  adjustEstimate: string = "auto"
): Promise<void> {
  await jiraApi.delete(`/issue/${issueKey}/worklog/${worklogId}`, {
    params: { adjustEstimate },
  });
}

/** Gán issue cho một user */
export async function assignIssue(
  issueKey: string,
  assigneeName: string
): Promise<void> {
  const isUnassigned = !assigneeName || assigneeName.trim() === "";
  const nameToAssign = isUnassigned ? "-1" : assigneeName.trim();

  try {
    await jiraApi.put(`/issue/${issueKey}/assignee`, {
      name: nameToAssign,
    });
  } catch (err: any) {
    console.warn("assignee API failed, trying fallback update issue:", err);
    await jiraApi.put(`/issue/${issueKey}`, {
      fields: {
        assignee: isUnassigned ? null : { name: nameToAssign }
      }
    });
  }
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

/** Lấy danh sách user có thể gán trong một project */
export async function getAssignableUsers(projectKey: string): Promise<JiraUser[]> {
  try {
    const res = await jiraApi.get("/user/assignable/search", {
      params: { project: projectKey, maxResults: 1000 }
    });
    return res.data;
  } catch (err) {
    console.warn("Failed to get assignable users for", projectKey, err);
    return [];
  }
}

/** Lấy metadata tạo issue động cho dự án (Hỗ trợ Jira 9.0+ và các bản cũ hơn) */
export async function getProjectCreateMeta(projectKey: string, issueTypeName: string = "Task"): Promise<{ projectId: string; issuetypeId: string } | null> {
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
        t.name.toLowerCase().includes(issueTypeName.toLowerCase()) ||
        t.name.toLowerCase() === issueTypeName.toLowerCase()
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
          t.name.toLowerCase().includes(issueTypeName.toLowerCase()) ||
          t.name.toLowerCase() === issueTypeName.toLowerCase()
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
  issueTypeName?: string;
  customFields?: Record<string, any>;
}): Promise<JiraIssue> {
  const meta = await getProjectCreateMeta(options.projectKey, options.issueTypeName || "Task");

  const fields: any = {
    project: meta ? { id: meta.projectId } : { key: options.projectKey },
    summary: options.summary,
    issuetype: meta ? { id: meta.issuetypeId } : { name: options.issueTypeName || "Task" },
  };

  if (options.customFields) {
    Object.assign(fields, options.customFields);
  }

  if (options.originalEstimate) {
    fields.timetracking = {
      originalEstimate: options.originalEstimate,
    };
  }

  if (options.assigneeName !== undefined) {
    if (options.assigneeName.trim()) {
      fields.assignee = { name: options.assigneeName.trim() };
    }
    // If it's an empty string, we explicitly DO NOT auto-assign to current user.
    // We let Jira use the project's default (which is usually Unassigned).
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

/** Tạo Sub-task cho một Issue cha */
export async function createSubTask(options: {
  parentKey: string;
  projectKey: string;
  summary: string;
  assigneeName?: string;
  originalEstimate?: string;
  customFields?: Record<string, any>;
}): Promise<JiraIssue> {
  // 1. Fetch project info to get the valid sub-task issue type
  const projRes = await jiraApi.get(`/project/${options.projectKey}`);
  const issuetypes = projRes.data.issueTypes;
  const subTaskType = issuetypes.find((t: any) => t.subtask);

  if (!subTaskType) {
    throw new Error(`Dự án ${options.projectKey} không hỗ trợ loại Issue là Sub-task`);
  }

  const fields: any = {
    project: { key: options.projectKey },
    parent: { key: options.parentKey },
    summary: options.summary,
    issuetype: { id: subTaskType.id },
  };

  if (options.customFields) {
    Object.assign(fields, options.customFields);
  }

  if (options.originalEstimate) {
    fields.timetracking = {
      originalEstimate: options.originalEstimate,
    };
  }

  if (options.assigneeName !== undefined) {
    if (options.assigneeName.trim()) {
      fields.assignee = { name: options.assigneeName.trim() };
    }
    // If it's an empty string, we explicitly DO NOT auto-assign to current user.
  } else {
    try {
      const me = await getCurrentUser();
      const meName = me.name || me.accountId;
      fields.assignee = { name: meName };
    } catch (e) {
      console.warn("Auto-assignment failed for sub-task:", e);
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

let cachedFields: any[] | null = null;
export async function getJiraFields(): Promise<any[]> {
  if (cachedFields) return cachedFields;
  const res = await jiraApi.get("/field");
  cachedFields = res.data;
  return cachedFields;
}

/** Thực hiện chuyển đổi trạng thái (Transition) cho một Issue */
export async function transitionIssue(issueKey: string, transitionId: string, transitionFields?: any, comment?: string): Promise<void> {
  const payload: any = {
    transition: { id: transitionId },
  };
  if (transitionFields) {
    payload.fields = transitionFields;
  }
  if (comment) {
    payload.update = {
      comment: [
        {
          add: { body: comment }
        }
      ]
    };
  }
  await jiraApi.post(`/issue/${issueKey}/transitions`, payload);
}

/** Tự động sinh Output bằng AI */
export async function generateAiOutput(summary: string): Promise<string> {
  const fallback = "Hoàn thành công việc";
  const geminiKey = localStorage.getItem("gemini_api_key");
  if (!geminiKey) return fallback;

  try {
    const prompt = `Bạn là một lập trình viên. Hãy viết kết quả (Output) ngắn gọn (dưới 15 từ) cho công việc có tiêu đề: "${summary}". Ví dụ: "Đã fixed", "Đã cập nhật theo yêu cầu". Viết bằng tiếng Việt, ngắn gọn.`;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    if (response.ok) {
      const data = await response.json();
      const generated = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (generated) return generated;
    }
  } catch (e) {
    console.warn("Auto AI output generation failed", e);
  }
  return fallback;
}

/** Tìm ngày bắt đầu tiếp theo dựa trên task cuối cùng đã tạo/được gán */
export async function getLatestTaskDate(projectKeys: string[], assignee?: string): Promise<Date | null> {
  try {
    const res = await getMyIssues({ projectKeys, maxResults: 50, assignee });
    if (!res.issues || res.issues.length === 0) return null;

    let maxDate = new Date(0);
    let found = false;

    for (const issue of res.issues) {
      // Ưu tiên customfield_10302 (End Date) hoặc customfield_10300 (Start Date) hoặc created
      const dateStr = issue.fields.customfield_10302 || issue.fields.customfield_10300 || issue.fields.created;
      if (dateStr) {
        const d = new Date(dateStr);
        if (d > maxDate) {
          maxDate = d;
          found = true;
        }
      }
    }

    if (!found) return null;
    return maxDate;
  } catch (err) {
    console.warn("Failed to get latest task date", err);
    return null;
  }
}

export type JiraNotification = {
  id: string; // "comment-12345" or "history-12345"
  issueKey: string;
  issueSummary: string;
  authorName: string;
  authorAvatar: string;
  content: string; // body of comment, or description of change
  created: string;
  type: "comment" | "changelog";
};

/** Lấy thông báo từ những QA (hoaintt, dungta2) trong 14 ngày gần đây */
export async function getRecentNotificationsForUser(): Promise<JiraNotification[]> {
  const jql = `assignee = currentUser() AND updated >= -14d ORDER BY updated DESC`;
  const maxResults = 50;

  try {
    const res = await jiraApi.get("/search", {
      params: {
        jql,
        maxResults,
        fields: "summary,comment",
        expand: "changelog"
      }
    });

    const issues = res.data.issues || [];
    const notifications: JiraNotification[] = [];
    const targetUsers = ["hoaintt", "dungta2"]; // Tài khoản QA

    const isTargetUser = (u: JiraUser) => {
      if (!u) return false;
      const str = `${u.name} ${u.emailAddress} ${u.displayName}`.toLowerCase();
      return targetUsers.some(tu => str.includes(tu.toLowerCase()));
    };

    issues.forEach((issue: any) => {
      // 1. Kiểm tra comments
      if (issue.fields.comment && issue.fields.comment.comments) {
        issue.fields.comment.comments.forEach((c: any) => {
          if (isTargetUser(c.author)) {
            notifications.push({
              id: `comment-${c.id}`,
              issueKey: issue.key,
              issueSummary: issue.fields.summary,
              authorName: c.author.displayName || c.author.name,
              authorAvatar: c.author.avatarUrls?.["48x48"] || "",
              content: `Bình luận: ${c.body.substring(0, 100)}${c.body.length > 100 ? "..." : ""}`,
              created: c.created,
              type: "comment"
            });
          }
        });
      }

      // 2. Kiểm tra changelog (History)
      if (issue.changelog && issue.changelog.histories) {
        issue.changelog.histories.forEach((h: any) => {
          if (isTargetUser(h.author)) {
            const changes = h.items.map((i: any) => `${i.field} (${i.fromString || "trống"} ➔ ${i.toString || "trống"})`).join(", ");
            notifications.push({
              id: `history-${h.id}`,
              issueKey: issue.key,
              issueSummary: issue.fields.summary,
              authorName: h.author.displayName || h.author.name,
              authorAvatar: h.author.avatarUrls?.["48x48"] || "",
              content: `Đã thay đổi: ${changes}`,
              created: h.created,
              type: "changelog"
            });
          }
        });
      }
    });

    return notifications.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
  } catch (error) {
    console.error("Failed to fetch notifications:", error);
    return [];
  }
}

/** Upload attachment to an issue */
export async function uploadAttachment(issueKey: string, file: File): Promise<any> {
  const formData = new FormData();
  formData.append("file", file, file.name);

  const res = await jiraApi.post(`/issue/${issueKey}/attachments`, formData, {
    headers: {
      "Content-Type": "multipart/form-data",
      "X-Atlassian-Token": "no-check",
    },
  });
  return res.data; // usually an array of attachment objects
}

/** Add a comment to an issue */
export async function addComment(issueKey: string, body: string): Promise<any> {
  const res = await jiraApi.post(`/issue/${issueKey}/comment`, { body });
  return res.data;
}

/** Update original estimate of an issue */
export async function updateIssueEstimate(issueKey: string, originalEstimate: string): Promise<any> {
  const res = await jiraApi.put(`/issue/${issueKey}`, {
    update: {
      timetracking: [
        {
          edit: {
            originalEstimate: originalEstimate
          }
        }
      ]
    }
  });
  return res.data;
}

/** Raw PUT to update an issue */
export async function updateIssue(issueKey: string, payload: any): Promise<any> {
  const res = await jiraApi.put(`/issue/${issueKey}`, payload);
  return res.data;
}

// ===============================================
// AGILE & GREENHOPPER API FUNCTIONS
// ===============================================

export async function getBoards(projectKeyOrId?: string): Promise<any[]> {
  const params: any = {};
  if (projectKeyOrId) params.projectKeyOrId = projectKeyOrId;
  const res = await jiraAgileApi.get("/board", { params });
  return res.data.values || [];
}

export async function getSprints(boardId: number, state?: string): Promise<JiraSprint[]> {
  const params: any = {};
  if (state) params.state = state;
  const res = await jiraAgileApi.get(`/board/${boardId}/sprint`, { params });
  return res.data.values || [];
}

export async function getIssuesInSprint(sprintId: number, startAt: number = 0, maxResults: number = 100): Promise<{ issues: JiraIssue[]; total: number }> {
  const fields = "summary,status,priority,assignee,timetracking,aggregatetimespent,aggregatetimeoriginalestimate,aggregateprogress,worklog,created,updated,duedate,project,issuetype,customfield_10300,customfield_10302,parent,attachment";
  const res = await jiraAgileApi.get(`/sprint/${sprintId}/issue`, {
    params: { startAt, maxResults, fields }
  });
  return { issues: res.data.issues || [], total: res.data.total || 0 };
}

export async function createSprint(payload: { name: string; startDate?: string; endDate?: string; goal?: string; originBoardId: number }): Promise<JiraSprint> {
  const res = await jiraAgileApi.post("/sprint", payload);
  return res.data;
}

export async function startSprint(sprintId: number, payload: { name: string; startDate: string; endDate: string; goal?: string; rapidViewId: number }): Promise<any> {
  // Use Greenhopper API as requested
  const reqPayload = {
    ...payload,
    sprintId,
  };
  const res = await greenhopperApi.put(`/sprint/${sprintId}/start`, reqPayload);
  return res.data;
}

export async function moveIssuesToSprint(sprintId: number, issues: string[]): Promise<any> {
  const res = await jiraAgileApi.post(`/sprint/${sprintId}/issue`, { issues });
  return res.data;
}
