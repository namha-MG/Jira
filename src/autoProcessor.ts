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
import {
  getActiveAutoResolveScheduleItems,
  markAutoResolveIssueStatus,
} from "./stores/autoResolveStore";

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

function getIssueScheduleFields(issue: JiraIssue) {
  return {
    summary: issue.fields.summary,
    projectKey: issue.fields.project?.key,
    issueType: issue.fields.issuetype?.name,
    assigneeName: issue.fields.assignee?.displayName,
    startDate: issue.fields.customfield_10300,
    endDate: issue.fields.customfield_10302 || issue.fields.duedate,
  };
}

export async function silentAutoProcessTasks(onProgress?: (msg: string) => void) {
  const isConfigured = !!localStorage.getItem("jira_pat") || !!localStorage.getItem("jira_basic");
  if (!isConfigured) return;

  const scheduledItems = getActiveAutoResolveScheduleItems();
  if (scheduledItems.length === 0) return;

  try {
    const scheduledKeys = scheduledItems.map(item => item.key);
    const quotedKeys = scheduledKeys.map(key => `"${escapeJqlKey(key)}"`).join(",");
    const issues = await getAllIssuesByJql(`key in (${quotedKeys})`, scheduledKeys.length);
    const now = toStartOfLocalDay(new Date());

    let resolvedCount = 0;
    let loggedCount = 0;
    const foundKeys = new Set(issues.map(issue => issue.key));

    for (const item of scheduledItems) {
      if (!foundKeys.has(item.key)) {
        markAutoResolveIssueStatus(item.key, "error", {
          lastMessage: "Không tìm thấy issue trên Jira hoặc tài khoản không có quyền xem.",
        });
      }
    }

    for (const issue of issues) {
      try {
        markAutoResolveIssueStatus(issue.key, "processing", {
          ...getIssueScheduleFields(issue),
          lastMessage: "Đang kiểm tra lịch auto log và Resolve.",
        });

        if (isResolvedOrClosed(issue)) {
          markAutoResolveIssueStatus(issue.key, "completed", {
            ...getIssueScheduleFields(issue),
            completedAt: Date.now(),
            lastMessage: "Issue đã ở trạng thái đóng/resolve trước khi job chạy.",
          });
          continue;
        }

        const endDateStr = issue.fields.customfield_10302 || issue.fields.duedate;
        if (!endDateStr) {
          markAutoResolveIssueStatus(issue.key, "error", {
            ...getIssueScheduleFields(issue),
            lastMessage: "Không có End Date nên chưa thể auto log và Resolve.",
          });
          continue;
        }

        const endDate = toStartOfLocalDay(new Date(endDateStr));
        if (Number.isNaN(endDate.getTime())) {
          markAutoResolveIssueStatus(issue.key, "error", {
            ...getIssueScheduleFields(issue),
            endDate: endDateStr,
            lastMessage: "End Date không hợp lệ.",
          });
          continue;
        }

        if (endDate > now) {
          markAutoResolveIssueStatus(issue.key, "pending", {
            ...getIssueScheduleFields(issue),
            lastMessage: "Đang chờ tới End Date.",
          });
          continue;
        }

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
          markAutoResolveIssueStatus(issue.key, "error", {
            ...getIssueScheduleFields(issue),
            loggedSeconds: secondsToLog,
            lastMessage: "Không tìm thấy transition Resolve cho issue.",
          });
          console.warn(`No Resolve transition found for ${issue.key}`);
          continue;
        }

        const resolveFields = await buildResolveFields(issue.fields.summary);
        await transitionIssue(issue.key, resolveTransition.id, resolveFields);
        markAutoResolveIssueStatus(issue.key, "completed", {
          ...getIssueScheduleFields(issue),
          loggedSeconds: secondsToLog,
          completedAt: Date.now(),
          lastMessage: secondsToLog > 0
            ? "Đã auto log phần còn thiếu theo estimate và chuyển Resolve."
            : "Đã chuyển Resolve, không cần log thêm vì task đã đủ giờ.",
        });
        resolvedCount++;
      } catch (err: any) {
        markAutoResolveIssueStatus(issue.key, "error", {
          ...getIssueScheduleFields(issue),
          lastMessage: err?.response?.data?.errorMessages?.[0] || err?.message || "Auto resolve thất bại.",
        });
        console.error(`Auto resolve failed for ${issue.key}`, err);
      }
    }

    if ((resolvedCount > 0 || loggedCount > 0) && onProgress) {
      onProgress(`Auto resolve: đã log ${loggedCount} task theo estimate và chuyển Resolve ${resolvedCount} task.`);
    }
  } catch (err) {
    console.error("Auto resolve process failed", err);
  }
}
