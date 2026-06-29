import express from "express";
import cors from "cors";
import { Client } from "pg";
import dotenv from "dotenv";
import path from "path";
import { createProxyMiddleware } from "http-proxy-middleware";
import { startCronJobs, triggerManualJob } from "./cron";

dotenv.config();

const app = express();
app.use(cors());

// Giả lập lại proxy của Vite / Nginx cho Frontend gọi Jira API
app.use(
  "/jira-api",
  createProxyMiddleware({
    target: "https://20.84.97.109:3033",
    changeOrigin: true,
    secure: false, // Bỏ qua SSL verify
    pathRewrite: {
      "^/jira-api": "", // Cắt tiền tố /jira-api
    },
    on: {
      proxyReq: (proxyReq) => {
        // Ghi đè Origin và Referer để vượt lỗi 403 CSRF của Jira Server
        proxyReq.setHeader("Origin", "https://20.84.97.109:3033");
        proxyReq.setHeader("Referer", "https://20.84.97.109:3033/");
      },
    },
  })
);

app.use(express.json());

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
const POSTGRES_URL = `postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;

app.post("/api/save-token", async (req, res) => {
  const { pat, autoLogEnabled } = req.body;
  if (!pat) {
    return res.status(400).json({ error: "Missing pat" });
  }

  const client = new Client({ connectionString: POSTGRES_URL });
  try {
    await client.connect();
    // Upsert the PAT
    const query = `
      INSERT INTO jira_app_configs (key, value)
      VALUES ('jira_pat', $1)
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP
    `;
    await client.query(query, [pat]);

    if (autoLogEnabled !== undefined) {
      const query2 = `
        INSERT INTO jira_app_configs (key, value)
        VALUES ('auto_log_enabled', $1)
        ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP
      `;
      await client.query(query2, [String(autoLogEnabled)]);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error saving PAT:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await client.end();
  }
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/configs/:key", async (req, res) => {
  const client = new Client({ connectionString: POSTGRES_URL });
  try {
    await client.connect();
    const dbRes = await client.query("SELECT value FROM jira_app_configs WHERE key = $1", [req.params.key]);
    if (dbRes.rowCount && dbRes.rowCount > 0) {
      res.json({ value: dbRes.rows[0].value });
    } else {
      res.json({ value: null });
    }
  } catch (err) {
    console.error("Error fetching config:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await client.end();
  }
});

app.post("/api/configs/:key", async (req, res) => {
  const { value } = req.body;
  const client = new Client({ connectionString: POSTGRES_URL });
  try {
    await client.connect();
    await client.query(`
      INSERT INTO jira_app_configs (key, value)
      VALUES ($1, $2)
      ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP
    `, [req.params.key, String(value || "")]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error saving config:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await client.end();
  }
});

// JOB MONITOR APIs
app.get("/api/jobs", async (req, res) => {
  const client = new Client({ connectionString: POSTGRES_URL });
  try {
    await client.connect();
    const dbRes = await client.query("SELECT * FROM job_runs ORDER BY started_at DESC LIMIT 50");
    res.json(dbRes.rows);
  } catch (err) {
    console.error("Error fetching jobs:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await client.end();
  }
});

app.get("/api/jobs/:id/tasks", async (req, res) => {
  const client = new Client({ connectionString: POSTGRES_URL });
  try {
    await client.connect();
    const dbRes = await client.query("SELECT * FROM job_task_logs WHERE job_run_id = $1 ORDER BY created_at ASC", [req.params.id]);
    res.json(dbRes.rows);
  } catch (err) {
    console.error("Error fetching job tasks:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await client.end();
  }
});

app.post("/api/jobs/trigger", async (req, res) => {
  try {
    // Run in background so it doesn't block request
    triggerManualJob().catch(err => console.error("Manual job failed:", err));
    res.json({ success: true, message: "Job started in background" });
  } catch (err) {
    console.error("Error triggering job:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── TEAMS CRUD ──────────────────────────────────────────────────────────────

app.get("/api/teams", async (req, res) => {
  const client = new Client({ connectionString: POSTGRES_URL });
  try {
    await client.connect();
    const dbRes = await client.query(`
      SELECT t.*, COUNT(tm.id)::int AS member_count
      FROM teams t
      LEFT JOIN team_members tm ON t.id = tm.team_id
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `);
    res.json(dbRes.rows);
  } catch (err) {
    console.error("Error fetching teams:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await client.end();
  }
});

app.post("/api/teams", async (req, res) => {
  const { name, description, project_key } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  const client = new Client({ connectionString: POSTGRES_URL });
  try {
    await client.connect();
    const dbRes = await client.query(
      `INSERT INTO teams (name, description, project_key) VALUES ($1, $2, $3) RETURNING *`,
      [name.trim(), description || "", project_key || ""]
    );
    res.json(dbRes.rows[0]);
  } catch (err) {
    console.error("Error creating team:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await client.end();
  }
});

app.put("/api/teams/:id", async (req, res) => {
  const { name, description, project_key } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  const client = new Client({ connectionString: POSTGRES_URL });
  try {
    await client.connect();
    const dbRes = await client.query(
      `UPDATE teams SET name=$1, description=$2, project_key=$3 WHERE id=$4 RETURNING *`,
      [name.trim(), description || "", project_key || "", req.params.id]
    );
    if (dbRes.rowCount === 0) return res.status(404).json({ error: "Team not found" });
    res.json(dbRes.rows[0]);
  } catch (err) {
    console.error("Error updating team:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await client.end();
  }
});

app.delete("/api/teams/:id", async (req, res) => {
  const client = new Client({ connectionString: POSTGRES_URL });
  try {
    await client.connect();
    await client.query("DELETE FROM teams WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting team:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await client.end();
  }
});

// ─── TEAM MEMBERS CRUD ───────────────────────────────────────────────────────

app.get("/api/teams/:id/members", async (req, res) => {
  const client = new Client({ connectionString: POSTGRES_URL });
  try {
    await client.connect();
    const dbRes = await client.query(
      "SELECT * FROM team_members WHERE team_id=$1 ORDER BY created_at ASC",
      [req.params.id]
    );
    res.json(dbRes.rows);
  } catch (err) {
    console.error("Error fetching members:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await client.end();
  }
});

app.post("/api/teams/:id/members", async (req, res) => {
  const { jira_username, display_name, role } = req.body;
  if (!jira_username?.trim()) return res.status(400).json({ error: "jira_username is required" });
  const client = new Client({ connectionString: POSTGRES_URL });
  try {
    await client.connect();
    const dbRes = await client.query(
      `INSERT INTO team_members (team_id, jira_username, display_name, role)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, jira_username.trim(), display_name || "", role || ""]
    );
    res.json(dbRes.rows[0]);
  } catch (err: any) {
    if (err.code === "23505") return res.status(409).json({ error: "Thành viên đã tồn tại trong team" });
    console.error("Error adding member:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await client.end();
  }
});

app.put("/api/teams/:id/members/:memberId", async (req, res) => {
  const { jira_username, display_name, role } = req.body;
  if (!jira_username?.trim()) return res.status(400).json({ error: "jira_username is required" });
  const client = new Client({ connectionString: POSTGRES_URL });
  try {
    await client.connect();
    const dbRes = await client.query(
      `UPDATE team_members SET jira_username=$1, display_name=$2, role=$3
       WHERE id=$4 AND team_id=$5 RETURNING *`,
      [jira_username.trim(), display_name || "", role || "", req.params.memberId, req.params.id]
    );
    if (dbRes.rowCount === 0) return res.status(404).json({ error: "Member not found" });
    res.json(dbRes.rows[0]);
  } catch (err: any) {
    if (err.code === "23505") return res.status(409).json({ error: "Tên đăng nhập đã tồn tại trong team" });
    console.error("Error updating member:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await client.end();
  }
});

app.delete("/api/teams/:id/members/:memberId", async (req, res) => {
  const client = new Client({ connectionString: POSTGRES_URL });
  try {
    await client.connect();
    await client.query("DELETE FROM team_members WHERE id=$1 AND team_id=$2", [req.params.memberId, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting member:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await client.end();
  }
});

// Serve frontend static files
app.use(express.static(path.join(process.cwd(), "public")));

// Catch-all route to serve React app
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(process.cwd(), "public/index.html"));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
  startCronJobs();
});
