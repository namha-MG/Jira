import cron from "node-cron";
import { Client } from "pg";
import dotenv from "dotenv";
import { getJiraApi, getMyIssues, getTransitions, transitionIssue, addWorklog } from "./jiraService";

dotenv.config();

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
const POSTGRES_URL = `postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;

async function processUser(pat: string) {
  try {
    const api = getJiraApi(pat);
    // Hardcode the project keys for now, or read from somewhere
    const projectKeys = ["BXDCSDL", "VH"]; 
    const result = await getMyIssues(api, projectKeys);
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
        const est = issue.fields.timetracking?.originalEstimateSeconds || 0;
        const logged = issue.fields.timetracking?.timeSpentSeconds || 0;
        
        let toLog = 0;
        if (est > 0 && logged < est) {
          toLog = est - logged;
        } else if (est === 0 && logged === 0) {
          toLog = 8 * 3600;
        }

        if (toLog > 0) {
          try {
            await addWorklog(api, issue.key, toLog, "Tự động log work khi đến Due Date");
            console.log(`[Auto] Logged ${toLog}s for ${issue.key}`);
          } catch (e: any) {
            console.warn(`[Auto] Failed to auto-log for ${issue.key}`, e?.response?.data || e.message);
          }
        }

        try {
          const transitions = await getTransitions(api, issue.key);
          const closedKeywords = ["closed", "đóng", "resolved", "done", "đã giải quyết", "hoàn thành"];
          const toClosed = transitions.find((t: any) => 
            closedKeywords.includes(t.to.name.toLowerCase()) || 
            closedKeywords.some(kw => t.name.toLowerCase().includes(kw))
          );
          if (toClosed) {
            await transitionIssue(api, issue.key, toClosed.id);
            console.log(`[Auto] Closed ${issue.key}`);
            closedCount++;
          }
        } catch (e: any) {
          console.warn(`[Auto] Failed to auto-close ${issue.key}`, e?.response?.data || e.message);
        }
      } 
      // Rule 1: Start Date <= Today and is To Do -> Move to In Progress
      else if (startDate && startDate <= now && isToDo) {
        try {
          const transitions = await getTransitions(api, issue.key);
          const inprogressKeywords = ["in progress", "đang thực hiện", "đang làm"];
          const toInProgress = transitions.find((t: any) => 
            inprogressKeywords.includes(t.to.name.toLowerCase()) || 
            inprogressKeywords.some(kw => t.name.toLowerCase().includes(kw))
          );
          if (toInProgress) {
            await transitionIssue(api, issue.key, toInProgress.id);
            console.log(`[Auto] Moved ${issue.key} to In Progress`);
            inProgressCount++;
          }
        } catch (e: any) {
          console.warn(`[Auto] Failed to move ${issue.key} to In Progress`, e?.response?.data || e.message);
        }
      }
    }
    console.log(`[AutoProcess completed] InProgress: ${inProgressCount}, Closed: ${closedCount}`);
  } catch (err: any) {
    console.error("Auto process user failed", err?.response?.data || err.message);
  }
}

export function startCronJobs() {
  console.log("Starting cron jobs...");
  // Run at 08:00 and 17:00
  cron.schedule("0 8,17 * * *", async () => {
    console.log("Running scheduled auto-process task...");
    
    const client = new Client({ connectionString: POSTGRES_URL });
    try {
      await client.connect();
      const res = await client.query("SELECT value FROM jira_app_configs WHERE key = 'jira_pat'");
      if (res.rows.length > 0) {
        const pat = res.rows[0].value;
        await processUser(pat);
      } else {
        console.log("No Jira PAT found in database. Skipping execution.");
      }
    } catch (err) {
      console.error("Error fetching PAT from DB:", err);
    } finally {
      await client.end();
    }
  });
}
