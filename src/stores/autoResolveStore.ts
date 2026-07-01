const AUTO_RESOLVE_KEYS_STORAGE = "bulk_auto_resolve_issue_keys";

export type AutoResolveScheduleStatus = "pending" | "processing" | "completed" | "skipped" | "error";

export interface AutoResolveScheduleItem {
  key: string;
  summary?: string;
  projectKey?: string;
  issueType?: string;
  assigneeName?: string;
  estimate?: string;
  startDate?: string;
  endDate?: string;
  autoLogWork?: boolean;
  status: AutoResolveScheduleStatus;
  createdAt: number;
  updatedAt: number;
  lastMessage?: string;
  loggedSeconds?: number;
  completedAt?: number;
  source?: "bulk-create" | "legacy";
}

export type AutoResolveScheduleInput =
  | string
  | (Partial<Omit<AutoResolveScheduleItem, "status" | "createdAt" | "updatedAt">> & { key: string; status?: AutoResolveScheduleStatus });

const ACTIVE_STATUSES = new Set<AutoResolveScheduleStatus>(["pending", "processing", "error"]);

function normalizeKey(key: string): string {
  return key.trim().toUpperCase();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readRawItems(): unknown[] {
  try {
    const raw = localStorage.getItem(AUTO_RESOLVE_KEYS_STORAGE);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeStoredEntry(entry: unknown, now: number): AutoResolveScheduleItem | null {
  if (typeof entry === "string") {
    const key = normalizeKey(entry);
    if (!key) return null;
    return {
      key,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      source: "legacy",
    };
  }

  if (!isObject(entry) || typeof entry.key !== "string") return null;
  const key = normalizeKey(entry.key);
  if (!key) return null;

  const status = typeof entry.status === "string" && ["pending", "processing", "completed", "skipped", "error"].includes(entry.status)
    ? entry.status as AutoResolveScheduleStatus
    : "pending";

  return {
    key,
    summary: typeof entry.summary === "string" ? entry.summary : undefined,
    projectKey: typeof entry.projectKey === "string" ? entry.projectKey : undefined,
    issueType: typeof entry.issueType === "string" ? entry.issueType : undefined,
    assigneeName: typeof entry.assigneeName === "string" ? entry.assigneeName : undefined,
    estimate: typeof entry.estimate === "string" ? entry.estimate : undefined,
    startDate: typeof entry.startDate === "string" ? entry.startDate : undefined,
    endDate: typeof entry.endDate === "string" ? entry.endDate : undefined,
    autoLogWork: typeof entry.autoLogWork === "boolean" ? entry.autoLogWork : undefined,
    status,
    createdAt: typeof entry.createdAt === "number" ? entry.createdAt : now,
    updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : now,
    lastMessage: typeof entry.lastMessage === "string" ? entry.lastMessage : undefined,
    loggedSeconds: typeof entry.loggedSeconds === "number" ? entry.loggedSeconds : undefined,
    completedAt: typeof entry.completedAt === "number" ? entry.completedAt : undefined,
    source: entry.source === "bulk-create" || entry.source === "legacy" ? entry.source : "legacy",
  };
}

function normalizeInput(entry: AutoResolveScheduleInput, now: number): AutoResolveScheduleItem | null {
  if (typeof entry === "string") {
    const key = normalizeKey(entry);
    if (!key) return null;
    return {
      key,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      source: "bulk-create",
    };
  }

  const key = normalizeKey(entry.key);
  if (!key) return null;
  return {
    key,
    summary: entry.summary,
    projectKey: entry.projectKey,
    issueType: entry.issueType,
    assigneeName: entry.assigneeName,
    estimate: entry.estimate,
    startDate: entry.startDate,
    endDate: entry.endDate,
    autoLogWork: entry.autoLogWork,
    status: entry.status || "pending",
    createdAt: now,
    updatedAt: now,
    lastMessage: entry.lastMessage,
    loggedSeconds: entry.loggedSeconds,
    completedAt: entry.completedAt,
    source: entry.source || "bulk-create",
  };
}

function dedupeItems(items: AutoResolveScheduleItem[]): AutoResolveScheduleItem[] {
  const map = new Map<string, AutoResolveScheduleItem>();
  for (const item of items) {
    const previous = map.get(item.key);
    map.set(item.key, previous ? { ...previous, ...item, createdAt: previous.createdAt || item.createdAt } : item);
  }
  return Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

function readItems(): AutoResolveScheduleItem[] {
  const now = Date.now();
  return dedupeItems(readRawItems().map(entry => normalizeStoredEntry(entry, now)).filter((item): item is AutoResolveScheduleItem => !!item));
}

function writeItems(items: AutoResolveScheduleItem[]) {
  localStorage.setItem(AUTO_RESOLVE_KEYS_STORAGE, JSON.stringify(dedupeItems(items)));
}

export function getAutoResolveScheduleItems(): AutoResolveScheduleItem[] {
  return readItems();
}

export function getActiveAutoResolveScheduleItems(): AutoResolveScheduleItem[] {
  return readItems().filter(item => ACTIVE_STATUSES.has(item.status));
}

export function getAutoResolveIssueKeys(): string[] {
  return getActiveAutoResolveScheduleItems().map(item => item.key);
}

export function addAutoResolveIssueKeys(entries: AutoResolveScheduleInput[]) {
  const now = Date.now();
  const existing = readItems();
  const map = new Map(existing.map(item => [item.key, item]));

  for (const entry of entries) {
    const normalized = normalizeInput(entry, now);
    if (!normalized) continue;
    const previous = map.get(normalized.key);
    map.set(normalized.key, {
      ...previous,
      ...normalized,
      status: normalized.status || "pending",
      createdAt: previous?.createdAt || normalized.createdAt,
      updatedAt: now,
      lastMessage: normalized.lastMessage || previous?.lastMessage,
    });
  }

  writeItems(Array.from(map.values()));
}

export function markAutoResolveIssueStatus(
  key: string,
  status: AutoResolveScheduleStatus,
  updates: Partial<Omit<AutoResolveScheduleItem, "key" | "status" | "createdAt">> = {}
) {
  const normalizedKey = normalizeKey(key);
  const now = Date.now();
  const items = readItems();
  const exists = items.some(item => item.key === normalizedKey);
  const nextItems = exists
    ? items.map(item => item.key === normalizedKey ? { ...item, ...updates, status, updatedAt: now } : item)
    : [{
        key: normalizedKey,
        status,
        createdAt: now,
        updatedAt: now,
        source: "legacy" as const,
        ...updates,
      }];
  writeItems(nextItems);
}

export function removeAutoResolveIssueKey(key: string) {
  const normalizedKey = normalizeKey(key);
  writeItems(readItems().filter(item => item.key !== normalizedKey));
}

export function clearFinishedAutoResolveSchedules() {
  writeItems(readItems().filter(item => ACTIVE_STATUSES.has(item.status)));
}
