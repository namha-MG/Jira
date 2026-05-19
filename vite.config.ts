import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/jira-api": {
        target: "https://20.84.97.109:3033",
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/jira-api/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            // Jira Server STRICTLY checks Origin/Referer for POST/PUT to prevent CSRF.
            // We MUST override them to match the Jira Server URL, otherwise it returns 403 Forbidden.
            proxyReq.setHeader("Origin", "https://20.84.97.109:3033");
            proxyReq.setHeader("Referer", "https://20.84.97.109:3033/");
          });
        },
      },
    },
  },
});
