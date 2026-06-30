import React, { useEffect, useState } from "react";
import { jobStore, BackgroundJob } from "../stores/jobStore";

export default function JobManager() {
  const [jobs, setJobs] = useState<BackgroundJob[]>(jobStore.getJobs());
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const unsubscribe = jobStore.subscribe(() => {
      setJobs(jobStore.getJobs());
    });
    return unsubscribe;
  }, []);

  if (jobs.length === 0) return null;

  const runningCount = jobs.filter(j => j.status === "running").length;
  const errorCount = jobs.filter(j => j.status === "error").length;
  const successCount = jobs.filter(j => j.status === "success").length;

  return (
    <div style={{
      position: "fixed",
      bottom: 24,
      right: 24,
      zIndex: 9999,
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-end",
      gap: 12
    }}>
      {/* Toggle Button */}
      <button 
        onClick={() => setIsOpen(!isOpen)}
        style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--border)",
          borderRadius: 24,
          padding: "8px 16px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          boxShadow: "var(--shadow-lg)",
          cursor: "pointer",
          color: "var(--text-primary)",
          fontWeight: 600,
          fontSize: 13
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {runningCount > 0 ? <div className="loading-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> : "🚀"}
          Tiến trình nền ({jobs.length})
        </span>
        <div style={{ display: "flex", gap: 6, fontSize: 12 }}>
          {runningCount > 0 && <span style={{ color: "var(--accent-blue)" }}>{runningCount} Đang chạy</span>}
          {successCount > 0 && <span style={{ color: "var(--accent-green)" }}>{successCount} ✓</span>}
          {errorCount > 0 && <span style={{ color: "var(--accent-red)" }}>{errorCount} ✗</span>}
        </div>
      </button>

      {/* Dropdown / Drawer */}
      {isOpen && (
        <div style={{
          width: 380,
          maxHeight: "60vh",
          background: "var(--bg-secondary)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          boxShadow: "var(--shadow-xl)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden"
        }}>
          <div style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            background: "var(--bg-primary)"
          }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>Background Jobs</span>
            <div style={{ display: "flex", gap: 8 }}>
              {jobs.some(j => j.status !== "running") && (
                <button 
                  className="btn btn-ghost btn-sm" 
                  style={{ fontSize: 11, padding: "2px 8px" }}
                  onClick={() => jobStore.clearCompleted()}
                >
                  Xóa hoàn tất
                </button>
              )}
            </div>
          </div>
          
          <div style={{ overflowY: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {jobs.map(job => (
              <div key={job.id} style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "10px 12px",
                display: "flex",
                flexDirection: "column",
                gap: 4
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", flex: 1, wordBreak: "break-word" }}>
                    {job.title}
                  </div>
                  <div>
                    {job.status === "running" && <div className="loading-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />}
                    {job.status === "success" && <span style={{ color: "var(--accent-green)", fontWeight: 700 }}>✓</span>}
                    {job.status === "error" && <span style={{ color: "var(--accent-red)", fontWeight: 700 }}>✕</span>}
                  </div>
                </div>
                
                {job.status === "error" && job.errorMsg && (
                  <div style={{ fontSize: 11, color: "var(--accent-red)", background: "rgba(239, 68, 68, 0.1)", padding: 6, borderRadius: 4, marginTop: 4 }}>
                    {job.errorMsg}
                  </div>
                )}
                
                <div style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ textTransform: "uppercase" }}>{job.type}</span>
                  <span>{new Date(job.createdAt).toLocaleTimeString("vi-VN")}</span>
                  {job.status !== "running" && (
                    <button 
                      className="btn btn-ghost btn-sm" 
                      style={{ padding: "0 4px", fontSize: 10, height: 20, minHeight: 20 }}
                      onClick={() => jobStore.removeJob(job.id)}
                    >
                      Bỏ qua
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
