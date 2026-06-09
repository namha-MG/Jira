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

  const res = await api.get("/search", {
    params: {
      jql,
      maxResults: 100,
      fields: "summary,status,priority,assignee,timetracking,worklog,created,updated,duedate,project,issuetype,customfield_10300,customfield_10302",
    },
  });
  return res.data;
}

export async function getTransitions(api: any, issueKey: string) {
  const res = await api.get(`/issue/${issueKey}/transitions`);
  return res.data.transitions;
}

export async function transitionIssue(api: any, issueKey: string, transitionId: string) {
  await api.post(`/issue/${issueKey}/transitions`, {
    transition: { id: transitionId },
  });
}

export async function addWorklog(api: any, issueKey: string, timeSpentSeconds: number, comment: string) {
  const started = new Date().toISOString().replace("Z", "+0000");
  await api.post(`/issue/${issueKey}/worklog`, {
    timeSpentSeconds,
    comment,
    started,
  });
}
