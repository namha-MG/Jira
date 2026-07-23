import axios from "axios";
import https from "https";

export function getJiraApi(pat: string) {
  return axios.create({
    baseURL: "https://20.84.97.109:3033/rest/api/2",
    headers: {
      Authorization: `Bearer ${pat}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Atlassian-Token": "no-check",
    },
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  });
}

export async function getMyIssues(api: any, projectKeys?: string[]) {
  let jql = `assignee = currentUser() ORDER BY updated DESC`;
  if (projectKeys && projectKeys.length > 0) {
    const projectFilter = projectKeys.map((k) => `"${k}"`).join(", ");
    jql = `project in (${projectFilter}) AND assignee = currentUser() ORDER BY updated DESC`;
  }

  const maxResults = 100;
  const issues: any[] = [];
  let startAt = 0;
  let total = 0;

  do {
    const res = await api.get("/search", {
      params: {
        jql,
        startAt,
        maxResults,
        fields: "summary,status,priority,assignee,timetracking,worklog,created,updated,duedate,project,issuetype,customfield_10300,customfield_10302",
      },
    });
    const pageIssues = res.data.issues || [];
    total = res.data.total || pageIssues.length;
    issues.push(...pageIssues);
    startAt += pageIssues.length;

    if (pageIssues.length === 0) break;
  } while (startAt < total);

  return {
    issues,
    total,
    startAt: 0,
    maxResults: issues.length,
  };
}

export async function getTransitions(api: any, issueKey: string) {
  const res = await api.get(`/issue/${issueKey}/transitions`);
  return res.data.transitions;
}

export async function transitionIssue(api: any, issueKey: string, transitionId: string, fields?: any) {
  const payload: any = {
    transition: { id: transitionId },
  };
  if (fields) {
    payload.fields = fields;
  }
  await api.post(`/issue/${issueKey}/transitions`, payload);
}

export async function addWorklog(api: any, issueKey: string, timeSpentSeconds: number, comment: string) {
  const started = new Date().toISOString().replace("Z", "+0000");
  await api.post(`/issue/${issueKey}/worklog`, {
    timeSpentSeconds,
    comment,
    started,
  });
}
