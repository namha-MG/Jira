import { getMyIssues, getTransitions, transitionIssue, addWorklog, getJiraFields } from "./jiraService";
import { JIRA_PROJECTS } from "./config";

export async function silentAutoProcessTasks(onProgress?: (msg: string) => void) {
  const isConfigured = !!localStorage.getItem("jira_pat") || !!localStorage.getItem("jira_basic");
  if (!isConfigured) return;

  try {
    const projectKeys = JIRA_PROJECTS.map((p) => p.key);
    const result = await getMyIssues({ projectKeys, maxResults: 100 });
    const issues = result.issues;

    const now = new Date();
    now.setHours(0, 0, 0, 0);

    let inProgressCount = 0;
    let closedCount = 0;

    for (const issue of issues) {
      const statusName = issue.fields.status?.name?.toLowerCase() || "";
      const isDone =
        statusName.includes("close") ||
        statusName.includes("resolve") ||
        statusName.includes("cancel") ||
        statusName.includes("done") ||
        statusName.includes("hủy") ||
        statusName.includes("đóng") ||
        statusName.includes("hoàn thành") ||
        statusName.includes("đã giải quyết");

      if (isDone) continue;

      const startDateStr = issue.fields.customfield_10300;
      const dueDateStr = issue.fields.duedate || issue.fields.customfield_10302;
      
      const startDate = startDateStr ? new Date(startDateStr) : null;
      if (startDate) startDate.setHours(0, 0, 0, 0);

      const dueDate = dueDateStr ? new Date(dueDateStr) : null;
      if (dueDate) dueDate.setHours(0, 0, 0, 0);

      const isToDo = statusName === "open" || statusName === "to do" || statusName === "mở" || statusName === "cần làm";

      // Rule 2: Due Date <= Today -> Log Work & Close
      if (dueDate && dueDate <= now) {
        // Calculate remaining to log
        const est = issue.fields.timetracking?.originalEstimateSeconds || 0;
        const logged = issue.fields.timetracking?.timeSpentSeconds || 0;
        
        let toLog = 0;
        if (est > 0 && logged < est) {
          toLog = est - logged;
        } else if (est === 0 && logged === 0) {
          toLog = 8 * 3600; // default 8 hours if no estimate and hasn't logged
        }

        if (toLog > 0) {
          try {
            await addWorklog(issue.key, {
              timeSpentSeconds: toLog,
              comment: "Tự động log work khi đến Due Date",
            });
          } catch (e) {
            console.warn(`Failed to auto-log for ${issue.key}`, e);
          }
        }

        // Transition to closed
        try {
          const transitions = await getTransitions(issue.key);
          const closedKeywords = ["closed", "đóng", "resolved", "done", "đã giải quyết", "hoàn thành"];
          const toClosed = transitions.find(t => 
            closedKeywords.includes(t.to.name.toLowerCase()) || 
            closedKeywords.some(kw => t.name.toLowerCase().includes(kw))
          );
          if (toClosed) {
            const allFields = await getJiraFields();
            const outputField = allFields.find(f => f.name.toLowerCase() === "output" || f.name.toLowerCase() === "out put");
            const transitionFields: any = { resolution: { id: "10000" } };
            if (outputField) transitionFields[outputField.id] = "Tự động hoàn thành";

            await transitionIssue(issue.key, toClosed.id, transitionFields);
            closedCount++;
          }
        } catch (e) {
          console.warn(`Failed to auto-close ${issue.key}`, e);
        }
      } 
      // Rule 1: Start Date <= Today and is To Do -> Move to In Progress
      else if (startDate && startDate <= now && isToDo) {
        try {
          const transitions = await getTransitions(issue.key);
          const inprogressKeywords = ["in progress", "đang thực hiện", "đang làm"];
          const toInProgress = transitions.find(t => 
            inprogressKeywords.includes(t.to.name.toLowerCase()) || 
            inprogressKeywords.some(kw => t.name.toLowerCase().includes(kw))
          );
          if (toInProgress) {
            await transitionIssue(issue.key, toInProgress.id);
            inProgressCount++;
          }
        } catch (e) {
          console.warn(`Failed to move ${issue.key} to In Progress`, e);
        }
      }
    }

    if (inProgressCount > 0 || closedCount > 0) {
      if (onProgress) {
        onProgress(`⚡ Auto-Process: Đã tự chuyển ${inProgressCount} task sang In Progress, tự log & đóng ${closedCount} task.`);
      }
    }
  } catch (err) {
    console.error("Auto process failed", err);
  }
}
