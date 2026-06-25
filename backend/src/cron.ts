import cron from "node-cron";
import { Client } from "pg";
import dotenv from "dotenv";
import { getJiraApi, getMyIssues, getTransitions, transitionIssue, addWorklog } from "./jiraService";

dotenv.config();

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
const POSTGRES_URL = `postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;

async function processUser(pat: string, client: Client, runType: string = "CRON", geminiKey?: string) {
  let runId: number | null = null;
  
  try {
    const runRes = await client.query(
      `INSERT INTO job_runs (run_type, status) VALUES ($1, 'RUNNING') RETURNING id`,
      [runType]
    );
    runId = runRes.rows[0].id;

    const api = getJiraApi(pat);
    // Lấy tất cả task của user hiện tại thay vì hardcode project
    const result = await getMyIssues(api, []);
    const issues = result.issues;

    const now = new Date();
    now.setHours(0, 0, 0, 0);

    let inProgressCount = 0;
    let closedCount = 0;
    const processedTasks = new Set<string>();

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

      if (!issue.fields.assignee) {
        console.log(`[Auto] Bỏ qua task ${issue.key} vì chưa được assign`);
        continue;
      }

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

        let logComment = "Hoàn thành công việc theo yêu cầu";
        if (geminiKey) {
          try {
            const prompt = `Bạn là một kỹ sư phần mềm. Hãy viết một câu ngắn gọn, tự nhiên, bằng tiếng Việt (dưới 15 từ) để làm nội dung log work cho công việc có tiêu đề: "${issue.fields.summary}". Ví dụ: "Đã hoàn thành tối ưu hóa", "Xử lý xong lỗi hiển thị". Chỉ trả về nội dung câu log, không có dấu ngoặc kép hay giải thích thừa.`;
            const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
            });
            if (aiRes.ok) {
              const data = await aiRes.json();
              const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
              if (text) logComment = text;
            }
          } catch (e) {
            console.warn("AI generation failed for auto log work, fallback to default", e);
          }
        }

        if (toLog > 0) {

          try {
            await addWorklog(api, issue.key, toLog, logComment);
            console.log(`[Auto] Logged ${toLog}s for ${issue.key} with comment: ${logComment}`);
            processedTasks.add(issue.key);
            await client.query(
              `INSERT INTO job_task_logs (job_run_id, issue_key, action_type, status, message) VALUES ($1, $2, $3, $4, $5)`,
              [runId, issue.key, 'LOG_WORK', 'SUCCESS', `Logged ${toLog}s: ${logComment}`]
            );
          } catch (e: any) {
            const errLog = e?.response?.data || e.message;
            console.warn(`[Auto] Failed to auto-log for ${issue.key}`, errLog);
            await client.query(
              `INSERT INTO job_task_logs (job_run_id, issue_key, action_type, status, message) VALUES ($1, $2, $3, $4, $5)`,
              [runId, issue.key, 'LOG_WORK', 'FAILED', JSON.stringify(errLog)]
            );
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
            await transitionIssue(api, issue.key, toClosed.id, {
              customfield_10304: logComment,
              resolution: { id: "10000" }
            });
            console.log(`[Auto] Closed ${issue.key}`);
            closedCount++;
            processedTasks.add(issue.key);
            await client.query(
              `INSERT INTO job_task_logs (job_run_id, issue_key, action_type, status, message) VALUES ($1, $2, $3, $4, $5)`,
              [runId, issue.key, 'TRANSITION_CLOSED', 'SUCCESS', `Transitioned to ${toClosed.name}`]
            );
          }
        } catch (e: any) {
          const errLog = e?.response?.data || e.message;
          console.warn(`[Auto] Failed to auto-close ${issue.key}`, errLog);
          await client.query(
            `INSERT INTO job_task_logs (job_run_id, issue_key, action_type, status, message) VALUES ($1, $2, $3, $4, $5)`,
            [runId, issue.key, 'TRANSITION_CLOSED', 'FAILED', JSON.stringify(errLog)]
          );
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
            processedTasks.add(issue.key);
            await client.query(
              `INSERT INTO job_task_logs (job_run_id, issue_key, action_type, status, message) VALUES ($1, $2, $3, $4, $5)`,
              [runId, issue.key, 'TRANSITION_IN_PROGRESS', 'SUCCESS', `Transitioned to ${toInProgress.name}`]
            );
          }
        } catch (e: any) {
          const errLog = e?.response?.data || e.message;
          console.warn(`[Auto] Failed to move ${issue.key} to In Progress`, errLog);
          await client.query(
            `INSERT INTO job_task_logs (job_run_id, issue_key, action_type, status, message) VALUES ($1, $2, $3, $4, $5)`,
            [runId, issue.key, 'TRANSITION_IN_PROGRESS', 'FAILED', JSON.stringify(errLog)]
          );
        }
      }
    }
    console.log(`[AutoProcess completed] Processed Unique Tasks: ${processedTasks.size} (InProgress: ${inProgressCount}, Closed: ${closedCount})`);
    
    if (runId) {
      await client.query(
        `UPDATE job_runs SET status = 'SUCCESS', completed_at = CURRENT_TIMESTAMP, tasks_processed = $1 WHERE id = $2`,
        [processedTasks.size, runId]
      );
    }
  } catch (err: any) {
    const errorMsg = JSON.stringify(err?.response?.data || err.message);
    console.error("Auto process user failed", errorMsg);
    if (runId) {
      await client.query(
        `UPDATE job_runs SET status = 'FAILED', completed_at = CURRENT_TIMESTAMP, error_message = $1 WHERE id = $2`,
        [errorMsg, runId]
      );
    }
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
      const res = await client.query("SELECT key, value FROM jira_app_configs WHERE key IN ('jira_pat', 'gemini_api_key', 'auto_log_enabled')");
      const configMap: any = res.rows.reduce((acc: any, row) => ({ ...acc, [row.key]: row.value }), {});
      
      if (configMap.auto_log_enabled === 'false') {
        console.log("Auto log work is disabled. Skipping execution.");
        return;
      }

      if (configMap.jira_pat) {
        await processUser(configMap.jira_pat, client, "CRON", configMap.gemini_api_key);
      } else {
        console.log("No Jira PAT found in database. Skipping execution.");
      }
    } catch (err) {
      console.error("Error fetching configs from DB:", err);
    } finally {
      await client.end();
    }
  }, {
    timezone: "Asia/Ho_Chi_Minh"
  });
}

export async function triggerManualJob() {
  console.log("Manually triggering auto-process task...");
  const client = new Client({ connectionString: POSTGRES_URL });
  try {
    await client.connect();
    const res = await client.query("SELECT key, value FROM jira_app_configs WHERE key IN ('jira_pat', 'gemini_api_key', 'auto_log_enabled')");
    const configMap: any = res.rows.reduce((acc: any, row) => ({ ...acc, [row.key]: row.value }), {});
      
    if (configMap.auto_log_enabled === 'false') {
      throw new Error("Job tự động log work đang bị tắt trong cài đặt.");
    }

    if (configMap.jira_pat) {
      await processUser(configMap.jira_pat, client, "MANUAL", configMap.gemini_api_key);
    } else {
      throw new Error("No Jira PAT configured in database");
    }
  } finally {
    await client.end();
  }
}
