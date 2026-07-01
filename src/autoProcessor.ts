import {
  addWorklog,
  generateAiOutput,
  getAllIssuesByJql,
  getJiraFields,
  getTransitions,
  JiraIssue,
  parseTimeToSeconds,
  transitionIssue,
} from "./jiraService";
import { getAutoResolveIssueKeys, removeAutoResolveIssueKey } from "./stores/autoResolveStore";

function escapeJqlKey(key: string): string {
  return key.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function isResolvedOrClosed(issue: JiraIssue): boolean {
  const statusName = issue.fields.status?.name?.toLowerCase() || "";
  return (
    statusName.includes("resolve") ||
    statusName.includes("closed") ||
    statusName.includes("done") ||
    statusName.includes("đóng") ||
    statusName.includes("hoàn thành") ||
    statusName.includes("đã giải quyết")
  );
}

function parseEstimateSeconds(issue: JiraIssue): number {
  const seconds = issue.fields.timetracking?.originalEstimateSeconds || 0;
  if (seconds > 0) return seconds;
  const textEstimate = issue.fields.timetracking?.originalEstimate;
  return textEstimate ? parseTimeToSeconds(textEstimate) : 0;
}

function getLoggedSeconds(issue: JiraIssue): number {
  return issue.fields.timetracking?.timeSpentSeconds || issue.fields.aggregatetimespent || 0;
}

function toStartOfLocalDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function formatJiraDateTime(date: Date, hour = 17, minute = 0): string {
  const d = new Date(date);
  d.setHours(hour, minute, 0, 0);

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const offsetHours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const offsetMins = String(Math.abs(offset) % 60).padStart(2, "0");

  return `${year}-${month}-${day}T${hh}:${mm}:00.000${sign}${offsetHours}${offsetMins}`;
}

async function buildResolveFields(summary: string) {
  const output = await generateAiOutput(summary);
  const fields: Record<string, unknown> = {
    resolution: { id: "10000" },
    customfield_10304: output,
  };

  try {
    const allFields = await getJiraFields();
    const outputField = allFields.find((field: any) => {
      const name = String(field.name || "").trim().toLowerCase();
      return name === "output" || name === "out put";
    });
    if (outputField?.id) {
      fields[outputField.id] = output;
    }
  } catch (err) {
    console.warn("Failed to load Jira output field metadata", err);
  }

  return fields;
}

function findResolveTransition(transitions: { id: string; name: string; to: { name: string } }[]) {
  const resolveKeywords = ["resolve", "resolved", "giải quyết", "đã giải quyết"];
  return transitions.find((transition) => {
    const name = transition.name.toLowerCase();
    const toName = transition.to.name.toLowerCase();
    return resolveKeywords.some(keyword => name.includes(keyword) || toName.includes(keyword));
  });
}

export async function silentAutoProcessTasks(onProgress?: (msg: string) => void) {
  const isConfigured = !!localStorage.getItem("jira_pat") || !!localStorage.getItem("jira_basic");
  if (!isConfigured) return;

  const scheduledKeys = getAutoResolveIssueKeys();
  if (scheduledKeys.length === 0) return;

  try {
    const quotedKeys = scheduledKeys.map(key => `"${escapeJqlKey(key)}"`).join(",");
    const issues = await getAllIssuesByJql(`key in (${quotedKeys})`, scheduledKeys.length);
    const now = toStartOfLocalDay(new Date());

    let resolvedCount = 0;
    let loggedCount = 0;

    for (const issue of issues) {
      if (isResolvedOrClosed(issue)) {
        removeAutoResolveIssueKey(issue.key);
        continue;
      }

      const endDateStr = issue.fields.customfield_10302 || issue.fields.duedate;
      if (!endDateStr) continue;

      const endDate = toStartOfLocalDay(new Date(endDateStr));
      if (Number.isNaN(endDate.getTime()) || endDate > now) continue;

      const estimateSeconds = parseEstimateSeconds(issue);
      const loggedSeconds = getLoggedSeconds(issue);
      const secondsToLog = Math.max(0, estimateSeconds - loggedSeconds);

      if (secondsToLog > 0) {
        await addWorklog(issue.key, {
          timeSpentSeconds: secondsToLog,
          comment: "Tự động log work theo estimate khi đến End Date",
          started: formatJiraDateTime(new Date(endDateStr)),
          adjustEstimate: "auto",
        });
        loggedCount++;
      }

      const transitions = await getTransitions(issue.key);
      const resolveTransition = findResolveTransition(transitions);
      if (!resolveTransition) {
        console.warn(`No Resolve transition found for ${issue.key}`);
        continue;
      }

      const resolveFields = await buildResolveFields(issue.fields.summary);
      await transitionIssue(issue.key, resolveTransition.id, resolveFields);
      removeAutoResolveIssueKey(issue.key);
      resolvedCount++;
    }

    if ((resolvedCount > 0 || loggedCount > 0) && onProgress) {
      onProgress(`Auto resolve: đã log ${loggedCount} task theo estimate và chuyển Resolve ${resolvedCount} task.`);
    }
  } catch (err) {
    console.error("Auto resolve process failed", err);
  }
}
