export type GitProjectLinks = Record<string, string[]>;

export type GitReconciliationCommit = {
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

export type GitReconciliationRow = {
  issueKey: string;
  projectKey: string;
  summary: string;
  worklogs: {
    id: string;
    comment: string;
    started: string;
    timeSpentSeconds: number;
  }[];
  status: "matched" | "missing";
  matchedCommit: GitReconciliationCommit | null;
  matchScore: number;
  matchReason: string;
  repoCount: number;
  commitCount: number;
};

export type GitReconciliationResult = {
  date: string;
  results: GitReconciliationRow[];
  repoErrors: { projectKey: string; repoUrl: string; error: string }[];
  stats: {
    loggedTaskCount: number;
    matchedCount: number;
    missingCount: number;
    repoCount: number;
    commitCount: number;
  };
};

export const GIT_PROJECT_LINKS_STORAGE_KEY = "git_project_links";
export const GIT_PAT_STORAGE_KEY = "git_pat";

export function getGitProjectLinks(): GitProjectLinks {
  try {
    const raw = localStorage.getItem(GIT_PROJECT_LINKS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).map(([projectKey, urls]) => [
        projectKey,
        Array.isArray(urls) ? urls.map((url) => String(url)).filter(Boolean) : [],
      ])
    );
  } catch {
    return {};
  }
}

export function saveGitProjectLinks(projectLinks: GitProjectLinks) {
  localStorage.setItem(GIT_PROJECT_LINKS_STORAGE_KEY, JSON.stringify(projectLinks));
}

export async function runGitReconciliation(options: {
  date: string;
  projectKeys: string[];
}): Promise<GitReconciliationResult> {
  const res = await fetch("/api/git-reconciliation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      date: options.date,
      projectKeys: options.projectKeys,
      jiraPat: localStorage.getItem("jira_pat") || "",
      gitPat: localStorage.getItem(GIT_PAT_STORAGE_KEY) || "",
      projectGitLinks: getGitProjectLinks(),
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || "Không chạy được đối soát Git");
  }
  return data;
}
