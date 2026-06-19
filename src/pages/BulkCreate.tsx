import React, { useState, useEffect } from "react";
import * as XLSX from "xlsx";
import { createIssue, createSubTask, addWorklog, JiraIssue, JiraUser, getLatestTaskDate, getAssignableUsers } from "../jiraService";
import { JIRA_PROJECTS } from "../config";

interface CreationLog {
  summary: string;
  status: "pending" | "processing" | "success" | "error";
  key?: string;
  errorMsg?: string;
  logDateText?: string;
}

const parseExcelDate = (val: any): Date | null => {
  if (!val) return null;
  if (val instanceof Date && !isNaN(val.getTime())) return val;
  if (typeof val === "number") {
    return new Date(Math.round((val - 25569) * 86400 * 1000));
  }
  if (typeof val === "string") {
    const dObj = new Date(val);
    if (!isNaN(dObj.getTime())) return dObj;
    
    const parts = val.split(/[-/]/);
    if (parts.length >= 3) {
      const p1 = parseInt(parts[0], 10);
      const p2 = parseInt(parts[1], 10);
      const p3 = parseInt(parts[2].substring(0, 4), 10);
      
      if (p3 >= 1000 && p1 <= 31 && p2 <= 12) {
        return new Date(p3, p2 - 1, p1);
      }
    }
  }
  return null;
};

export default function BulkCreate() {
  const [selectedProject, setSelectedProject] = useState(JIRA_PROJECTS[0].key);
  const [bulkText, setBulkText] = useState("");
  const [assignee, setAssignee] = useState("");
  const [estimate] = useState("7h"); // Cố định 7h theo yêu cầu thủ công
  const [autoLogWork, setAutoLogWork] = useState(true);
  const [startDate, setStartDate] = useState(() => {
    const now = new Date();
    return now.toISOString().slice(0, 10);
  });
  const [logs, setLogs] = useState<CreationLog[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  
  const [creationMode, setCreationMode] = useState<"manual" | "ai" | "excel">("manual");
  const [aiContext, setAiContext] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzedTasks, setAnalyzedTasks] = useState<{summary: string, assignee: string}[]>([]);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const ROLES = ["Frontend", "Backend", "Mobile", "Tester", "BA", "QA", "DevOps", "Scrum Master"];
  
  const [assignableUsers, setAssignableUsers] = useState<JiraUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  
  const [excelData, setExcelData] = useState<any[]>([]);

  const isConfigured = !!localStorage.getItem("jira_pat") || !!localStorage.getItem("jira_basic");

  useEffect(() => {
    if (isConfigured && selectedProject) {
      setLoadingUsers(true);
      getAssignableUsers(selectedProject)
        .then(users => setAssignableUsers(users))
        .catch(e => console.error("Failed to load assignable users", e))
        .finally(() => setLoadingUsers(false));
    }
  }, [isConfigured, selectedProject]);

  const getNextWorkday = (date: Date): Date => {
    const d = new Date(date);
    while (d.getDay() === 0 || d.getDay() === 6) {
      d.setDate(d.getDate() + 1);
    }
    return d;
  };

  const advanceDay = (date: Date): Date => {
    const d = new Date(date);
    d.setDate(d.getDate() + 1);
    return getNextWorkday(d);
  };

  const calculateWorkingDays = (s: Date | null, e: Date | null) => {
    if (!s || !e || isNaN(s.getTime()) || isNaN(e.getTime())) return 0;
    let days = 0;
    let curr = new Date(s);
    while (curr <= e) {
      if (curr.getDay() !== 0 && curr.getDay() !== 6) days++;
      curr.setDate(curr.getDate() + 1);
    }
    return days;
  };

  const addWorkingHours = (startDateStr: string, hours: number) => {
    let d = new Date(startDateStr);
    let remainingHours = hours;
    while (remainingHours >= 8) {
      d.setDate(d.getDate() + 1);
      if (d.getDay() !== 0 && d.getDay() !== 6) {
        remainingHours -= 8;
      }
    }
    d.setHours(d.getHours() + remainingHours);
    return d;
  };

  const formatJiraIsoDate = (d: Date, hour: number = 8, minute: number = 0) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hh = String(hour).padStart(2, "0");
    const mm = String(minute).padStart(2, "0");

    const offset = -d.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const offsetHours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
    const offsetMins = String(Math.abs(offset) % 60).padStart(2, "0");

    return `${year}-${month}-${day}T${hh}:${mm}:00.000${sign}${offsetHours}${offsetMins}`;
  };

  const handleExcelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const bstr = evt.target?.result;
      const wb = XLSX.read(bstr, { type: "binary", cellDates: true });
      const wsname = wb.SheetNames[0];
      const ws = wb.Sheets[wsname];
      const data = XLSX.utils.sheet_to_json(ws);
      setExcelData(data);
    };
    reader.readAsBinaryString(file);
  };

  const handleExcelSubmit = async () => {
    if (excelData.length === 0) return;
    setIsRunning(true);

    const BA_TEMPLATES = [
      "[BA] Nghiên cứu & phân tích nghiệp vụ",
      "[BA] Viết tài liệu nghiệp vụ",
      "[BA] Support nghiệp vụ cho dev test"
    ];

    const TESTER_TEMPLATES = [
      "[Tester] Nghiên cứu tài liệu nghiệp vụ",
      "[Tester] Viết checklist test/test case",
      "[Tester] Test chức năng"
    ];

    const parentTasks = excelData.filter(r => r["Issue Type"] === "Task" || r["Issue Type"] === "Story");
    const subTasksRaw = excelData.filter(r => r["Issue Type"] === "Sub-task");

    const newLogs: CreationLog[] = [];
    parentTasks.forEach(p => newLogs.push({ summary: p["Summary"], status: "pending" }));
    setLogs(newLogs);

    let logIndexOffset = 0;

    for (let i = 0; i < parentTasks.length; i++) {
      const row = parentTasks[i];
      const summary = row["Summary"];
      if (!summary) continue;

      const logIndex = i + logIndexOffset;
      setLogs(prev => prev.map((l, idx) => idx === logIndex ? { ...l, status: "processing" } : l));

      try {
        const issueType = row["Issue Type"] || "Task";
        const epicName = row["Epic Name"];
        const rowAssignee = row["Assignee"] || assignee;
        const startD = row["Custom field (Start Date (Time))"];
        const endD = row["Custom field (Due Date (Time))"];
        const origEstimate = row["Original Estimate"];

        const customFields: any = {};
        let formattedStartD = "";
        let formattedEndD = "";
        const parsedStart = parseExcelDate(startD);
        const parsedEnd = parseExcelDate(endD);

        if (parsedStart) {
          formattedStartD = formatJiraIsoDate(parsedStart);
          customFields["customfield_10300"] = formattedStartD;
        }
        if (parsedEnd) {
          formattedEndD = formatJiraIsoDate(parsedEnd, 17, 0);
          customFields["customfield_10302"] = formattedEndD;
        }

        const created: JiraIssue = await createIssue({
          projectKey: selectedProject,
          summary: summary,
          issueTypeName: issueType,
          assigneeName: rowAssignee || undefined,
          originalEstimate: origEstimate,
          customFields
        });

        if (autoLogWork && formattedStartD) {
          const startedStr = formattedStartD.replace(/\+.*$/, "+0000");
          let logComment = `Thực hiện công việc: ${summary}`;
          try {
            await addWorklog(created.key, {
              timeSpentSeconds: 7 * 3600, // default 7h for parent
              comment: logComment,
              started: startedStr,
              adjustEstimate: "auto",
            });
          } catch(e) {
            console.warn("Lỗi auto log work parent", e);
          }
        }

        setLogs(prev => prev.map((l, idx) => idx === logIndex ? { ...l, status: "success", key: created.key } : l));

        const parentKey = created.key;
        
        let subtasksToCreate = subTasksRaw.filter(s => epicName && s["Epic Name"] === epicName).map(s => ({ title: s["Summary"], est: s["Original Estimate"] || "0h" }));
        
        if (issueType === "Story") {
           const baTasks = BA_TEMPLATES.map(t => ({ title: t, est: "2h" }));
           const testerTasks = TESTER_TEMPLATES.map(t => ({ title: t, est: "2h" }));
           let devTasks: {title: string, est: string}[] = [];

           const geminiKey = localStorage.getItem("gemini_api_key");
           if (geminiKey) {
             const prompt = (parsedStart && parsedEnd) 
               ? `Bạn là một lập trình viên. Hãy phân tích Story có tiêu đề "${summary}" thành các sub-task nhỏ cho lập trình viên (Dev). Trả về danh sách thuần túy, mỗi dòng 1 task, không markdown.`
               : `Bạn là một lập trình viên. Hãy phân tích Story có tiêu đề "${summary}" thành các sub-task nhỏ cho lập trình viên Junior (Dev) kèm theo estimate bằng giờ (h). Trả về danh sách thuần túy, mỗi dòng định dạng: Tên sub-task | Xh (ví dụ: Viết API | 4h). Không markdown.`;
             
             try {
                 const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`, {
                   method: "POST",
                   headers: { "Content-Type": "application/json" },
                   body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
                 });
                 if (response.ok) {
                   const data = await response.json();
                   const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
                   if (text) {
                     const lines = text.split("\n").filter((l: string) => l.trim().length > 3);
                     if (parsedStart && parsedEnd) {
                       devTasks = lines.map((l: string) => ({ title: `[Dev] ${l.replace(/^[-*]\s*/, '').trim()}`, est: "2h" }));
                     } else {
                       devTasks = lines.map((l: string) => {
                         const parts = l.split("|");
                         if (parts.length >= 2) {
                           return { title: `[Dev] ${parts[0].replace(/^[-*]\s*/, '').trim()}`, est: parts[1].trim() };
                         }
                         return { title: `[Dev] ${l.replace(/^[-*]\s*/, '').trim()}`, est: "4h" };
                       });
                     }
                   }
                 }
             } catch (aiErr) {
                 console.warn("AI generation for dev tasks failed", aiErr);
             }
           }

          if (parsedStart && parsedEnd) {
            const workingDays = calculateWorkingDays(parsedStart, parsedEnd);
            const totalHours = workingDays * 8;
            if (totalHours > 0) {
               const baEst = Math.round(totalHours / baTasks.length) + "h";
               const testerEst = Math.round(totalHours / testerTasks.length) + "h";
               const devEst = devTasks.length > 0 ? Math.round(totalHours / devTasks.length) + "h" : "0h";
               
               baTasks.forEach(t => t.est = baEst);
               testerTasks.forEach(t => t.est = testerEst);
               devTasks.forEach(t => t.est = devEst);
            }
          }
          
          subtasksToCreate = [...subtasksToCreate, ...baTasks, ...testerTasks, ...devTasks];
        }

        if (subtasksToCreate.length > 0) {
          const subLogs = subtasksToCreate.map(t => ({ summary: `↳ ${t.title}`, status: "pending" as const }));
          setLogs(prev => {
             const copy = [...prev];
             copy.splice(logIndex + 1, 0, ...subLogs);
             return copy;
          });

          let currentSubIndex = logIndex + 1;
          for (const sub of subtasksToCreate) {
             setLogs(prev => prev.map((l, idx) => idx === currentSubIndex ? { ...l, status: "processing" } : l));
             
             let subCustomFields: any = {};
             if (formattedStartD) {
                 subCustomFields["customfield_10300"] = formattedStartD;
                 const estHours = parseInt(sub.est.replace("h", "")) || 0;
                 if (estHours > 0) {
                     const subEndD = addWorkingHours(formattedStartD, estHours);
                     subCustomFields["customfield_10302"] = formatJiraIsoDate(subEndD, 17, 0);
                 }
             }

             try {
                const sCreated = await createSubTask({
                  parentKey: parentKey,
                  projectKey: selectedProject,
                  summary: sub.title,
                  assigneeName: rowAssignee || undefined,
                  originalEstimate: sub.est,
                  customFields: Object.keys(subCustomFields).length > 0 ? subCustomFields : undefined
                });

                if (autoLogWork && formattedStartD) {
                  const startedStr = formattedStartD.replace(/\+.*$/, "+0000");
                  let logComment = `Thực hiện công việc: ${sub.title}`;
                  const estHours = parseInt(sub.est.replace("h", "")) || 0;
                  if (estHours > 0) {
                    try {
                      await addWorklog(sCreated.key, {
                        timeSpentSeconds: estHours * 3600, // log = estimate
                        comment: logComment,
                        started: startedStr,
                        adjustEstimate: "auto",
                      });
                    } catch(e) {
                      console.warn("Lỗi auto log work subtask", e);
                    }
                  }
                }

                setLogs(prev => prev.map((l, idx) => idx === currentSubIndex ? { ...l, status: "success", key: sCreated.key } : l));
             } catch (e: any) {
                setLogs(prev => prev.map((l, idx) => idx === currentSubIndex ? { ...l, status: "error", errorMsg: "Lỗi tạo sub-task" } : l));
             }
             currentSubIndex++;
          }
          logIndexOffset += subtasksToCreate.length;
        }

      } catch (err: any) {
        const msg = err.response?.data?.errorMessages?.[0] || err.message || "Lỗi tạo issue";
        setLogs(prev => prev.map((l, idx) => idx === logIndex ? { ...l, status: "error", errorMsg: msg } : l));
      }
    }
    
    setIsRunning(false);
  };

  const handleBulkCreateManual = async (e: React.FormEvent | null, tasksToCreate?: {summary: string, assignee: string}[]) => {
    if (e) e.preventDefault();
    
    const summaries = tasksToCreate 
      ? tasksToCreate.filter((s) => s.summary.trim().length > 0)
      : bulkText
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((s) => ({ summary: s, assignee: assignee.trim() }));

    if (summaries.length === 0) return;

    setIsRunning(true);
    const initialLogs = summaries.map((s) => ({
      summary: s.summary,
      status: "pending" as const,
    }));
    setLogs(initialLogs);

    let currentLogDate = getNextWorkday(new Date(startDate));

    for (let i = 0; i < summaries.length; i++) {
      if (i > 0) {
        currentLogDate = advanceDay(currentLogDate);
      }

      const logDateFormatted = currentLogDate.toLocaleDateString("vi-VN", {
        weekday: "short",
        year: "numeric",
        month: "numeric",
        day: "numeric",
      });

      setLogs((prev) =>
        prev.map((log, idx) =>
          idx === i 
            ? { 
                ...log, 
                status: "processing", 
                logDateText: autoLogWork 
                  ? `Lên lịch log: ${logDateFormatted}` 
                  : `Lên lịch gán ngày: ${logDateFormatted}` 
              } 
            : log
        )
      );

      try {
        const startDateStr = formatJiraIsoDate(currentLogDate, 8, 0);
        const endDateStr = formatJiraIsoDate(currentLogDate, 17, 0);

        const created: JiraIssue = await createIssue({
          projectKey: selectedProject,
          summary: summaries[i].summary,
          assigneeName: summaries[i].assignee || undefined,
          originalEstimate: estimate,
          customFields: {
            "customfield_10300": startDateStr,
            "customfield_10302": endDateStr,
          }
        });

        if (autoLogWork) {
          const startedStr = currentLogDate.toISOString().replace("Z", "+0000");
          let logComment = `Thực hiện công việc: ${summaries[i].summary}`;
          const geminiKey = localStorage.getItem("gemini_api_key");
          if (geminiKey) {
            try {
              const prompt = `Bạn là một kỹ sư phần mềm chuyên nghiệp. Hãy viết 1 câu ngắn gọn (dưới 15 từ) ghi chú lại công việc đã thực hiện cho task Jira có tiêu đề: "${summaries[i].summary}". Ví dụ: "Đã hoàn thành tối ưu hóa truy vấn SQL và sửa lỗi bộ lọc". Viết bằng tiếng Việt, trực tiếp, bắt đầu bằng từ hành động như "Hoàn thành...", "Cải tiến...", "Tối ưu...", "Sửa lỗi...", không dài dòng, không có phần giới thiệu, không thêm bất kỳ định dạng markdown hay dấu ngoặc kép nào xung quanh.`;
              const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
              });
              if (response.ok) {
                const data = await response.json();
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                if (text) {
                  logComment = text;
                }
              }
            } catch (e) {
              console.warn("AI generation failed for worklog comment", e);
            }
          }

          await addWorklog(created.key, {
            timeSpentSeconds: 7 * 3600,
            comment: logComment,
            started: startedStr,
            adjustEstimate: "auto",
          });
        }

        setLogs((prev) =>
          prev.map((log, idx) =>
            idx === i ? { ...log, status: "success", key: created.key } : log
          )
        );
      } catch (err: unknown) {
        const e = err as { response?: { data?: { errorMessages?: string[] } }; message?: string };
        const msg = e.response?.data?.errorMessages?.[0] || e.message || "Lỗi tạo issue";
        setLogs((prev) =>
          prev.map((log, idx) =>
            idx === i ? { ...log, status: "error", errorMsg: msg } : log
          )
        );
      }
    }
    setIsRunning(false);
    if (!tasksToCreate) {
      setBulkText("");
    } else {
      setAnalyzedTasks([]);
      setAiContext("");
    }
  };

  const handleAnalyzeContext = async () => {
    if (!aiContext.trim()) return;

    const geminiKey = localStorage.getItem("gemini_api_key");
    if (!geminiKey) {
      alert("Vui lòng cấu hình Google Gemini API Key trong phần Cài đặt trước.");
      return;
    }

    setIsAnalyzing(true);
    try {
      const roleStr = selectedRoles.length > 0 ? `CHÚ Ý: Chỉ trích xuất các task thuộc về các vai trò (role) sau: ${selectedRoles.join(', ')}.\n` : "";
      const prompt = `Bạn là một trợ lý ảo phân tích công việc. Tôi sẽ cung cấp một đoạn văn bản mô tả các công việc đã làm. Hãy phân tích và trích xuất ra một danh sách các đầu việc nhỏ (task).
${roleStr}Mỗi đầu việc phải ngắn gọn, súc tích, bắt đầu bằng động từ hành động (ví dụ: Viết API..., Thiết kế..., Sửa lỗi...).
Trả về kết quả DƯỚI DẠNG VĂN BẢN THUẦN TÚY, mỗi task trên 1 dòng, không có dấu gạch đầu dòng, không đánh số thứ tự, không có tiêu đề, không markdown.
Đoạn văn bản: "${aiContext}"`;

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });

      if (!response.ok) {
        throw new Error("Lỗi kết nối API AI");
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
      
      if (text) {
        const tasks = text.split("\n").map(t => t.replace(/^[-*]\s*/, '').trim()).filter(t => t.length > 0);
        setAnalyzedTasks(tasks.map(t => ({ summary: t, assignee: assignee.trim() })));
        
        const latestDate = await getLatestTaskDate([selectedProject], assignee.trim() || undefined);
        if (latestDate) {
          const nextDay = advanceDay(latestDate);
          setStartDate(nextDay.toISOString().slice(0, 10));
        }
      } else {
        alert("Không nhận được kết quả hợp lệ từ AI.");
      }
    } catch (e: any) {
      alert("Lỗi khi phân tích AI: " + e.message);
    } finally {
      setIsAnalyzing(false);
    }
  };

  if (!isConfigured) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div className="page-header">
          <div className="page-title-group">
            <h1 className="page-title">Tạo Issue Nhanh</h1>
          </div>
        </div>
        <div className="page-body" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="empty-state">
            <div className="empty-state-icon">🔌</div>
            <div className="empty-state-title">Chưa kết nối Jira</div>
            <p className="empty-state-text">Vào Cài đặt để kết nối với server Jira trước.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div className="page-header">
        <div className="page-title-group">
          <h1 className="page-title">Tạo Issue Nhanh</h1>
          <p className="page-subtitle">Tự động tạo nhiều issues với nhiều chế độ khác nhau</p>
        </div>
      </div>

      <div className="page-body">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, alignItems: "start" }}>
          {/* Cột 1: Nhập liệu */}
          <div className="settings-section">
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <button
                className={`btn btn-sm ${creationMode === "manual" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setCreationMode("manual")}
              >
                📝 Nhập thủ công
              </button>
              <button
                className={`btn btn-sm ${creationMode === "ai" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setCreationMode("ai")}
              >
                ✨ Tạo bằng AI Context
              </button>
              <button
                className={`btn btn-sm ${creationMode === "excel" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setCreationMode("excel")}
              >
                📁 Import Excel
              </button>
            </div>

            {creationMode === "ai" ? (
              <div>
                <div className="settings-section-title">✨ Phân tích công việc bằng AI</div>
                <div className="settings-section-desc">Nhập mô tả các công việc bạn đã làm, AI sẽ tự động chia nhỏ thành các task và tự động tính toán ngày bắt đầu.</div>
                
                <div className="form-group" style={{ marginTop: 16 }}>
                  <label>Dự án (Project)</label>
                  <select
                    value={selectedProject}
                    onChange={(e) => setSelectedProject(e.target.value)}
                    disabled={isAnalyzing}
                  >
                    {JIRA_PROJECTS.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.name} ({p.key})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label>Tài khoản Assignee Mặc định</label>
                  <select
                    value={assignee}
                    onChange={(e) => setAssignee(e.target.value)}
                    disabled={isAnalyzing || loadingUsers}
                  >
                    <option value="">{loadingUsers ? "Đang tải danh sách..." : "-- Tự động assign cho bạn --"}</option>
                    {assignableUsers.map(u => (
                      <option key={u.accountId || u.name} value={u.name || u.accountId}>
                        {u.displayName} {u.name ? `(${u.name})` : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label>Phân tích theo Role (Tùy chọn)</label>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 4 }}>
                    {ROLES.map((r) => (
                      <label key={r} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", fontWeight: "normal" }}>
                        <input
                          type="checkbox"
                          checked={selectedRoles.includes(r)}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedRoles([...selectedRoles, r]);
                            else setSelectedRoles(selectedRoles.filter(role => role !== r));
                          }}
                          disabled={isAnalyzing}
                          style={{ margin: 0 }}
                        />
                        {r}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="form-group">
                  <label>Nội dung mô tả công việc (Context)</label>
                  <textarea
                    placeholder="Ví dụ: Tuần này tôi đã code xong API đăng nhập..."
                    value={aiContext}
                    onChange={(e) => setAiContext(e.target.value)}
                    disabled={isAnalyzing}
                    rows={8}
                    style={{ fontFamily: "inherit", lineHeight: "1.5" }}
                  />
                </div>

                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleAnalyzeContext}
                  disabled={isAnalyzing || !aiContext.trim()}
                  style={{ width: "100%", padding: "12px", marginTop: 8 }}
                >
                  {isAnalyzing ? (
                    <><span className="spinning">⏳</span> Đang phân tích...</>
                  ) : (
                    <>✨ Phân tích {analyzedTasks.length > 0 ? "lại" : "công việc"}</>
                  )}
                </button>

                {analyzedTasks.length > 0 && (
                  <div style={{ marginTop: 24, paddingTop: 24, borderTop: "1px solid var(--border)" }}>
                    <div className="settings-section-title" style={{ marginBottom: 12 }}>📝 Danh sách Task</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
                      {analyzedTasks.map((task, idx) => (
                        <div key={idx} style={{ display: "flex", gap: 8 }}>
                          <input
                            type="text"
                            value={task.summary}
                            onChange={(e) => {
                              const newTasks = [...analyzedTasks];
                              newTasks[idx].summary = e.target.value;
                              setAnalyzedTasks(newTasks);
                            }}
                            style={{ flex: 1 }}
                            disabled={isRunning}
                          />
                          <select
                            value={task.assignee}
                            onChange={(e) => {
                              const newTasks = [...analyzedTasks];
                              newTasks[idx].assignee = e.target.value;
                              setAnalyzedTasks(newTasks);
                            }}
                            style={{ width: "160px" }}
                            disabled={isRunning || loadingUsers}
                          >
                            <option value="">-- Assign cho bạn --</option>
                            {assignableUsers.map(u => (
                              <option key={u.accountId || u.name} value={u.name || u.accountId}>
                                {u.displayName}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => {
                              const newTasks = analyzedTasks.filter((_, i) => i !== idx);
                              setAnalyzedTasks(newTasks);
                            }}
                            disabled={isRunning}
                            style={{ padding: "0 12px" }}
                          >
                            🗑️
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setAnalyzedTasks([...analyzedTasks, { summary: "", assignee: assignee.trim() }])}
                        disabled={isRunning}
                        style={{ alignSelf: "flex-start", marginTop: 4 }}
                      >
                        ➕ Thêm Task
                      </button>
                    </div>

                    <div className="form-group" style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0" }}>
                      <input
                        id="checkbox-autolog-ai"
                        type="checkbox"
                        checked={autoLogWork}
                        onChange={(e) => setAutoLogWork(e.target.checked)}
                        disabled={isRunning}
                        style={{ width: "auto", margin: 0, cursor: "pointer" }}
                      />
                      <label htmlFor="checkbox-autolog-ai" style={{ cursor: "pointer", fontWeight: "normal", fontSize: 13, userSelect: "none" }}>
                        Tự động log work 7h cho mỗi issue sau khi tạo?
                      </label>
                    </div>

                    <div className="form-group">
                      <label htmlFor="input-start-date-log-ai">
                        {autoLogWork ? "Ngày bắt đầu log work *" : "Ngày bắt đầu của Task *"}
                      </label>
                      <input
                        id="input-start-date-log-ai"
                        type="date"
                        value={startDate}
                        onChange={(e) => setStartDate(e.target.value)}
                        disabled={isRunning}
                        required
                      />
                    </div>

                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => handleBulkCreateManual(null, analyzedTasks)}
                      disabled={isRunning || analyzedTasks.filter(t => t.summary.trim()).length === 0}
                      style={{ width: "100%", padding: "12px", marginTop: 8 }}
                    >
                      {isRunning ? (
                        <><span className="spinning">🌀</span> Đang xử lý tự động...</>
                      ) : (
                        <>🚀 Bắt đầu Tạo Issues</>
                      )}
                    </button>
                  </div>
                )}
              </div>
            ) : creationMode === "excel" ? (
              <div>
                 <div className="settings-section-title">📁 Import từ file Excel</div>
                 <div className="settings-section-desc">Upload file Excel để tự động tạo Task, Story và Sub-tasks cùng lúc.</div>
                 
                 <div className="form-group" style={{ marginTop: 16 }}>
                  <label>Dự án (Project)</label>
                  <select
                    value={selectedProject}
                    onChange={(e) => setSelectedProject(e.target.value)}
                    disabled={isRunning}
                  >
                    {JIRA_PROJECTS.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.name} ({p.key})
                      </option>
                    ))}
                  </select>
                </div>

                 <div className="form-group" style={{ marginTop: 16 }}>
                    <label>File Excel (.xlsx)</label>
                    <input type="file" accept=".xlsx, .xls" onChange={handleExcelUpload} disabled={isRunning} style={{ padding: "8px 0" }} />
                 </div>

                 {excelData.length > 0 && (
                   <div style={{ marginTop: 16 }}>
                     <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 8 }}>
                       Đã đọc <strong>{excelData.length}</strong> dòng từ file.
                     </div>
                     <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
                       <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                         <thead style={{ background: "rgba(255,255,255,0.05)", position: "sticky", top: 0 }}>
                           <tr>
                             <th style={{ padding: 8, textAlign: "left", borderBottom: "1px solid var(--border)" }}>Type</th>
                             <th style={{ padding: 8, textAlign: "left", borderBottom: "1px solid var(--border)" }}>Summary</th>
                             <th style={{ padding: 8, textAlign: "left", borderBottom: "1px solid var(--border)" }}>Epic</th>
                           </tr>
                         </thead>
                         <tbody>
                           {excelData.map((r, i) => (
                             <tr key={i}>
                               <td style={{ padding: 8, borderBottom: "1px solid var(--border)" }}>{r["Issue Type"]}</td>
                               <td style={{ padding: 8, borderBottom: "1px solid var(--border)", whiteSpace: "nowrap", textOverflow: "ellipsis", maxWidth: 150, overflow: "hidden" }}>{r["Summary"]}</td>
                               <td style={{ padding: 8, borderBottom: "1px solid var(--border)" }}>{r["Epic Name"]}</td>
                             </tr>
                           ))}
                         </tbody>
                       </table>
                     </div>

                     <div className="form-group" style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0" }}>
                       <input
                         id="checkbox-autolog-excel"
                         type="checkbox"
                         checked={autoLogWork}
                         onChange={(e) => setAutoLogWork(e.target.checked)}
                         disabled={isRunning}
                         style={{ width: "auto", margin: 0, cursor: "pointer" }}
                       />
                       <label htmlFor="checkbox-autolog-excel" style={{ cursor: "pointer", fontWeight: "normal", fontSize: 13, userSelect: "none" }}>
                         Tự động log work cho các issue/sub-task sau khi tạo?
                       </label>
                     </div>

                     <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleExcelSubmit}
                      disabled={isRunning}
                      style={{ width: "100%", padding: "12px", marginTop: 8 }}
                    >
                      {isRunning ? (
                        <><span className="spinning">🌀</span> Đang xử lý tự động...</>
                      ) : (
                        <>🚀 Bắt đầu Tạo Issues từ Excel</>
                      )}
                    </button>
                   </div>
                 )}
              </div>
            ) : (
              <>
                <div className="settings-section-title">➕ Tạo hàng loạt Issue</div>
                <div className="settings-section-desc">Mỗi dòng văn bản bên dưới sẽ được tạo thành một Issue riêng biệt.</div>

                <form onSubmit={handleBulkCreateManual}>
                  <div className="form-group">
                    <label>Dự án (Project)</label>
                    <select
                      value={selectedProject}
                      onChange={(e) => setSelectedProject(e.target.value)}
                      disabled={isRunning}
                    >
                      {JIRA_PROJECTS.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.name} ({p.key})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-group">
                    <label>Danh sách tóm tắt Issue (Mỗi dòng là 1 Issue) *</label>
                    <textarea
                      placeholder="Ví dụ:&#10;Thiết kế giao diện trang chủ&#10;Viết API đồng bộ hóa dữ liệu"
                      value={bulkText}
                      onChange={(e) => setBulkText(e.target.value)}
                      disabled={isRunning}
                      rows={8}
                      style={{ fontFamily: "inherit", lineHeight: "1.5" }}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label>Tài khoản Assignee</label>
                    <select
                      value={assignee}
                      onChange={(e) => setAssignee(e.target.value)}
                      disabled={isRunning || loadingUsers}
                    >
                      <option value="">{loadingUsers ? "Đang tải danh sách..." : "-- Tự động assign cho bạn --"}</option>
                      {assignableUsers.map(u => (
                        <option key={u.accountId || u.name} value={u.name || u.accountId}>
                          {u.displayName} {u.name ? `(${u.name})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-group" style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0" }}>
                    <input
                      id="checkbox-autolog"
                      type="checkbox"
                      checked={autoLogWork}
                      onChange={(e) => setAutoLogWork(e.target.checked)}
                      disabled={isRunning}
                      style={{ width: "auto", margin: 0, cursor: "pointer" }}
                    />
                    <label htmlFor="checkbox-autolog" style={{ cursor: "pointer", fontWeight: "normal", fontSize: 13, userSelect: "none" }}>
                      Tự động log work 7h cho mỗi issue sau khi tạo?
                    </label>
                  </div>

                  <div className="form-group">
                    <label htmlFor="input-start-date-log">
                      {autoLogWork ? "Ngày bắt đầu log work *" : "Ngày bắt đầu của Task *"}
                    </label>
                    <input
                      id="input-start-date-log"
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      disabled={isRunning}
                      required
                    />
                  </div>

                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={isRunning || !bulkText.trim()}
                    style={{ width: "100%", padding: "12px", marginTop: 8 }}
                  >
                    {isRunning ? (
                      <><span className="spinning">🌀</span> Đang xử lý tự động...</>
                    ) : (
                      <>🚀 Bắt đầu Tạo Issues</>
                    )}
                  </button>
                </form>
              </>
            )}
          </div>

          {/* Cột 2: Trạng thái & Tiến độ */}
          <div className="settings-section" style={{ minHeight: 460, display: "flex", flexDirection: "column" }}>
            <div className="settings-section-title">📊 Tiến trình thực hiện</div>
            <div className="settings-section-desc">Theo dõi trạng thái tạo tự động thời gian thực.</div>

            <div
              style={{
                flex: 1,
                background: "rgba(0,0,0,0.15)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: 16,
                marginTop: 16,
                maxHeight: 440,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {logs.length === 0 ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", opacity: 0.5, padding: "40px 0" }}>
                  <span style={{ fontSize: 32, marginBottom: 8 }}>📋</span>
                  <span style={{ fontSize: 13 }}>Danh sách trống.</span>
                </div>
              ) : (
                logs.map((log, idx) => (
                  <div
                    key={idx}
                    style={{
                      background: "var(--bg-card)",
                      borderRadius: 8,
                      padding: "10px 14px",
                      border: "1px solid var(--border)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      fontSize: 13,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          color: "var(--text-primary)",
                          fontWeight: 500,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {log.summary}
                      </div>
                      {log.logDateText && (
                        <div style={{ color: "var(--accent-blue-light)", fontSize: 11, marginTop: 2, fontWeight: 500 }}>
                          📅 {log.logDateText}
                        </div>
                      )}
                      {log.errorMsg && (
                        <div style={{ color: "var(--accent-red)", fontSize: 11, marginTop: 2 }}>
                          ⚠️ {log.errorMsg}
                        </div>
                      )}
                    </div>

                    <div style={{ flexShrink: 0 }}>
                      {log.status === "pending" && (
                        <span style={{ color: "var(--text-muted)" }}>⏳ Đang chờ</span>
                      )}
                      {log.status === "processing" && (
                        <span style={{ color: "var(--accent-blue)", fontWeight: 600 }} className="spinning-slow">
                          🌀 Đang tạo...
                        </span>
                      )}
                      {log.status === "success" && (
                        <a
                          href={`https://20.84.97.109:3033/browse/${log.key}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            color: "var(--accent-green)",
                            fontWeight: 700,
                            textDecoration: "none",
                            background: "rgba(16, 185, 129, 0.1)",
                            padding: "4px 8px",
                            borderRadius: 6,
                          }}
                        >
                          ✅ {log.key} ↗
                        </a>
                      )}
                      {log.status === "error" && (
                        <span style={{ color: "var(--accent-red)", fontWeight: 600 }}>❌ Thất bại</span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
