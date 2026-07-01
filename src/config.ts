// ===============================================
// AZURE MSAL CONFIG
// Điền Client ID và Tenant ID sau khi đăng ký app
// ===============================================
export const msalConfig = {
  auth: {
    clientId: "e63223b5-72fd-44a2-8603-8986f8e69a23",
    authority: "https://login.microsoftonline.com/c5bcb2d8-6b4a-4cd4-a517-7cd85a7a8a55",
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: "localStorage",
    storeAuthStateInCookie: false,
  },
};

export const loginRequest = {
  scopes: ["User.Read"],
};

// ===============================================
// JIRA CONFIG
// ===============================================
export const JIRA_BASE_URL = "https://20.84.97.109:3033";

export type JiraProjectConfig = {
  key: string;
  name: string;
};

export const JIRA_PROJECTS = [
  { key: "AC", name: "AC" },
  { key: "ACVTT", name: "ACVTT" },
  { key: "BCAAP", name: "BCAAP" },
  { key: "BCAAG", name: "BCAAG" },
  { key: "BCAAT", name: "BCAAT" },
  { key: "BCAC08", name: "BCAC08" },
  { key: "BCAC", name: "BCAC" },
  { key: "BTCQLVB", name: "BTCQLVB" },
  { key: "BTCTCHQHQS", name: "BTCTCHQHQS" },
  { key: "BTCTCTCOR", name: "BTCTCTCOR" },
  { key: "BTCVAM", name: "BTCVAM" },
  { key: "BXDBE", name: "BXD.BE.03" },
  { key: "BXDCSDL", name: "BXD.CSDL" },
  { key: "BXDGPLX", name: "BXDGPLX" },
  { key: "BXDHHHTGT", name: "BXD.HH.HTGT" },
  { key: "BXDIT", name: "BXDIT" },
  { key: "BXDITSNBLC", name: "BXDITSNBLC" },
  { key: "BXDITQG", name: "BXDITQG" },
  { key: "BXDITT", name: "BXDITT" },
  { key: "CABDS", name: "CABDS" },
  { key: "CAH", name: "CAH" },
  { key: "CHKCSDL", name: "CHKCSDL" },
  { key: "CHKSLOT", name: "CHKSLOT" },
] satisfies JiraProjectConfig[];

export const DEFAULT_SELECTED_PROJECT_KEYS = ["BXDCSDL", "BXDHHHTGT", "BXDBE"];
export const SELECTED_PROJECTS_STORAGE_KEY = "selected_jira_projects";

export function getSelectedProjectKeys(): string[] {
  const knownKeys = new Set(JIRA_PROJECTS.map((project) => project.key));
  try {
    const raw = localStorage.getItem(SELECTED_PROJECTS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const selected = parsed
          .map((key) => String(key).trim())
          .filter((key) => knownKeys.has(key));
        if (selected.length > 0) return Array.from(new Set(selected));
      }
    }
  } catch {
    // Fall back to the historical default projects.
  }
  return DEFAULT_SELECTED_PROJECT_KEYS.filter((key) => knownKeys.has(key));
}

export function saveSelectedProjectKeys(keys: string[]) {
  const knownKeys = new Set(JIRA_PROJECTS.map((project) => project.key));
  const selected = Array.from(new Set(keys.filter((key) => knownKeys.has(key))));
  localStorage.setItem(SELECTED_PROJECTS_STORAGE_KEY, JSON.stringify(selected));
}

export function getSelectedJiraProjects(): JiraProjectConfig[] {
  const projectByKey = new Map(JIRA_PROJECTS.map((project) => [project.key, project]));
  const selectedProjects = getSelectedProjectKeys()
    .map((key) => projectByKey.get(key))
    .filter((project): project is JiraProjectConfig => !!project);
  return selectedProjects.length > 0 ? selectedProjects : JIRA_PROJECTS;
}

export function getDefaultProjectKey(): string {
  const selectedProjects = getSelectedJiraProjects();
  const savedDefault = localStorage.getItem("default_project");
  if (savedDefault && selectedProjects.some((project) => project.key === savedDefault)) {
    return savedDefault;
  }
  return selectedProjects[0]?.key || JIRA_PROJECTS[0].key;
}
