import { useEffect, useState } from "react";

interface JobRun {
  id: number;
  run_type: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  tasks_processed: number;
  error_message: string | null;
}

interface JobTaskLog {
  id: number;
  job_run_id: number;
  issue_key: string;
  action_type: string;
  status: string;
  message: string;
  created_at: string;
}

export default function JobLogs() {
  const [jobs, setJobs] = useState<JobRun[]>([]);
  const [selectedJob, setSelectedJob] = useState<number | null>(null);
  const [taskLogs, setTaskLogs] = useState<JobTaskLog[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [loadingTasks, setLoadingTasks] = useState(false);

  const fetchJobs = async () => {
    setLoadingJobs(true);
    try {
      const res = await fetch("/api/jobs");
      const data = await res.json();
      setJobs(data);
      if (data.length > 0 && selectedJob === null) {
        setSelectedJob(data[0].id);
      }
    } catch (err) {
      console.error("Failed to fetch jobs:", err);
    } finally {
      setLoadingJobs(false);
    }
  };

  const fetchTaskLogs = async (jobId: number) => {
    setLoadingTasks(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/tasks`);
      const data = await res.json();
      setTaskLogs(data);
    } catch (err) {
      console.error("Failed to fetch task logs:", err);
    } finally {
      setLoadingTasks(false);
    }
  };

  const triggerManualJob = async () => {
    try {
      await fetch("/api/jobs/trigger", { method: "POST" });
      alert("Đã gửi lệnh chạy Job ngầm. Vui lòng refresh lại sau ít phút để xem kết quả.");
      setTimeout(fetchJobs, 2000);
    } catch (err) {
      console.error("Trigger error:", err);
      alert("Lỗi khi gọi manual job.");
    }
  };

  useEffect(() => {
    fetchJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedJob !== null) {
      fetchTaskLogs(selectedJob);
    }
  }, [selectedJob]);

  const formatDateTime = (isoStr: string | null) => {
    if (!isoStr) return "-";
    return new Date(isoStr).toLocaleString("vi-VN", {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  };

  const getStatusBadge = (status: string) => {
    if (status === "SUCCESS") return <span className="badge badge-done" style={{ padding: "2px 6px", fontSize: 10 }}>SUCCESS</span>;
    if (status === "FAILED") return <span className="badge badge-blocked" style={{ padding: "2px 6px", fontSize: 10 }}>FAILED</span>;
    if (status === "RUNNING") return <span className="badge badge-inprogress" style={{ padding: "2px 6px", fontSize: 10 }}>RUNNING</span>;
    return <span className="badge badge-todo" style={{ padding: "2px 6px", fontSize: 10 }}>{status}</span>;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div className="page-header" style={{ flexWrap: "wrap", gap: 12 }}>
        <div className="page-title-group">
          <h1 className="page-title">Job Monitor</h1>
          <p className="page-subtitle">Theo dõi lịch sử chạy Job tự động (Cron)</p>
        </div>
        <div className="page-actions" style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn btn-primary btn-sm" onClick={triggerManualJob}>
            ▶️ Chạy Job Ngay
          </button>
          <button className="btn btn-secondary btn-sm" onClick={fetchJobs} disabled={loadingJobs}>
            <span className={loadingJobs ? "spinning" : ""}>🔄</span> Refresh
          </button>
        </div>
      </div>

      <div className="page-body" style={{ display: "grid", gridTemplateColumns: "350px 1fr", gap: 16, height: "calc(100vh - 120px)", overflow: "hidden" }}>
        
        {/* Left Pane: Job List */}
        <div className="chart-card" style={{ padding: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: 16, borderBottom: "1px solid var(--border)", background: "rgba(255,255,255,0.02)" }}>
            <h3 style={{ margin: 0, fontSize: 14, color: "var(--text-primary)" }}>Lịch sử Job ({jobs.length})</h3>
          </div>
          
          <div style={{ overflowY: "auto", flex: 1, padding: 8 }}>
            {loadingJobs ? (
              <div style={{ textAlign: "center", padding: 20, color: "var(--text-muted)" }}>Đang tải...</div>
            ) : jobs.length === 0 ? (
              <div style={{ textAlign: "center", padding: 20, color: "var(--text-muted)" }}>Chưa có Job nào được chạy.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {jobs.map(job => (
                  <div 
                    key={job.id} 
                    onClick={() => setSelectedJob(job.id)}
                    style={{ 
                      padding: "12px 16px", 
                      borderRadius: 10, 
                      cursor: "pointer",
                      border: "1px solid",
                      borderColor: selectedJob === job.id ? "var(--accent-blue)" : "var(--border)",
                      background: selectedJob === job.id ? "rgba(79, 142, 247, 0.05)" : "transparent",
                      transition: "all 0.2s"
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text-primary)" }}>
                        #{job.id} - {job.run_type}
                      </div>
                      {getStatusBadge(job.status)}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", justifyContent: "space-between" }}>
                      <span>Bắt đầu: {formatDateTime(job.started_at)}</span>
                    </div>
                    {job.completed_at && (
                      <div style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                        <span>Hoàn thành: {formatDateTime(job.completed_at)}</span>
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 6, display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: job.tasks_processed > 0 ? "var(--accent-green)" : "var(--text-muted)" }}></span>
                      {job.tasks_processed} tasks được xử lý
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Pane: Task Details */}
        <div className="chart-card" style={{ padding: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {selectedJob === null ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)" }}>
              Chọn một Job ở cột bên trái để xem chi tiết
            </div>
          ) : (
            <>
              <div style={{ padding: 16, borderBottom: "1px solid var(--border)", background: "rgba(255,255,255,0.02)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3 style={{ margin: 0, fontSize: 14, color: "var(--text-primary)" }}>Chi tiết Task của Job #{selectedJob}</h3>
                <button className="btn btn-ghost btn-sm" onClick={() => fetchTaskLogs(selectedJob)}>🔄 Tải lại</button>
              </div>

              <div style={{ overflowY: "auto", flex: 1, padding: 16 }}>
                {/* Error Banner */}
                {jobs.find(j => j.id === selectedJob)?.error_message && (
                  <div style={{ padding: 16, background: "rgba(239, 68, 68, 0.1)", borderLeft: "4px solid var(--accent-red)", borderRadius: "4px 8px 8px 4px", marginBottom: 16 }}>
                    <h4 style={{ margin: "0 0 8px 0", color: "var(--accent-red)", fontSize: 13 }}>Job Error</h4>
                    <pre style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {jobs.find(j => j.id === selectedJob)?.error_message}
                    </pre>
                  </div>
                )}

                {loadingTasks ? (
                  <div style={{ textAlign: "center", padding: 20, color: "var(--text-muted)" }}>Đang tải danh sách task...</div>
                ) : taskLogs.length === 0 ? (
                  <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted)" }}>
                    <div style={{ fontSize: 40, marginBottom: 12 }}>💤</div>
                    Không có task nào được xử lý trong đợt này.
                  </div>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left" }}>
                        <th style={{ padding: "8px 12px", color: "var(--text-muted)", fontWeight: 500, width: 100 }}>Thời gian</th>
                        <th style={{ padding: "8px 12px", color: "var(--text-muted)", fontWeight: 500, width: 100 }}>Issue</th>
                        <th style={{ padding: "8px 12px", color: "var(--text-muted)", fontWeight: 500, width: 150 }}>Action</th>
                        <th style={{ padding: "8px 12px", color: "var(--text-muted)", fontWeight: 500, width: 80 }}>Status</th>
                        <th style={{ padding: "8px 12px", color: "var(--text-muted)", fontWeight: 500 }}>Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {taskLogs.map(log => (
                        <tr key={log.id} style={{ borderBottom: "1px solid var(--border)" }}>
                          <td style={{ padding: "10px 12px", color: "var(--text-secondary)" }}>
                            {new Date(log.created_at).toLocaleTimeString("vi-VN")}
                          </td>
                          <td style={{ padding: "10px 12px", fontWeight: 600, color: "var(--accent-blue-light)" }}>
                            {log.issue_key}
                          </td>
                          <td style={{ padding: "10px 12px" }}>
                            <span style={{ 
                              padding: "2px 6px", 
                              borderRadius: 4, 
                              background: "rgba(255,255,255,0.05)",
                              border: "1px solid rgba(255,255,255,0.1)",
                              fontSize: 10
                            }}>
                              {log.action_type}
                            </span>
                          </td>
                          <td style={{ padding: "10px 12px" }}>
                            {getStatusBadge(log.status)}
                          </td>
                          <td style={{ padding: "10px 12px", color: log.status === 'FAILED' ? "var(--accent-red)" : "var(--text-primary)", wordBreak: "break-word" }}>
                            {log.message}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>

      </div>
    </div>
  );
}
