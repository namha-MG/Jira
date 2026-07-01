const AUTO_RESOLVE_KEYS_STORAGE = "bulk_auto_resolve_issue_keys";

function readKeys(): string[] {
  try {
    const raw = localStorage.getItem(AUTO_RESOLVE_KEYS_STORAGE);
    if (!raw) return [];
    const keys = JSON.parse(raw);
    if (!Array.isArray(keys)) return [];
    return keys.filter((key): key is string => typeof key === "string" && key.trim().length > 0);
  } catch {
    return [];
  }
}

function writeKeys(keys: string[]) {
  localStorage.setItem(AUTO_RESOLVE_KEYS_STORAGE, JSON.stringify(Array.from(new Set(keys))));
}

export function getAutoResolveIssueKeys(): string[] {
  return readKeys();
}

export function addAutoResolveIssueKeys(keys: string[]) {
  const next = [...readKeys(), ...keys.map(key => key.trim()).filter(Boolean)];
  writeKeys(next);
}

export function removeAutoResolveIssueKey(key: string) {
  writeKeys(readKeys().filter(item => item !== key));
}
