import { useEffect, useState, useCallback } from "react";
import { getAllIssuesByJql, JiraIssue, getAssignableUsers, updateIssue, getWorklogs, deleteWorklog, formatSeconds } from "../jiraService";
import { JIRA_PROJECTS } from "../config";
import NotificationBell from "../components/NotificationBell";
import UserSelect from "../components/UserSelect";

function getBadgeClass(statusName: string = "") {
  const s = statusName.toLowerCase();
  if (s.includes("in progress") || s.includes("đang")) return "badge badge-inprogress";
  if (s.includes("done") || s.includes("hoàn thành") || s.includes("đóng") || s.includes("closed") || s.includes("resolved")) return "badge badge-done";
  return "badge badge-todo";
}

export default function UnassignedIssues() {
  const [selectedProject, setSelectedProject] = useState(() => localStorage.getItem("default_project") || JIRA_PROJECTS[0].key);
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().slice(0, 10);
  });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [page, setPage] = useState(1);
  const pageSize = 50;
  
  // Assign modal state
  const [assignModalOpen, setAssignModalOpen] = useState<boolean>(false);
  const [targetAssignIssues, setTargetAssignIssues] = useState<string[]>([]);
  const [assigneeValue, setAssigneeValue] = useState("");
  const [assignableUsers, setAssignableUsers] = useState<any[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [assigning, setAssigning] = useState(false);

  // Batch action state
  const [selectedIssues, setSelectedIssues] = useState<string[]>([]);
  const [deletingLogs, setDeletingLogs] = useState(false);

  const fetchUnassignedIssues = useCallback(async () => {
    try {
      setLoading(true);
      setPage(1);
      const dateClause = ` AND updated >= "${dateFrom} 00:00" AND updated <= "${dateTo} 23:59"`;
      const jql = `project = "${selectedProject}" AND assignee is EMPTY${dateClause} ORDER BY updated DESC`;
      const data = await getAllIssuesByJql(jql, 500); // Lấy tối đa 500 task chưa gán
      setIssues(data);
      setSelectedIssues([]); // Xóa chọn khi tải lại
    } catch (e: any) {
      if (e.response?.status === 401 || e.response?.status === 403) {
        setIssues([]);
      }
    } finally {
      setLoading(false);
    }
  }, [selectedProject, dateFrom, dateTo]);

  useEffect(() => {
    fetchUnassignedIssues();
  }, [fetchUnassignedIssues]);

  const handleOpenAssignModal = async (issueKeys: string[]) => {
    setAssignModalOpen(true);
    setTargetAssignIssues(issueKeys);
    setAssigneeValue("");
    
    // Tải danh sách user
    try {
      setLoadingUsers(true);
      const users = await getAssignableUsers(selectedProject);
      // Lọc user trùng lặp
      const uniqueAssignees = Array.from(new Map(users.map(u => [u.accountId || u.name, u])).values());
      setAssignableUsers(uniqueAssignees);
    } catch (e) {
      console.warn("Failed to get assignable users", e);
    } finally {
      setLoadingUsers(false);
    }
  };

  const handleAssignSubmit = async () => {
    if (!assignModalOpen || !assigneeValue) return;
    try {
      setAssigning(true);
      for (const issueKey of targetAssignIssues) {
        await updateIssue(issueKey, {
          fields: {
            assignee: { name: assigneeValue }
          }
        });
      }
      setAssignModalOpen(false);
      setSelectedIssues([]);
      fetchUnassignedIssues(); // Tải lại danh sách
    } catch (e: any) {
      alert("Lỗi khi gán task: " + (e.response?.data?.errorMessages?.[0] || e.message));
    } finally {
      setAssigning(false);
    }
  };

  const handleBatchDeleteWorklogs = async () => {
    if (!window.confirm(`Bạn có chắc chắn muốn xóa tất cả worklog của ${selectedIssues.length} task đã chọn?`)) return;
    setDeletingLogs(true);
    try {
      let count = 0;
      for (const issueKey of selectedIssues) {
        const logs = await getWorklogs(issueKey);
        for (const log of logs) {
          await deleteWorklog(issueKey, log.id);
        }
        count++;
      }
      alert(`Đã xóa thành công worklog cho ${count} task.`);
      setSelectedIssues([]);
      fetchUnassignedIssues();
    } catch (e: any) {
      alert("Lỗi khi xóa worklog: " + (e.message || ""));
    } finally {
      setDeletingLogs(false);
    }
  };
  const totalPages = Math.ceil(issues.length / pageSize);
  const paginatedIssues = issues.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="page-container" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="page-header" style={{ marginBottom: 24, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1 className="page-title">Task Chưa Gán (Unassigned)</h1>
          <p className="page-subtitle">Danh sách các Issue/Sub-task chưa được phân công cho bất kỳ ai.</p>
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          {/* Date Range Picker (Pill style) */}
          <div style={{ display: "flex", alignItems: "center", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, padding: "2px 4px", boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}>
            <div style={{ padding: "0 8px" }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase" }}>Từ</span>
            </div>
            <input 
              type="date" 
              value={dateFrom} 
              onChange={e => setDateFrom(e.target.value)} 
              style={{ border: "none", background: "transparent", outline: "none", padding: "6px 4px", color: "var(--text-primary)", fontSize: 13 }} 
              disabled={loading} 
            />
            
            <div style={{ width: 1, height: 20, background: "var(--border)", margin: "0 8px" }} />
            
            <div style={{ padding: "0 8px" }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase" }}>Đến</span>
            </div>
            <input 
              type="date" 
              value={dateTo} 
              onChange={e => setDateTo(e.target.value)} 
              style={{ border: "none", background: "transparent", outline: "none", padding: "6px 4px", color: "var(--text-primary)", fontSize: 13 }} 
              disabled={loading} 
            />
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <select
              value={selectedProject}
              onChange={(e) => setSelectedProject(e.target.value)}
              style={{ width: 220, padding: "8px 12px", background: "var(--bg-card)" }}
              disabled={loading}
            >
              {JIRA_PROJECTS.map(p => (
                <option key={p.key} value={p.key}>{p.name} ({p.key})</option>
              ))}
            </select>
          </div>
          <button className="btn btn-secondary" onClick={fetchUnassignedIssues} disabled={loading} title="Làm mới">
            🔄
          </button>
          <NotificationBell />
        </div>
      </div>

      <div className="card" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {selectedIssues.length > 0 && (
          <div style={{ padding: "12px 16px", background: "rgba(59, 130, 246, 0.1)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--accent-blue)" }}>
              Đã chọn {selectedIssues.length} task
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <button 
                className="btn btn-secondary btn-sm" 
                onClick={() => setSelectedIssues([])}
                disabled={assigning || deletingLogs}
              >
                Bỏ chọn
              </button>
              <button 
                className="btn btn-danger btn-sm"
                onClick={handleBatchDeleteWorklogs}
                disabled={assigning || deletingLogs}
                style={{ background: "#ef4444", color: "white", border: "none" }}
              >
                {deletingLogs ? "Đang xóa..." : "Xóa Worklog"}
              </button>
              <button 
                className="btn btn-primary btn-sm"
                onClick={() => handleOpenAssignModal(selectedIssues)}
                disabled={assigning || deletingLogs}
              >
                Gán cho người khác
              </button>
            </div>
          </div>
        )}
        <div style={{ flex: 1, overflow: "auto", minHeight: 300 }}>
          <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead style={{ position: "sticky", top: 0, background: "var(--bg-card)", zIndex: 1, boxShadow: "0 1px 0 var(--border)" }}>
              <tr>
                <th style={{ width: 40, textAlign: "center" }}>
                  <input
                    type="checkbox"
                    checked={issues.length > 0 && selectedIssues.length === issues.length}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedIssues(issues.map(i => i.key));
                      } else {
                        setSelectedIssues([]);
                      }
                    }}
                  />
                </th>
                <th style={{ width: 100 }}>Type</th>
                <th style={{ width: 120 }}>Key</th>
                <th>Summary</th>
                <th style={{ width: 140 }}>Status</th>
                <th style={{ width: 120 }}>Created</th>
                <th style={{ width: 100, textAlign: "right" }}>Logged</th>
                <th style={{ width: 100, textAlign: "right" }}>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: "center", padding: "40px 0" }}>
                    <div className="spinning" style={{ fontSize: 24, marginBottom: 8 }}>🌀</div>
                    <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Đang tải danh sách...</div>
                  </td>
                </tr>
              ) : issues.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: "center", padding: "40px 0" }}>
                    <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.5 }}>🍃</div>
                    <div style={{ color: "var(--text-muted)", fontSize: 14 }}>Dự án này không có task nào chưa được gán. Tuyệt vời!</div>
                  </td>
                </tr>
              ) : (
                paginatedIssues.map(issue => {
                  const createdDate = new Date(issue.fields.created).toLocaleDateString("vi-VN", {
                    day: "2-digit", month: "2-digit", year: "numeric"
                  });

                  return (
                    <tr key={issue.id}>
                      <td style={{ textAlign: "center" }}>
                        <input
                          type="checkbox"
                          checked={selectedIssues.includes(issue.key)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedIssues(prev => [...prev, issue.key]);
                            } else {
                              setSelectedIssues(prev => prev.filter(k => k !== issue.key));
                            }
                          }}
                        />
                      </td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          {issue.fields.issuetype?.iconUrl && (
                            <img src={issue.fields.issuetype.iconUrl} alt="type" style={{ width: 14, height: 14, borderRadius: 2 }} />
                          )}
                          <span style={{ fontSize: 12 }}>{issue.fields.issuetype?.name}</span>
                        </div>
                      </td>
                      <td>
                        <a
                          href={`https://20.84.97.109:3033/browse/${issue.key}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            fontSize: 12, fontWeight: 600, color: "var(--accent-blue-light)",
                            textDecoration: "none", background: "rgba(59, 130, 246, 0.1)",
                            padding: "2px 6px", borderRadius: 4
                          }}
                        >
                          {issue.key}
                        </a>
                      </td>
                      <td style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>
                        {issue.fields.summary}
                        {issue.fields.parent && (
                          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
                            <span style={{ padding: "0 4px", background: "rgba(255,255,255,0.1)", borderRadius: 2 }}>{issue.fields.parent.key}</span>
                            {issue.fields.parent.fields?.summary}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={getBadgeClass(issue.fields.status.name)}>
                          {issue.fields.status.name}
                        </span>
                      </td>
                      <td style={{ fontSize: 12, color: "var(--text-muted)" }}>{createdDate}</td>
                      <td style={{ textAlign: "right", fontSize: 13, fontWeight: 500, color: (issue.fields.aggregatetimespent || issue.fields.timetracking?.timeSpentSeconds) ? "var(--accent-orange, #f97316)" : "var(--text-muted)" }}>
                        {formatSeconds(issue.fields.aggregatetimespent || issue.fields.timetracking?.timeSpentSeconds || 0)}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          className="btn btn-primary btn-sm"
                          style={{ padding: "4px 8px", fontSize: 12 }}
                          onClick={() => handleOpenAssignModal([issue.key])}
                        >
                          Gán cho...
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--bg-card)", borderBottomLeftRadius: 10, borderBottomRightRadius: 10 }}>
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
              Hiển thị {(page - 1) * pageSize + 1} - {Math.min(page * pageSize, issues.length)} / {issues.length} task
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>Trước</button>
              <div style={{ display: "flex", alignItems: "center", padding: "0 8px", fontSize: 13, fontWeight: 500 }}>
                Trang {page} / {totalPages}
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>Sau</button>
            </div>
          </div>
        )}
      </div>

      {/* Assign Modal */}
      {assignModalOpen && (
        <div className="modal-overlay" onClick={() => !assigning && setAssignModalOpen(false)}>
          <div className="modal" style={{ maxWidth: 400 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                Gán Assignee - {targetAssignIssues.length > 1 ? `${targetAssignIssues.length} tasks` : targetAssignIssues[0]}
              </div>
              <button className="modal-close" onClick={() => !assigning && setAssignModalOpen(false)}>✕</button>
            </div>
            <div className="form-group">
              <label>Chọn người thực hiện</label>
              <UserSelect
                users={assignableUsers}
                value={assigneeValue}
                onChange={setAssigneeValue}
                loading={loadingUsers}
                disabled={assigning}
                placeholder="-- Chọn người thực hiện --"
              />
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setAssignModalOpen(false)} disabled={assigning}>Hủy</button>
              <button className="btn btn-primary" onClick={handleAssignSubmit} disabled={!assigneeValue || assigning}>
                {assigning ? "Đang lưu..." : "Xác nhận gán"}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
