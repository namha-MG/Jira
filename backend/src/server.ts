import express from "express";
import cors from "cors";
import { Client } from "pg";
import dotenv from "dotenv";
import path from "path";
import { createProxyMiddleware } from "http-proxy-middleware";
import { startCronJobs } from "./cron";

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
  const { pat } = req.body;
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
