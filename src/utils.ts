export const copyToClipboard = (text: string) => {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(err => console.error("Clipboard write failed", err));
  } else {
    // Fallback for insecure contexts (e.g., HTTP without localhost)
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "absolute";
    textArea.style.left = "-999999px";
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand("copy");
    } catch (error) {
      console.error("Fallback copy failed", error);
    }
    document.body.removeChild(textArea);
  }
};

export const DEFAULT_HOLIDAYS = [
  "2024-01-01", "2024-02-08", "2024-02-09", "2024-02-12", "2024-02-13", "2024-02-14",
  "2024-04-18", "2024-04-30", "2024-05-01", "2024-09-02", "2024-09-03",
  "2025-01-01", "2025-01-27", "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31",
  "2025-04-07", "2025-04-30", "2025-05-01", "2025-09-01", "2025-09-02",
  "2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20",
  "2026-04-26", "2026-04-30", "2026-05-01", "2026-09-02", "2026-09-03"
];

export const getHolidays = (): string[] => {
  const stored = localStorage.getItem("vn_holidays");
  if (stored) {
    try { return JSON.parse(stored); } catch { return DEFAULT_HOLIDAYS; }
  }
  return DEFAULT_HOLIDAYS;
};

export const saveHolidays = (holidays: string[]) => {
  localStorage.setItem("vn_holidays", JSON.stringify(holidays.sort()));
};
