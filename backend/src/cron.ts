import cron from "node-cron";
import { Client } from "pg";
import dotenv from "dotenv";
import { getJiraApi, getMyIssues, getTransitions, transitionIssue, addWorklog } from "./jiraService";
import { runGitReconciliation } from "./gitReconciliation";

dotenv.config();

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
const POSTGRES_URL = `postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
let gitReconciliationRunning = false;

function todayInBangkok() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function currentTimeInBangkok() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.hour}:${byType.minute}`;
}

function parseJsonConfig<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseListConfig(value: string | undefined) {
  return String(value || "")
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function processUserLegacy(pat: string, client: Client, runType: string = "CRON", geminiKey?: string) {
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

function jiraDatePart(value: string | undefined | null) {
  return String(value || "").match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || null;
}

function jobErrorMessage(error: any) {
  const detail = error?.response?.data || error?.message || error;
  return typeof detail === "string" ? detail : JSON.stringify(detail);
}

async function writeAutoJobLog(
  client: Client,
  runId: number | null,
  issueKey: string,
  actionType: string,
  status: string,
  message: string,
) {
  if (runId === null) {
    throw new Error("Cannot write auto-job detail before the job run is created.");
  }
  await client.query(
    `INSERT INTO job_task_logs (job_run_id, issue_key, action_type, status, message)
     VALUES ($1, $2, $3, $4, $5)`,
    [runId, issueKey, actionType, status, message],
  );
}

async function generateWorklogComment(summary: string, geminiKey?: string) {
  const fallback = "Hoàn thành công việc theo yêu cầu";
  if (!geminiKey) return fallback;

  try {
    const prompt = `Viết một câu tiếng Việt tự nhiên dưới 15 từ để log work cho task: "${summary}". Chỉ trả về nội dung câu.`;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      },
    );
    if (!response.ok) return fallback;
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || fallback;
  } catch (error) {
    console.warn("AI generation failed for auto log work, using fallback", error);
    return fallback;
  }
}

async function processUser(pat: string, client: Client, runType: string = "CRON", geminiKey?: string) {
  let runId: number | null = null;

  try {
    const runRes = await client.query(
      `INSERT INTO job_runs (run_type, status) VALUES ($1, 'RUNNING') RETURNING id`,
      [runType],
    );
    runId = runRes.rows[0].id;

    const api = getJiraApi(pat);
    const result = await getMyIssues(api, []);
    const issues = result.issues;
    const today = todayInBangkok();
    const processedTasks = new Set<string>();
    let logWorkCount = 0;
    let inProgressCount = 0;
    let closedCount = 0;
    let failureCount = 0;

    await writeAutoJobLog(
      client,
      runId,
      "__JOB__",
      "JOB_SCAN",
      "SUCCESS",
      `Loaded ${issues.length}/${result.total} assigned Jira issues. Evaluation date: ${today} (Asia/Bangkok).`,
    );

    for (const issue of issues) {
      const status = issue.fields.status?.name || "Unknown";
      const statusName = status.toLowerCase();
      const isDone =
        statusName.includes("close") ||
        statusName.includes("resolve") ||
        statusName.includes("cancel") ||
        statusName.includes("done") ||
        statusName.includes("đóng") ||
        statusName.includes("hoàn thành") ||
        statusName.includes("đã giải quyết");

      if (isDone) {
        await writeAutoJobLog(client, runId, issue.key, "AUTO_CHECK", "SKIPPED", `Status is already "${status}".`);
        continue;
      }

      if (!issue.fields.assignee) {
        await writeAutoJobLog(client, runId, issue.key, "AUTO_CHECK", "SKIPPED", "Issue has no assignee.");
        continue;
      }

      const startDate = jiraDatePart(issue.fields.customfield_10300);
      // The UI treats customfield_10302 as End Date, so it must take precedence.
      const endDate = jiraDatePart(issue.fields.customfield_10302 || issue.fields.duedate);
      const isToDo = ["open", "to do", "mở", "cần làm"].includes(statusName);

      if (endDate && endDate <= today) {
        const estimate = issue.fields.timetracking?.originalEstimateSeconds || 0;
        const logged = issue.fields.timetracking?.timeSpentSeconds || 0;
        const secondsToLog = estimate > 0
          ? Math.max(0, estimate - logged)
          : (logged === 0 ? 8 * 3600 : 0);

        await writeAutoJobLog(
          client,
          runId,
          issue.key,
          "AUTO_CHECK",
          "SUCCESS",
          `Due: End Date ${endDate}; estimate ${estimate}s; logged ${logged}s; status "${status}".`,
        );

        let worklogSucceeded = true;
        const comment = await generateWorklogComment(issue.fields.summary, geminiKey);

        if (secondsToLog > 0) {
          try {
            await addWorklog(api, issue.key, secondsToLog, comment);
            logWorkCount++;
            processedTasks.add(issue.key);
            await writeAutoJobLog(
              client,
              runId,
              issue.key,
              "LOG_WORK",
              "SUCCESS",
              `Logged ${secondsToLog}s (estimate ${estimate}s, previously logged ${logged}s): ${comment}`,
            );
          } catch (error) {
            worklogSucceeded = false;
            failureCount++;
            await writeAutoJobLog(client, runId, issue.key, "LOG_WORK", "FAILED", jobErrorMessage(error));
          }
        } else {
          await writeAutoJobLog(
            client,
            runId,
            issue.key,
            "LOG_WORK",
            "SKIPPED",
            estimate > 0
              ? `Already logged ${logged}s of ${estimate}s estimate.`
              : "No estimate is configured and the issue already has logged time.",
          );
        }

        if (!worklogSucceeded) {
          await writeAutoJobLog(
            client,
            runId,
            issue.key,
            "TRANSITION_CLOSED",
            "SKIPPED",
            "Close skipped because automatic worklog failed.",
          );
          continue;
        }

        try {
          const transitions = await getTransitions(api, issue.key);
          const closeKeywords = ["closed", "close", "đóng", "resolved", "resolve", "done", "đã giải quyết", "hoàn thành"];
          const closeTransition = transitions.find((transition: any) => {
            const transitionName = String(transition.name || "").toLowerCase();
            const destinationName = String(transition.to?.name || "").toLowerCase();
            return closeKeywords.some(keyword =>
              transitionName.includes(keyword) || destinationName.includes(keyword),
            );
          });

          if (!closeTransition) {
            failureCount++;
            await writeAutoJobLog(
              client,
              runId,
              issue.key,
              "TRANSITION_CLOSED",
              "FAILED",
              `No Close/Resolve transition is available from status "${status}".`,
            );
            continue;
          }

          await transitionIssue(api, issue.key, closeTransition.id, {
            customfield_10304: comment,
            resolution: { id: "10000" },
          });
          closedCount++;
          processedTasks.add(issue.key);
          await writeAutoJobLog(
            client,
            runId,
            issue.key,
            "TRANSITION_CLOSED",
            "SUCCESS",
            `Transitioned to ${closeTransition.name}.`,
          );
        } catch (error) {
          failureCount++;
          await writeAutoJobLog(client, runId, issue.key, "TRANSITION_CLOSED", "FAILED", jobErrorMessage(error));
        }
      } else if (startDate && startDate <= today && isToDo) {
        await writeAutoJobLog(
          client,
          runId,
          issue.key,
          "AUTO_CHECK",
          "SUCCESS",
          `Start Date ${startDate} reached; attempting In Progress transition.`,
        );

        try {
          const transitions = await getTransitions(api, issue.key);
          const inProgressKeywords = ["in progress", "đang thực hiện", "đang làm"];
          const transition = transitions.find((item: any) => {
            const transitionName = String(item.name || "").toLowerCase();
            const destinationName = String(item.to?.name || "").toLowerCase();
            return inProgressKeywords.some(keyword =>
              transitionName.includes(keyword) || destinationName.includes(keyword),
            );
          });

          if (!transition) {
            failureCount++;
            await writeAutoJobLog(
              client,
              runId,
              issue.key,
              "TRANSITION_IN_PROGRESS",
              "FAILED",
              `No In Progress transition is available from status "${status}".`,
            );
            continue;
          }

          await transitionIssue(api, issue.key, transition.id);
          inProgressCount++;
          processedTasks.add(issue.key);
          await writeAutoJobLog(
            client,
            runId,
            issue.key,
            "TRANSITION_IN_PROGRESS",
            "SUCCESS",
            `Transitioned to ${transition.name}.`,
          );
        } catch (error) {
          failureCount++;
          await writeAutoJobLog(client, runId, issue.key, "TRANSITION_IN_PROGRESS", "FAILED", jobErrorMessage(error));
        }
      } else {
        const reason = !startDate && !endDate
          ? "No Start Date or End Date is configured."
          : `Not due. Start Date: ${startDate || "none"}; End Date: ${endDate || "none"}; status: "${status}".`;
        await writeAutoJobLog(client, runId, issue.key, "AUTO_CHECK", "SKIPPED", reason);
      }
    }

    const finalStatus = failureCount > 0 ? "PARTIAL_SUCCESS" : "SUCCESS";
    const summary = `Scanned ${issues.length}; worklogged ${logWorkCount}; moved to In Progress ${inProgressCount}; closed ${closedCount}; failures ${failureCount}.`;
    await writeAutoJobLog(client, runId, "__JOB__", "JOB_SUMMARY", finalStatus, summary);
    await client.query(
      `UPDATE job_runs
       SET status = $1, completed_at = CURRENT_TIMESTAMP, tasks_processed = $2, error_message = $3
       WHERE id = $4`,
      [
        finalStatus,
        processedTasks.size,
        failureCount > 0 ? `${failureCount} action(s) failed. See task logs for details.` : null,
        runId,
      ],
    );
  } catch (error) {
    const message = jobErrorMessage(error);
    console.error("Auto process user failed", message);
    if (runId) {
      await client.query(
        `UPDATE job_runs SET status = 'FAILED', completed_at = CURRENT_TIMESTAMP, error_message = $1 WHERE id = $2`,
        [message, runId],
      );
    }
  }
}

async function runGitReconciliationJob(client: Client, runType: string = "GIT_RECONCILIATION_CRON") {
  let runId: number | null = null;

  try {
    const runRes = await client.query(
      `INSERT INTO job_runs (run_type, status) VALUES ($1, 'RUNNING') RETURNING id`,
      [runType]
    );
    runId = runRes.rows[0].id;

    const configRes = await client.query(`
      SELECT key, value FROM jira_app_configs
      WHERE key IN (
        'jira_pat',
        'git_pat',
        'git_project_links',
        'git_accounts',
        'gemini_api_key',
        'telegram_bot_token',
        'telegram_chat_id',
        'selected_jira_projects'
      )
    `);
    const configMap: Record<string, string> = configRes.rows.reduce((acc: Record<string, string>, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});

    if (!configMap.jira_pat) {
      throw new Error("Missing Jira PAT for Git reconciliation job");
    }

    const projectGitLinks = parseJsonConfig<Record<string, string[]>>(configMap.git_project_links, {});
    const configuredProjectKeys = parseJsonConfig<string[]>(configMap.selected_jira_projects, []);
    const projectKeys = configuredProjectKeys.length > 0
      ? configuredProjectKeys
      : Object.keys(projectGitLinks).filter((projectKey) => (projectGitLinks[projectKey] || []).length > 0);

    if (projectKeys.length === 0) {
      throw new Error("No project configured for Git reconciliation job");
    }

    const result = await runGitReconciliation({
      date: todayInBangkok(),
      projectKeys,
      jiraPat: configMap.jira_pat,
      gitPat: configMap.git_pat || "",
      projectGitLinks,
      gitAccounts: parseListConfig(configMap.git_accounts),
      geminiKey: configMap.gemini_api_key || "",
      telegramBotToken: configMap.telegram_bot_token || "",
      telegramChatId: configMap.telegram_chat_id || "",
    });

    for (const row of result.results) {
      await client.query(
        `INSERT INTO job_task_logs (job_run_id, issue_key, action_type, status, message) VALUES ($1, $2, $3, $4, $5)`,
        [
          runId,
          row.issueKey,
          "GIT_RECONCILIATION",
          row.status === "matched" ? "SUCCESS" : "FAILED",
          `${row.accountLabel}: ${row.matchReason}${row.matchedCommit ? ` | ${row.matchedCommit.shortSha}` : ""}`,
        ]
      );
    }

    for (const repoError of result.repoErrors) {
      await client.query(
        `INSERT INTO job_task_logs (job_run_id, issue_key, action_type, status, message) VALUES ($1, $2, $3, $4, $5)`,
        [runId, repoError.projectKey, "GIT_REPO_SCAN", "FAILED", `${repoError.repoUrl}: ${repoError.error}`]
      );
    }

    await client.query(
      `UPDATE job_runs SET status = 'SUCCESS', completed_at = CURRENT_TIMESTAMP, tasks_processed = $1 WHERE id = $2`,
      [result.stats.loggedTaskCount, runId]
    );

    if (runType === "GIT_RECONCILIATION_CRON") {
      await client.query(`
        INSERT INTO jira_app_configs (key, value)
        VALUES ('git_reconciliation_last_run_date', $1)
        ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP
      `, [todayInBangkok()]);
    }

    console.log(`[GitReconciliation] Completed: ${result.stats.matchedCount}/${result.stats.loggedTaskCount} matched`);
  } catch (err: any) {
    const errorMsg = err?.response?.data ? JSON.stringify(err.response.data) : (err?.message || "Unknown error");
    console.error("[GitReconciliation] Job failed:", errorMsg);
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

  cron.schedule("* * * * *", async () => {
    if (gitReconciliationRunning) return;

    const client = new Client({ connectionString: POSTGRES_URL });
    try {
      await client.connect();
      const res = await client.query(`
        SELECT key, value FROM jira_app_configs
        WHERE key IN ('git_reconciliation_enabled', 'git_reconciliation_time', 'git_reconciliation_last_run_date')
      `);
      const configMap: Record<string, string> = res.rows.reduce((acc: Record<string, string>, row) => {
        acc[row.key] = row.value;
        return acc;
      }, {});

      if (configMap.git_reconciliation_enabled !== "true") return;

      const scheduleTime = configMap.git_reconciliation_time || "18:00";
      const today = todayInBangkok();
      if (configMap.git_reconciliation_last_run_date === today) return;
      if (currentTimeInBangkok() !== scheduleTime) return;

      gitReconciliationRunning = true;
      console.log(`[GitReconciliation] Running scheduled job at ${scheduleTime}`);
      await runGitReconciliationJob(client);
    } catch (err) {
      console.error("[GitReconciliation] Scheduler failed:", err);
    } finally {
      gitReconciliationRunning = false;
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

export async function triggerGitReconciliationJob() {
  if (gitReconciliationRunning) {
    throw new Error("Git reconciliation job is already running");
  }

  const client = new Client({ connectionString: POSTGRES_URL });
  try {
    gitReconciliationRunning = true;
    await client.connect();
    await runGitReconciliationJob(client, "GIT_RECONCILIATION_MANUAL");
  } finally {
    gitReconciliationRunning = false;
    await client.end();
  }
}
