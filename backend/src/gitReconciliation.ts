import axios from "axios";
import https from "https";
import { getJiraApi } from "./jiraService";

type ProjectGitLinks = Record<string, string[]>;

type GitCommit = {
  repoUrl: string;
  provider: string;
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  committedAt: string;
  url: string;
  branches: string[];
};

type TelegramReportStatus = {
  sent: boolean;
  error?: string;
};

type LoggedTask = {
  accountKey: string;
  accountLabel: string;
  issueKey: string;
  projectKey: string;
  summary: string;
  worklogs: {
    id: string;
    comment: string;
    started: string;
    timeSpentSeconds: number;
  }[];
};

type GitIdentity = {
  ids: string[];
  names: string[];
  emails: string[];
};

type AccountTarget = {
  key: string;
  label: string;
  identity: GitIdentity;
};

type GitReconciliationResultRow = LoggedTask & {
  status: "matched" | "missing";
  matchedCommit: GitCommit | null;
  matchScore: number;
  matchReason: string;
  repoCount: number;
  commitCount: number;
};

type AccountStat = {
  accountKey: string;
  accountLabel: string;
  loggedTaskCount: number;
  matchedCount: number;
  missingCount: number;
  commitCount: number;
};

const jiraHttpsAgent = new https.Agent({ rejectUnauthorized: false });

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "task", "issue", "fix", "fixed",
  "add", "update", "updated", "change", "changed", "work", "done", "complete", "completed",
  "va", "voi", "cho", "cac", "cua", "mot", "nhung", "trong", "tren", "duoi", "theo",
  "cong", "viec", "thuc", "hien", "hoan", "thanh", "cap", "nhat", "sua", "loi",
]);

function parseJsonConfig<T>(value: unknown, fallback: T): T {
  if (!value) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function startOfDayIso(date: string) {
  return new Date(`${date}T00:00:00.000+07:00`).toISOString();
}

function endOfDayIso(date: string) {
  return new Date(`${date}T23:59:59.999+07:00`).toISOString();
}

function dateInBangkok(value: string) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(value: string) {
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sameJiraUser(a: any, b: any) {
  const left = [a?.accountId, a?.name, a?.emailAddress, a?.displayName]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase());
  const right = [b?.accountId, b?.name, b?.emailAddress, b?.displayName]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase());
  return left.some((value) => right.includes(value));
}

function jiraUserMatchesIdentity(user: any, identity: GitIdentity) {
  return identityMatches(identity, {
    ids: [user?.accountId, user?.name, user?.key],
    names: [user?.displayName, user?.name, user?.key],
    emails: [user?.emailAddress],
  });
}

function currentJiraAccountTarget(currentUser: any): AccountTarget {
  const key = normalizeIdentityValue(currentUser?.emailAddress || currentUser?.name || currentUser?.accountId || "__current__");
  return {
    key,
    label: currentUser?.displayName || currentUser?.emailAddress || currentUser?.name || "Jira current user",
    identity: {
      ids: compactUnique([currentUser?.accountId, currentUser?.name, currentUser?.key]),
      names: compactUnique([currentUser?.displayName, currentUser?.name, currentUser?.key]),
      emails: compactUnique([currentUser?.emailAddress]),
    },
  };
}

async function getAllWorklogs(api: any, issueKey: string) {
  const all: any[] = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const res = await api.get(`/issue/${issueKey}/worklog`, {
      params: { startAt, maxResults },
    });
    const worklogs = res.data.worklogs || [];
    all.push(...worklogs);

    const total = res.data.total ?? all.length;
    if (worklogs.length === 0 || all.length >= total) break;
    startAt += maxResults;
  }

  return all;
}

async function getLoggedTasksForDate(jiraPat: string, date: string, projectKeys: string[], accountTargets: AccountTarget[]): Promise<LoggedTask[]> {
  const api = getJiraApi(jiraPat);
  api.defaults.httpsAgent = jiraHttpsAgent;

  const meRes = await api.get("/myself");
  const currentUser = meRes.data;
  const effectiveTargets = accountTargets.length > 0 && accountTargets[0].key !== "__current__"
    ? accountTargets
    : [currentJiraAccountTarget(currentUser)];

  const clauses = [`worklogDate = "${date}"`];
  if (projectKeys.length > 0) {
    clauses.unshift(`project in (${projectKeys.map((key) => `"${key}"`).join(", ")})`);
  }

  const issues: any[] = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const res = await api.get("/search", {
      params: {
        jql: `${clauses.join(" AND ")} ORDER BY updated DESC`,
        maxResults,
        startAt,
        fields: "summary,project",
      },
    });

    const pageIssues = res.data.issues || [];
    issues.push(...pageIssues);
    const total = res.data.total ?? issues.length;
    if (pageIssues.length === 0 || issues.length >= total) break;
    startAt += maxResults;
  }

  const tasksByAccountAndIssue = new Map<string, LoggedTask>();

  for (const issue of issues) {
    const worklogs = await getAllWorklogs(api, issue.key);

    for (const worklog of worklogs) {
      if (dateInBangkok(worklog.started) !== date) continue;

      const matchedTarget = effectiveTargets.find((target) => jiraUserMatchesIdentity(worklog.author, target.identity));
      if (!matchedTarget) continue;

      const taskKey = `${matchedTarget.key}|${issue.key}`;
      const existing = tasksByAccountAndIssue.get(taskKey);
      const worklogRow = {
        id: String(worklog.id),
        comment: typeof worklog.comment === "string" ? worklog.comment : "",
        started: worklog.started,
        timeSpentSeconds: worklog.timeSpentSeconds || 0,
      };

      if (existing) {
        existing.worklogs.push(worklogRow);
      } else {
        tasksByAccountAndIssue.set(taskKey, {
          accountKey: matchedTarget.key,
          accountLabel: matchedTarget.label,
          issueKey: issue.key,
          projectKey: issue.fields.project?.key || "",
          summary: issue.fields.summary || "",
          worklogs: [worklogRow],
        });
      }
    }
  }

  return Array.from(tasksByAccountAndIssue.values());
}

function parseRepoUrl(repoUrl: string) {
  const cleanUrl = repoUrl.trim().replace(/\.git$/i, "");
  const url = new URL(cleanUrl);
  const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const host = url.hostname.toLowerCase();

  let provider: "github" | "gitlab" | "bitbucket" = "gitlab";
  if (host.includes("github.com")) provider = "github";
  if (host.includes("bitbucket.org")) provider = "bitbucket";
  if (host.includes("gitlab")) provider = "gitlab";

  return { provider, origin: url.origin, path };
}

function authHeaders(provider: string, gitPat: string) {
  if (!gitPat) return {};
  if (provider === "gitlab") return { "PRIVATE-TOKEN": gitPat };
  return { Authorization: `Bearer ${gitPat}` };
}

function normalizeIdentityValue(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function compactUnique(values: unknown[]) {
  return Array.from(new Set(values.map(normalizeIdentityValue).filter(Boolean)));
}

function configuredAccountsToIdentity(accounts: string[] = []): GitIdentity {
  const values = compactUnique(accounts.flatMap((account) => String(account).split(/[\n,;]+/)));
  const emails = values.filter((value) => value.includes("@"));
  const nonEmails = values.filter((value) => !value.includes("@"));
  return {
    ids: nonEmails,
    names: nonEmails,
    emails,
  };
}

function accountTargetFromValue(value: string): AccountTarget {
  const normalized = normalizeIdentityValue(value);
  return {
    key: normalized,
    label: value.trim(),
    identity: configuredAccountsToIdentity([value]),
  };
}

function buildAccountTargets(accounts: string[] = []): AccountTarget[] {
  const values = compactUnique(accounts.flatMap((account) => String(account).split(/[\n,;]+/)));
  if (values.length === 0) {
    return [{
      key: "__current__",
      label: "Git PAT hiện tại",
      identity: { ids: [], names: [], emails: [] },
    }];
  }

  return values.map(accountTargetFromValue);
}

function identityMatches(identity: GitIdentity, candidate: {
  ids?: unknown[];
  names?: unknown[];
  emails?: unknown[];
  raw?: unknown[];
}) {
  const candidateIds = compactUnique(candidate.ids || []);
  const candidateNames = compactUnique(candidate.names || []);
  const candidateEmails = compactUnique(candidate.emails || []);
  const candidateRaw = compactUnique(candidate.raw || []);

  const idMatched = identity.ids.some((id) => candidateIds.includes(id));
  const emailMatched = identity.emails.some((email) => candidateEmails.includes(email) || candidateRaw.some((raw) => raw.includes(email)));
  const nameMatched = identity.names.some((name) => candidateNames.includes(name));

  return idMatched || emailMatched || nameMatched;
}

function dedupeCommits(commits: GitCommit[]) {
  const bySha = new Map<string, GitCommit>();
  for (const commit of commits) {
    const existing = bySha.get(commit.sha);
    if (!existing) {
      bySha.set(commit.sha, { ...commit, branches: Array.from(new Set(commit.branches)) });
      continue;
    }

    existing.branches = Array.from(new Set([...existing.branches, ...commit.branches]));
  }
  return Array.from(bySha.values());
}

function requireGitPat(gitPat: string) {
  if (!gitPat.trim()) {
    throw new Error("Cần cấu hình Git PAT để lọc commit của user hiện tại.");
  }
}

function hasConfiguredAccounts(identity: GitIdentity) {
  return identity.ids.length > 0 || identity.names.length > 0 || identity.emails.length > 0;
}

async function getGitLabIdentity(origin: string, gitPat: string): Promise<GitIdentity> {
  const res = await axios.get(`${origin}/api/v4/user`, {
    headers: authHeaders("gitlab", gitPat),
  });
  const user = res.data || {};
  return {
    ids: compactUnique([user.id, user.username]),
    names: compactUnique([user.name, user.username]),
    emails: compactUnique([user.email, user.public_email, user.commit_email]),
  };
}

async function getGitHubIdentity(gitPat: string): Promise<GitIdentity> {
  const headers = {
    ...authHeaders("github", gitPat),
    Accept: "application/vnd.github+json",
    "User-Agent": "jira-git-reconciliation",
  };
  const userRes = await axios.get("https://api.github.com/user", { headers });
  let emails: string[] = compactUnique([userRes.data?.email]);

  try {
    const emailRes = await axios.get("https://api.github.com/user/emails", { headers });
    emails = compactUnique([
      ...emails,
      ...(emailRes.data || []).map((item: any) => item.email),
    ]);
  } catch {
    // Fine-grained tokens may not have email scope. Login/id matching still works for linked commits.
  }

  return {
    ids: compactUnique([userRes.data?.id, userRes.data?.login]),
    names: compactUnique([userRes.data?.name, userRes.data?.login]),
    emails,
  };
}

async function getBitbucketIdentity(gitPat: string): Promise<GitIdentity> {
  const headers = authHeaders("bitbucket", gitPat);
  const userRes = await axios.get("https://api.bitbucket.org/2.0/user", { headers });
  let emails: string[] = [];

  try {
    const emailRes = await axios.get("https://api.bitbucket.org/2.0/user/emails", { headers });
    emails = compactUnique((emailRes.data?.values || []).map((item: any) => item.email));
  } catch {
    // Email may be unavailable depending on token scopes.
  }

  return {
    ids: compactUnique([userRes.data?.account_id, userRes.data?.uuid, userRes.data?.nickname, userRes.data?.username]),
    names: compactUnique([userRes.data?.display_name, userRes.data?.nickname, userRes.data?.username]),
    emails,
  };
}

async function fetchGitLabBranches(repoUrl: string, gitPat: string) {
  const repo = parseRepoUrl(repoUrl);
  const branches: string[] = [];

  for (let page = 1; page <= 10; page++) {
    const res = await axios.get(`${repo.origin}/api/v4/projects/${encodeURIComponent(repo.path)}/repository/branches`, {
      headers: authHeaders("gitlab", gitPat),
      params: { per_page: 100, page },
    });
    const rows = res.data || [];
    branches.push(...rows.map((branch: any) => branch.name).filter(Boolean));
    if (rows.length < 100) break;
  }

  return branches;
}

async function fetchGitHubBranches(repoUrl: string, gitPat: string) {
  const repo = parseRepoUrl(repoUrl);
  const branches: string[] = [];

  for (let page = 1; page <= 10; page++) {
    const res = await axios.get(`https://api.github.com/repos/${repo.path}/branches`, {
      headers: {
        ...authHeaders("github", gitPat),
        Accept: "application/vnd.github+json",
        "User-Agent": "jira-git-reconciliation",
      },
      params: { per_page: 100, page },
    });
    const rows = res.data || [];
    branches.push(...rows.map((branch: any) => branch.name).filter(Boolean));
    if (rows.length < 100) break;
  }

  return branches;
}

async function fetchBitbucketBranches(repoUrl: string, gitPat: string) {
  const repo = parseRepoUrl(repoUrl);
  const branches: string[] = [];
  let nextUrl: string | null = `https://api.bitbucket.org/2.0/repositories/${repo.path}/refs/branches`;

  for (let page = 1; nextUrl && page <= 10; page++) {
    const currentUrl = nextUrl;
    const res: any = await axios.get(currentUrl, {
      headers: authHeaders("bitbucket", gitPat),
      params: page === 1 ? { pagelen: 100 } : undefined,
    });
    const rows = res.data.values || [];
    branches.push(...rows.map((branch: any) => branch.name).filter(Boolean));
    nextUrl = res.data.next || null;
  }

  return branches;
}

async function fetchGitLabCommits(repoUrl: string, gitPat: string, since: string, until: string, configuredIdentity: GitIdentity): Promise<GitCommit[]> {
  requireGitPat(gitPat);
  const repo = parseRepoUrl(repoUrl);
  const identity = hasConfiguredAccounts(configuredIdentity)
    ? configuredIdentity
    : await getGitLabIdentity(repo.origin, gitPat);
  const branches = await fetchGitLabBranches(repoUrl, gitPat);
  const commits: GitCommit[] = [];

  for (const branch of branches) {
    for (let page = 1; page <= 5; page++) {
      const res = await axios.get(`${repo.origin}/api/v4/projects/${encodeURIComponent(repo.path)}/repository/commits`, {
        headers: authHeaders("gitlab", gitPat),
        params: { ref_name: branch, since, until, per_page: 100, page },
      });
      const rows = res.data || [];
      commits.push(...rows
        .filter((commit: any) => identityMatches(identity, {
          names: [commit.author_name, commit.committer_name],
          emails: [commit.author_email, commit.committer_email],
        }))
        .map((commit: any) => ({
          repoUrl,
          provider: "gitlab",
          sha: commit.id,
          shortSha: commit.short_id || String(commit.id).slice(0, 8),
          message: commit.message || commit.title || "",
          authorName: commit.author_name || commit.committer_name || "",
          committedAt: commit.committed_date || commit.created_at || "",
          url: commit.web_url || repoUrl,
          branches: [branch],
        })));
      if (rows.length < 100) break;
    }
  }

  return dedupeCommits(commits);
}

async function fetchGitHubCommits(repoUrl: string, gitPat: string, since: string, until: string, configuredIdentity: GitIdentity): Promise<GitCommit[]> {
  requireGitPat(gitPat);
  const repo = parseRepoUrl(repoUrl);
  const identity = hasConfiguredAccounts(configuredIdentity)
    ? configuredIdentity
    : await getGitHubIdentity(gitPat);
  const branches = await fetchGitHubBranches(repoUrl, gitPat);
  const commits: GitCommit[] = [];

  for (const branch of branches) {
    for (let page = 1; page <= 5; page++) {
      const res = await axios.get(`https://api.github.com/repos/${repo.path}/commits`, {
        headers: {
          ...authHeaders("github", gitPat),
          Accept: "application/vnd.github+json",
          "User-Agent": "jira-git-reconciliation",
        },
        params: { sha: branch, since, until, per_page: 100, page },
      });
      const rows = res.data || [];
      commits.push(...rows
        .filter((commit: any) => identityMatches(identity, {
          ids: [commit.author?.id, commit.author?.login, commit.committer?.id, commit.committer?.login],
          names: [commit.commit?.author?.name, commit.commit?.committer?.name, commit.author?.login, commit.committer?.login],
          emails: [commit.commit?.author?.email, commit.commit?.committer?.email],
        }))
        .map((commit: any) => ({
          repoUrl,
          provider: "github",
          sha: commit.sha,
          shortSha: String(commit.sha).slice(0, 8),
          message: commit.commit?.message || "",
          authorName: commit.commit?.author?.name || commit.author?.login || "",
          committedAt: commit.commit?.author?.date || commit.commit?.committer?.date || "",
          url: commit.html_url || repoUrl,
          branches: [branch],
        })));
      if (rows.length < 100) break;
    }
  }

  return dedupeCommits(commits);
}

async function fetchBitbucketCommits(repoUrl: string, gitPat: string, since: string, until: string, configuredIdentity: GitIdentity): Promise<GitCommit[]> {
  requireGitPat(gitPat);
  const repo = parseRepoUrl(repoUrl);
  const identity = hasConfiguredAccounts(configuredIdentity)
    ? configuredIdentity
    : await getBitbucketIdentity(gitPat);
  const branches = await fetchBitbucketBranches(repoUrl, gitPat);
  const commits: GitCommit[] = [];

  for (const branch of branches) {
    let nextUrl: string | null = `https://api.bitbucket.org/2.0/repositories/${repo.path}/commits/${encodeURIComponent(branch)}`;

    for (let page = 1; nextUrl && page <= 5; page++) {
      const currentUrl = nextUrl;
      const res: any = await axios.get(currentUrl, {
        headers: authHeaders("bitbucket", gitPat),
        params: page === 1 ? { pagelen: 100 } : undefined,
      });
      const rows = res.data.values || [];
      commits.push(...rows
        .filter((commit: any) => {
          const committedAt = new Date(commit.date).getTime();
          return committedAt >= new Date(since).getTime() && committedAt <= new Date(until).getTime();
        })
        .filter((commit: any) => identityMatches(identity, {
          ids: [commit.author?.user?.account_id, commit.author?.user?.uuid, commit.author?.user?.nickname],
          names: [commit.author?.user?.display_name, commit.author?.user?.nickname],
          raw: [commit.author?.raw],
        }))
        .map((commit: any) => ({
          repoUrl,
          provider: "bitbucket",
          sha: commit.hash,
          shortSha: String(commit.hash).slice(0, 8),
          message: commit.message || "",
          authorName: commit.author?.user?.display_name || commit.author?.raw || "",
          committedAt: commit.date || "",
          url: commit.links?.html?.href || repoUrl,
          branches: [branch],
        })));
      nextUrl = res.data.next || null;
    }
  }

  return dedupeCommits(commits);
}

async function fetchRepoCommits(repoUrl: string, gitPat: string, since: string, until: string, configuredIdentity: GitIdentity) {
  const { provider } = parseRepoUrl(repoUrl);
  if (provider === "github") return fetchGitHubCommits(repoUrl, gitPat, since, until, configuredIdentity);
  if (provider === "bitbucket") return fetchBitbucketCommits(repoUrl, gitPat, since, until, configuredIdentity);
  return fetchGitLabCommits(repoUrl, gitPat, since, until, configuredIdentity);
}

function extractJsonObject(value: string) {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced?.[1] || value;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function aiMatchCommit(task: LoggedTask, commits: GitCommit[], geminiKey?: string) {
  if (!geminiKey || commits.length === 0) return null;

  const candidates = commits.slice(0, 40).map((commit, index) => ({
    index,
    sha: commit.shortSha,
    message: commit.message.split(/\r?\n/).slice(0, 4).join("\n"),
    author: commit.authorName,
    branches: commit.branches,
  }));

  const taskText = [
    `Jira key: ${task.issueKey}`,
    `Vietnamese title: ${task.summary}`,
    `Vietnamese worklog notes: ${task.worklogs.map((worklog) => worklog.comment).filter(Boolean).join(" | ") || "N/A"}`,
  ].join("\n");

  const prompt = `You are auditing whether Git commits are semantically related to a Jira task.
The Jira task title/worklog may be Vietnamese, while commit messages may be English.
Choose exactly one commit only if the commit meaning clearly supports the Jira task work.
Do not match generic commits. Prefer a conservative decision.

${taskText}

Candidate commits:
${JSON.stringify(candidates, null, 2)}

Return only JSON with this shape:
{"matchedIndex": number|null, "score": number, "reason": "short Vietnamese explanation"}
Use score 0..1. matchedIndex must be null if no commit is relevant.`;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 300 },
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    const parsed = extractJsonObject(text);
    const matchedIndex = parsed?.matchedIndex;
    const score = Number(parsed?.score || 0);

    if (matchedIndex === null || matchedIndex === undefined || Number.isNaN(score) || score < 0.65) {
      return null;
    }

    const candidate = candidates.find((item) => item.index === Number(matchedIndex));
    const commit = candidate ? commits[candidate.index] : null;
    if (!commit) return null;

    return {
      commit,
      score: Math.min(1, Math.max(0, score)),
      reason: parsed?.reason ? `AI semantic match: ${String(parsed.reason)}` : "AI semantic match nội dung task/commit",
    };
  } catch (err) {
    console.warn("AI commit matching skipped:", err);
    return null;
  }
}

async function matchCommit(task: LoggedTask, commits: GitCommit[], geminiKey?: string) {
  const issuePattern = new RegExp(`(^|[^A-Z0-9])${escapeRegExp(task.issueKey)}([^A-Z0-9]|$)`, "i");
  const direct = commits.find((commit) => issuePattern.test(commit.message));
  if (direct) {
    return { commit: direct, score: 1, reason: "Issue key trong commit message" };
  }

  const aiMatch = await aiMatchCommit(task, commits, geminiKey);
  if (aiMatch) return aiMatch;

  const taskText = [
    task.summary,
    ...task.worklogs.map((worklog) => worklog.comment),
  ].join(" ");
  const taskTokens = new Set(tokenize(taskText));
  if (taskTokens.size === 0) return null;

  let best: { commit: GitCommit; score: number; reason: string } | null = null;
  for (const commit of commits) {
    const commitTokens = new Set(tokenize(commit.message));
    if (commitTokens.size === 0) continue;

    const overlap = [...taskTokens].filter((token) => commitTokens.has(token)).length;
    const score = overlap / Math.min(taskTokens.size, commitTokens.size);
    if (overlap >= 2 && score >= 0.35 && (!best || score > best.score)) {
      best = { commit, score, reason: "Khớp nội dung task/worklog" };
    }
  }

  return best;
}

function truncateTelegramText(text: string) {
  return text.length > 3900 ? `${text.slice(0, 3890)}\n...` : text;
}

function formatTelegramReport(options: {
  date: string;
  gitAccounts: string[];
  rows: GitReconciliationResultRow[];
  repoErrors: { projectKey: string; repoUrl: string; error: string }[];
  stats: { loggedTaskCount: number; matchedCount: number; missingCount: number; repoCount: number; commitCount: number };
}) {
  const missingRows = options.rows.filter((row) => row.status === "missing");
  const matchedRows = options.rows.filter((row) => row.status === "matched");
  const accountText = options.gitAccounts.length > 0 ? options.gitAccounts.join(", ") : "Theo Git PAT hiện tại";

  const lines = [
    `Git/Jira reconciliation report - ${options.date}`,
    `Accounts: ${accountText}`,
    `Tasks: ${options.stats.loggedTaskCount} | Matched: ${options.stats.matchedCount} | Missing: ${options.stats.missingCount}`,
    `Repos: ${options.stats.repoCount} | Commits scanned: ${options.stats.commitCount}`,
    "",
  ];

  if (missingRows.length > 0) {
    lines.push("Missing commits:");
    for (const row of missingRows.slice(0, 20)) {
      lines.push(`- ${row.issueKey} [${row.projectKey}] ${row.summary}`);
      lines.push(`  Reason: ${row.matchReason}`);
    }
    lines.push("");
  }

  if (matchedRows.length > 0) {
    lines.push("Matched tasks:");
    for (const row of matchedRows.slice(0, 20)) {
      lines.push(`- ${row.issueKey}: ${row.matchedCommit?.shortSha || "-"} (${row.matchReason}, score ${row.matchScore})`);
      if (row.matchedCommit) {
        lines.push(`  ${row.matchedCommit.message.split(/\r?\n/)[0] || ""}`);
      }
    }
    lines.push("");
  }

  if (options.repoErrors.length > 0) {
    lines.push("Repo errors:");
    for (const error of options.repoErrors.slice(0, 10)) {
      lines.push(`- ${error.projectKey}: ${error.repoUrl} - ${error.error}`);
    }
  }

  return truncateTelegramText(lines.join("\n"));
}

function escapeTelegramHtml(value: string) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatTelegramReportV2(options: {
  date: string;
  rows: GitReconciliationResultRow[];
  repoErrors: { projectKey: string; repoUrl: string; error: string }[];
  stats: {
    loggedTaskCount: number;
    matchedCount: number;
    missingCount: number;
    repoCount: number;
    commitCount: number;
    accounts: AccountStat[];
  };
}) {
  const lines = [
    `📌 <b>Git/Jira Reconciliation</b>`,
    `📅 <b>Date:</b> ${escapeTelegramHtml(options.date)}`,
    `📊 <b>Total:</b> ${options.stats.loggedTaskCount} tasks | ✅ ${options.stats.matchedCount} matched | ❌ ${options.stats.missingCount} missing`,
    `🔎 <b>Scope:</b> ${options.stats.repoCount} repos | ${options.stats.commitCount} user commits scanned`,
    "",
  ];

  for (const account of options.stats.accounts) {
    const accountRows = options.rows.filter((row) => row.accountKey === account.accountKey);
    const missingRows = accountRows.filter((row) => row.status === "missing");
    const matchedRows = accountRows.filter((row) => row.status === "matched");

    lines.push(`👤 <b>${escapeTelegramHtml(account.accountLabel)}</b>`);
    lines.push(`   Tasks: ${account.loggedTaskCount} | ✅ ${account.matchedCount} | ❌ ${account.missingCount} | Commits: ${account.commitCount}`);

    if (account.loggedTaskCount === 0) {
      lines.push(`   ⚪ Không có worklog Jira trong ngày.`);
    }

    for (const row of missingRows.slice(0, 8)) {
      lines.push(`   ❌ <b>${escapeTelegramHtml(row.issueKey)}</b> [${escapeTelegramHtml(row.projectKey)}] ${escapeTelegramHtml(row.summary)}`);
      lines.push(`      ${escapeTelegramHtml(row.matchReason)}`);
    }

    for (const row of matchedRows.slice(0, 8)) {
      if (!row.matchedCommit) continue;
      const message = row.matchedCommit.message.split(/\r?\n/)[0] || "";
      lines.push(`   ✅ <b>${escapeTelegramHtml(row.issueKey)}</b> → <a href="${escapeTelegramHtml(row.matchedCommit.url)}">${escapeTelegramHtml(row.matchedCommit.shortSha)}</a> (${row.matchScore})`);
      lines.push(`      ${escapeTelegramHtml(message)}`);
    }

    lines.push("");
  }

  if (options.repoErrors.length > 0) {
    lines.push(`⚠️ <b>Repo errors</b>`);
    for (const error of options.repoErrors.slice(0, 10)) {
      lines.push(`- ${escapeTelegramHtml(error.projectKey)}: ${escapeTelegramHtml(error.repoUrl)} - ${escapeTelegramHtml(error.error)}`);
    }
  }

  return truncateTelegramText(lines.join("\n"));
}

async function sendTelegramReport(botToken: string, chatId: string, text: string): Promise<TelegramReportStatus> {
  if (!botToken.trim() || !chatId.trim()) {
    return { sent: false, error: "Chưa cấu hình Telegram bot token/chat id" };
  }

  try {
    await axios.post(`https://api.telegram.org/bot${botToken.trim()}/sendMessage`, {
      chat_id: chatId.trim(),
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    return { sent: true };
  } catch (err: any) {
    return {
      sent: false,
      error: err?.response?.data?.description || err?.message || "Không gửi được Telegram report",
    };
  }
}

export async function runGitReconciliation(options: {
  date: string;
  projectKeys: string[];
  jiraPat: string;
  gitPat: string;
  projectGitLinks: string | ProjectGitLinks;
  gitAccounts?: string[];
  geminiKey?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
}) {
  const projectGitLinks = parseJsonConfig<ProjectGitLinks>(options.projectGitLinks, {});
  const gitAccounts = compactUnique(options.gitAccounts || []);
  const accountTargets = buildAccountTargets(gitAccounts);
  const since = startOfDayIso(options.date);
  const until = endOfDayIso(options.date);
  const loggedTasks = await getLoggedTasksForDate(options.jiraPat, options.date, options.projectKeys, accountTargets);

  const repoErrors: { projectKey: string; repoUrl: string; error: string }[] = [];
  const commitsByAccountAndProject: Record<string, Record<string, GitCommit[]>> = {};

  for (const account of accountTargets) {
    commitsByAccountAndProject[account.key] = {};

    for (const projectKey of options.projectKeys) {
      const repoUrls = projectGitLinks[projectKey] || [];
      commitsByAccountAndProject[account.key][projectKey] = [];

      for (const repoUrl of repoUrls.filter((url) => url.trim())) {
        try {
          const commits = await fetchRepoCommits(repoUrl, options.gitPat, since, until, account.identity);
          commitsByAccountAndProject[account.key][projectKey].push(...commits);
        } catch (err: any) {
          repoErrors.push({
          projectKey,
          repoUrl,
          error: err?.response?.data?.message || err?.message || "Không tải được commit",
          });
        }
      }
    }
  }

  const results: GitReconciliationResultRow[] = [];
  for (const task of loggedTasks) {
    const configuredRepos = projectGitLinks[task.projectKey] || [];
    const projectCommits = commitsByAccountAndProject[task.accountKey]?.[task.projectKey] || [];
    const match = configuredRepos.length > 0 ? await matchCommit(task, projectCommits, options.geminiKey) : null;

    results.push({
      ...task,
      status: match ? "matched" : "missing",
      matchedCommit: match?.commit || null,
      matchScore: match ? Number(match.score.toFixed(2)) : 0,
      matchReason: match?.reason || (configuredRepos.length === 0 ? "Chưa cấu hình repo Git cho project" : "Không có commit khớp task trong ngày"),
      repoCount: configuredRepos.length,
      commitCount: projectCommits.length,
    });
  }

  const matchedCount = results.filter((row) => row.status === "matched").length;
  const accountStats: AccountStat[] = accountTargets.map((account) => {
    const accountRows = results.filter((row) => row.accountKey === account.key);
    const accountCommitCount = Object.values(commitsByAccountAndProject[account.key] || {})
      .reduce((sum, commits) => sum + commits.length, 0);

    return {
      accountKey: account.key,
      accountLabel: account.label,
      loggedTaskCount: accountRows.length,
      matchedCount: accountRows.filter((row) => row.status === "matched").length,
      missingCount: accountRows.filter((row) => row.status === "missing").length,
      commitCount: accountCommitCount,
    };
  });
  const stats = {
    loggedTaskCount: results.length,
    matchedCount,
    missingCount: results.length - matchedCount,
    repoCount: Object.values(projectGitLinks).reduce((sum, repos) => sum + repos.length, 0),
    commitCount: Object.values(commitsByAccountAndProject).reduce(
      (sum, projectMap) => sum + Object.values(projectMap).reduce((innerSum, commits) => innerSum + commits.length, 0),
      0
    ),
    accounts: accountStats,
  };
  const telegramReport = await sendTelegramReport(
    options.telegramBotToken || "",
    options.telegramChatId || "",
    formatTelegramReportV2({
      date: options.date,
      rows: results,
      repoErrors,
      stats,
    })
  );

  return {
    date: options.date,
    results,
    repoErrors,
    telegramReport,
    stats,
  };
}
