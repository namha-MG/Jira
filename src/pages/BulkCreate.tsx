import React, { useState, useEffect, useSyncExternalStore } from "react";
import * as XLSX from "xlsx";
import { createIssue, createSubTask, JiraIssue, JiraUser, getLatestTaskDate, getAssignableUsers, getAllIssuesByJql, getBoards, getSprints, moveIssuesToSprint, JiraSprint } from "../jiraService";
import UserSelect from "../components/UserSelect";
import { getDefaultProjectKey, getSelectedJiraProjects } from "../config";
import { copyToClipboard } from "../utils";
import { bulkCreateStore, CreationLog } from "../stores/bulkCreateStore";
import { addAutoResolveIssueKeys, AutoResolveScheduleInput } from "../stores/autoResolveStore";
import { silentAutoProcessTasks } from "../autoProcessor";

export interface ManualTaskRow {
  id: string;
  summary: string;
  startDate: string;
  endDate: string;
  estimate: string;
  autoLogWork: boolean;
}

type ImportAssigneeRole = "" | "BA" | "Tester" | "DEV";

const getTaskRole = (summary: string): Exclude<ImportAssigneeRole, ""> | null => {
  const normalized = summary.trim().toLowerCase();
  if (normalized.startsWith("[ba]")) return "BA";
  if (normalized.startsWith("[tester]")) return "Tester";
  if (normalized.startsWith("[dev]")) return "DEV";
  return null;
};

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
  const jiraProjects = getSelectedJiraProjects();
  const projectOptionsKey = jiraProjects.map((project) => project.key).join("|");
  const [selectedProject, setSelectedProject] = useState(() => getDefaultProjectKey());
  const [bulkText, setBulkText] = useState("");
  const [assignee, setAssignee] = useState("");
  const [estimate] = useState("7h"); // Cố định 7h theo yêu cầu thủ công
  const [autoLogWork, setAutoLogWork] = useState(true);
  const [startDate, setStartDate] = useState(() => {
    const now = new Date();
    return now.toISOString().slice(0, 10);
  });
  
  const logs = useSyncExternalStore(bulkCreateStore.subscribe, bulkCreateStore.getLogs);
  const isRunning = useSyncExternalStore(bulkCreateStore.subscribe, bulkCreateStore.getIsRunning);
  const setLogs = bulkCreateStore.setLogs;
  const setIsRunning = bulkCreateStore.setIsRunning;

  const [useGeneralConfig, setUseGeneralConfig] = useState(false);
  const [manualRows, setManualRows] = useState<ManualTaskRow[]>(() => {
    const today = new Date().toISOString().slice(0, 10);
    return [{ id: Date.now().toString(), summary: "", startDate: today, endDate: today, estimate: "7h", autoLogWork: true }];
  });

  const [availableSprints, setAvailableSprints] = useState<JiraSprint[]>([]);
  const [selectedSprint, setSelectedSprint] = useState<string>("");

  useEffect(() => {
    localStorage.setItem("default_project", selectedProject);
    const fetchSprints = async () => {
      try {
        const boards = await getBoards(selectedProject);
        let allSprints: JiraSprint[] = [];
        for (const b of boards) {
          try {
            const sps = await getSprints(b.id, "active,future");
            const mappedSps = sps.map(s => ({ ...s, name: `${s.name} (${b.name})` }));
            allSprints = [...allSprints, ...mappedSps];
          } catch (e) {}
        }
        const uniqueSprints = Array.from(new Map(allSprints.map(s => [s.id, s])).values());
        setAvailableSprints(uniqueSprints);
      } catch (err) {
        console.warn("Lỗi tải Sprints", err);
      }
    };
    fetchSprints();
  }, [selectedProject]);

  const [creationMode, setCreationMode] = useState<"manual" | "ai" | "excel">("manual");
  const [aiContext, setAiContext] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzedTasks, setAnalyzedTasks] = useState<{summary: string, assignee: string}[]>([]);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const ROLES = ["Frontend", "Backend", "Mobile", "Tester", "BA", "QA", "DevOps", "Scrum Master"];
  
  const [assignableUsers, setAssignableUsers] = useState<JiraUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  
  const [manualMode, setManualMode] = useState<"independent" | "subtask">("independent");
  const [parentTaskKey, setParentTaskKey] = useState("");
  const [recentTasks, setRecentTasks] = useState<JiraIssue[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);

  const [excelData, setExcelData] = useState<any[]>([]);
  const [importAssigneeRole, setImportAssigneeRole] = useState<ImportAssigneeRole>("");

  const isConfigured = !!localStorage.getItem("jira_pat") || !!localStorage.getItem("jira_basic");

  useEffect(() => {
    if (!jiraProjects.some((project) => project.key === selectedProject)) {
      setSelectedProject(jiraProjects[0]?.key || "");
    }
  }, [projectOptionsKey, selectedProject]);

  useEffect(() => {
    if (isConfigured && selectedProject) {
      setLoadingUsers(true);
      getAssignableUsers(selectedProject)
        .then(users => setAssignableUsers(users))
        .catch(e => console.error("Failed to load assignable users", e))
        .finally(() => setLoadingUsers(false));
    }
  }, [isConfigured, selectedProject]);

  useEffect(() => {
    if (isConfigured && selectedProject && creationMode === "manual" && manualMode === "subtask") {
      setLoadingTasks(true);
      getAllIssuesByJql(`project = "${selectedProject}" AND issuetype in (Task, Story, Bug) ORDER BY updated DESC`, 100)
        .then(res => setRecentTasks(res))
        .catch(e => console.error("Failed to load recent tasks", e))
        .finally(() => setLoadingTasks(false));
    }
  }, [isConfigured, selectedProject, creationMode, manualMode]);

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

  const scheduleAutoResolveIssue = (item: Omit<Extract<AutoResolveScheduleInput, object>, "projectKey" | "autoLogWork" | "status" | "lastMessage" | "source">) => {
    addAutoResolveIssueKeys([{
      ...item,
      projectKey: selectedProject,
      autoLogWork: true,
      status: "pending",
      lastMessage: "Đang chờ tới End Date.",
      source: "bulk-create",
    }]);
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
    let createdKeys: string[] = [];

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
        const startD = row["Custom field (Start Date (Time))"];
        const endD = row["Custom field (Due Date (Time))"];
        const origEstimate = row["Original Estimate"];
        const parentRole = getTaskRole(summary);
        const parentAssignee = parentRole === null || parentRole === importAssigneeRole
          ? String(row["Assignee"] || "")
          : "";

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
          assigneeName: parentAssignee,
          originalEstimate: origEstimate,
          customFields
        });

        if (autoLogWork && formattedEndD) {
          scheduleAutoResolveIssue({
            key: created.key,
            summary,
            issueType,
            assigneeName: parentAssignee,
            estimate: origEstimate,
            startDate: formattedStartD,
            endDate: formattedEndD,
          });
        }

        setLogs(prev => prev.map((l, idx) => idx === logIndex ? { ...l, status: "success", key: created.key } : l));
        createdKeys.push(created.key);

        const parentKey = created.key;
        
        let subtasksToCreate = subTasksRaw.filter(s => epicName && s["Epic Name"] === epicName).map(s => ({ title: s["Summary"], est: s["Original Estimate"] || "0h" }));
        
        if (issueType === "Story") {
           const baTasks = BA_TEMPLATES.map(t => ({ title: t, est: "2h" }));
           const testerTasks = TESTER_TEMPLATES.map(t => ({ title: t, est: "2h" }));
           let devTasks: {title: string, est: string}[] = [];

           const geminiKey = localStorage.getItem("gemini_api_key");
           if (geminiKey) {
             const prompt = (parsedStart && parsedEnd) 
               ? `Bạn là một lập trình viên. Hãy phân tích Story có tiêu đề "${summary}" thành tối đa 3 sub-task quan trọng nhất cho lập trình viên (Dev). Gộp các đầu việc nhỏ có liên quan, không tách quá chi tiết. Trả về danh sách thuần túy, mỗi dòng 1 task, không markdown.`
               : `Bạn là một lập trình viên. Hãy phân tích Story có tiêu đề "${summary}" thành tối đa 3 sub-task quan trọng nhất cho lập trình viên Junior (Dev) kèm theo estimate bằng giờ (h). Gộp các đầu việc nhỏ có liên quan, không tách quá chi tiết. Trả về danh sách thuần túy, mỗi dòng định dạng: Tên sub-task | Xh (ví dụ: Viết API | 4h). Không markdown.`;
             
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
                     // The prompt guides the model, while slice enforces the limit if it returns extra lines.
                     const lines = text.split("\n").filter((l: string) => l.trim().length > 3).slice(0, 3);
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

          for (let sIdx = 0; sIdx < subtasksToCreate.length; sIdx++) {
             const sub = subtasksToCreate[sIdx];
             const targetIndex = logIndex + 1 + sIdx;
             const subRole = getTaskRole(sub.title);
             const roleCanBeAssigned = subRole !== null && subRole === importAssigneeRole;
             const subAssignee = roleCanBeAssigned && row["Assignee"] !== undefined
               ? String(row["Assignee"] || "")
               : "";
             
             setLogs(prev => prev.map((l, idx) => idx === targetIndex ? { ...l, status: "processing" } : l));
             
             let subCustomFields: any = {};
             let subEndDateForAutoResolve = "";
             if (formattedStartD) {
                 subCustomFields["customfield_10300"] = formattedStartD;
                 const estHours = parseInt(sub.est.replace("h", "")) || 0;
                 if (estHours > 0) {
                     const subEndD = addWorkingHours(formattedStartD, estHours);
                     subEndDateForAutoResolve = formatJiraIsoDate(subEndD, 17, 0);
                     subCustomFields["customfield_10302"] = subEndDateForAutoResolve;
                 }
             }

             try {
                const sCreated = await createSubTask({
                  parentKey: parentKey,
                  projectKey: selectedProject,
                  summary: sub.title,
                  assigneeName: subAssignee,
                  originalEstimate: sub.est,
                  customFields: Object.keys(subCustomFields).length > 0 ? subCustomFields : undefined
                });

                if (autoLogWork && subEndDateForAutoResolve) {
                  scheduleAutoResolveIssue({
                    key: sCreated.key,
                    summary: sub.title,
                    issueType: "Sub-task",
                    assigneeName: subAssignee,
                    estimate: sub.est,
                    startDate: formattedStartD,
                    endDate: subEndDateForAutoResolve,
                  });
                }

                setLogs(prev => prev.map((l, idx) => idx === targetIndex ? { ...l, status: "success", key: sCreated.key } : l));
                createdKeys.push(sCreated.key);
             } catch (e: any) {
                setLogs(prev => prev.map((l, idx) => idx === targetIndex ? { ...l, status: "error", errorMsg: "Lỗi tạo sub-task" } : l));
             }
          }
          logIndexOffset += subtasksToCreate.length;
        }

      } catch (err: any) {
        const msg = err.response?.data?.errorMessages?.[0] || err.message || "Lỗi tạo issue";
        setLogs(prev => prev.map((l, idx) => idx === logIndex ? { ...l, status: "error", errorMsg: msg } : l));
      }
    }
    
    if (selectedSprint && createdKeys.length > 0) {
      try {
        await moveIssuesToSprint(Number(selectedSprint), createdKeys);
      } catch (err) {
        console.warn("Lỗi gán sprint", err);
      }
    }

    if (autoLogWork && createdKeys.length > 0) {
      void silentAutoProcessTasks().catch(err => console.warn("Auto resolve after Excel create failed", err));
    }

    setIsRunning(false);
  };

  const handleBulkCreateManual = async (e: React.FormEvent | null, tasksToCreate?: {summary: string, assignee: string}[]) => {
    if (e) e.preventDefault();
    
    let summaries: any[] = [];
    if (tasksToCreate) {
      summaries = tasksToCreate.filter(s => s.summary.trim().length > 0).map(s => ({ ...s, isManualRow: false }));
    } else if (useGeneralConfig) {
      summaries = bulkText.split("\n").map(s => s.trim()).filter(s => s.length > 0).map(s => ({ summary: s, assignee: assignee.trim(), isManualRow: false }));
    } else {
      summaries = manualRows.filter(r => r.summary.trim().length > 0).map(r => ({ ...r, assignee: assignee.trim(), isManualRow: true }));
    }

    if (summaries.length === 0) return;

    setIsRunning(true);
    let createdKeys: string[] = [];

    const initialLogs = summaries.map((s) => ({
      summary: s.summary,
      status: "pending" as const,
    }));
    setLogs(initialLogs);

    let currentLogDate = getNextWorkday(new Date(startDate));

    for (let i = 0; i < summaries.length; i++) {
      let taskStartDateStr: string | undefined = undefined;
      let taskEndDateStr: string | undefined = undefined;
      let taskEstimate: string | undefined = estimate;
      let taskAutoLogWork = autoLogWork;
      let taskLogDate = currentLogDate;

      if (summaries[i].isManualRow) {
        const row = summaries[i];
        if (row.startDate) {
          taskLogDate = new Date(row.startDate);
          taskStartDateStr = formatJiraIsoDate(taskLogDate, 8, 0);
        } else {
          taskLogDate = new Date(); // Fallback for logDateFormatted
        }

        if (row.endDate) {
          const rowEndDate = new Date(row.endDate);
          taskEndDateStr = formatJiraIsoDate(rowEndDate, 17, 0);
        }

        taskEstimate = row.estimate || undefined;
        taskAutoLogWork = row.autoLogWork;
      } else {
        if (i > 0) {
          currentLogDate = advanceDay(currentLogDate);
          taskLogDate = currentLogDate;
        }
        taskStartDateStr = formatJiraIsoDate(taskLogDate, 8, 0);
        taskEndDateStr = formatJiraIsoDate(taskLogDate, 17, 0);
      }

      const logDateFormatted = taskLogDate.toLocaleDateString("vi-VN", {
        weekday: "short",
        year: "numeric",
        month: "numeric",
        day: "numeric",
      });
      const autoResolveDate = taskEndDateStr ? new Date(taskEndDateStr) : taskLogDate;
      const autoResolveDateFormatted = autoResolveDate.toLocaleDateString("vi-VN", {
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
                logDateText: taskAutoLogWork 
                  ? `Lên lịch auto log & Resolve: ${autoResolveDateFormatted}`
                  : `Lên lịch gán ngày: ${logDateFormatted}` 
              } 
            : log
        )
      );

      try {
        let customFieldsObj: any = {};
        if (taskStartDateStr) customFieldsObj["customfield_10300"] = taskStartDateStr;
        if (taskEndDateStr) customFieldsObj["customfield_10302"] = taskEndDateStr;

        let createdKey = "";
        if (manualMode === "subtask") {
          const sCreated = await createSubTask({
            parentKey: parentTaskKey,
            projectKey: selectedProject,
            summary: summaries[i].summary,
            assigneeName: summaries[i].assignee ? summaries[i].assignee : undefined,
            originalEstimate: taskEstimate,
            customFields: Object.keys(customFieldsObj).length > 0 ? customFieldsObj : undefined
          });
          createdKey = sCreated.key;
        } else {
          const created: JiraIssue = await createIssue({
            projectKey: selectedProject,
            summary: summaries[i].summary,
            assigneeName: summaries[i].assignee ? summaries[i].assignee : undefined,
            originalEstimate: taskEstimate,
            customFields: Object.keys(customFieldsObj).length > 0 ? customFieldsObj : undefined
          });
          createdKey = created.key;
        }

        if (taskAutoLogWork && taskEndDateStr) {
          scheduleAutoResolveIssue({
            key: createdKey,
            summary: summaries[i].summary,
            issueType: manualMode === "subtask" ? "Sub-task" : "Task",
            assigneeName: summaries[i].assignee || "",
            estimate: taskEstimate,
            startDate: taskStartDateStr,
            endDate: taskEndDateStr,
          });
        }

        setLogs((prev) =>
          prev.map((log, idx) =>
            idx === i ? { ...log, status: "success", key: createdKey } : log
          )
        );
        createdKeys.push(createdKey);
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

    if (selectedSprint && createdKeys.length > 0) {
      try {
        await moveIssuesToSprint(Number(selectedSprint), createdKeys);
      } catch (err) {
        console.warn("Lỗi gán sprint", err);
      }
    }

    if (createdKeys.length > 0) {
      void silentAutoProcessTasks().catch(err => console.warn("Auto resolve after bulk create failed", err));
    }

    setIsRunning(false);
    if (!tasksToCreate) {
      if (useGeneralConfig) {
        setBulkText("");
      } else {
        const today = new Date().toISOString().slice(0, 10);
        setManualRows([{ id: Date.now().toString(), summary: "", startDate: today, endDate: today, estimate: "7h", autoLogWork: true }]);
      }
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
        <div className="bulk-create-layout">
          {/* Cột 1: Nhập liệu */}
          <div className="settings-section">
            <div className="bulk-mode-tabs">
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
                    {jiraProjects.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.name} ({p.key})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label>Chọn Sprint</label>
                  <select
                    value={selectedSprint}
                    onChange={(e) => setSelectedSprint(e.target.value)}
                    disabled={isAnalyzing}
                  >
                    <option value="">-- Backlog (Không thêm vào Sprint) --</option>
                    {availableSprints.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label>Tài khoản Assignee Mặc định</label>
                  <UserSelect
                    users={assignableUsers}
                    value={assignee}
                    onChange={setAssignee}
                    loading={loadingUsers}
                    disabled={isAnalyzing}
                    placeholder="-- Tự động assign cho bạn --"
                  />
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
                    <div className="bulk-ai-task-list">
                      {analyzedTasks.map((task, idx) => (
                        <div key={idx} className="bulk-ai-task-row">
                          <input
                            type="text"
                            value={task.summary}
                            onChange={(e) => {
                              const newTasks = [...analyzedTasks];
                              newTasks[idx].summary = e.target.value;
                              setAnalyzedTasks(newTasks);
                            }}
                            disabled={isRunning}
                          />
                          <div>
                            <UserSelect
                              users={assignableUsers}
                              value={task.assignee}
                              onChange={(val) => {
                                const newTasks = [...analyzedTasks];
                                newTasks[idx].assignee = val;
                                setAnalyzedTasks(newTasks);
                              }}
                              loading={loadingUsers}
                              disabled={isRunning}
                              placeholder="-- Assign cho bạn --"
                            />
                          </div>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => {
                              const newTasks = analyzedTasks.filter((_, i) => i !== idx);
                              setAnalyzedTasks(newTasks);
                            }}
                            disabled={isRunning}
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

                    <div className="form-group checkbox-row">
                      <input
                        id="checkbox-autolog-ai"
                        type="checkbox"
                        checked={autoLogWork}
                        onChange={(e) => setAutoLogWork(e.target.checked)}
                        disabled={isRunning}
                        style={{ width: "auto", margin: 0, cursor: "pointer" }}
                      />
                      <label htmlFor="checkbox-autolog-ai" style={{ cursor: "pointer", fontWeight: "normal", fontSize: 13, userSelect: "none" }}>
                        Tự động log theo estimate và chuyển Resolve khi đến End Date?
                      </label>
                    </div>

                    <div className="form-group">
                      <label htmlFor="input-start-date-log-ai">
                        Ngày bắt đầu của Task *
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
                    {jiraProjects.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.name} ({p.key})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group" style={{ marginTop: 16 }}>
                  <label>Chọn Sprint</label>
                  <select
                    value={selectedSprint}
                    onChange={(e) => setSelectedSprint(e.target.value)}
                    disabled={isRunning}
                  >
                    <option value="">-- Backlog (Không thêm vào Sprint) --</option>
                    {availableSprints.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
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
                     <div className="form-group" style={{ marginBottom: 16 }}>
                       <label>Role được gán Assignee</label>
                       <select
                         value={importAssigneeRole}
                         onChange={(e) => setImportAssigneeRole(e.target.value as ImportAssigneeRole)}
                         disabled={isRunning}
                       >
                         <option value="">-- Không gán role nào --</option>
                         <option value="BA">BA</option>
                         <option value="Tester">Tester</option>
                         <option value="DEV">DEV</option>
                       </select>
                       <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-secondary)" }}>
                         Chỉ task có tiền tố role được chọn mới nhận Assignee từ file; các role còn lại sẽ để Unassigned.
                       </div>
                     </div>
                     <div className="bulk-excel-preview">
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

                     <div className="form-group checkbox-row">
                       <input
                         id="checkbox-autolog-excel"
                         type="checkbox"
                         checked={autoLogWork}
                         onChange={(e) => setAutoLogWork(e.target.checked)}
                         disabled={isRunning}
                         style={{ width: "auto", margin: 0, cursor: "pointer" }}
                       />
                       <label htmlFor="checkbox-autolog-excel" style={{ cursor: "pointer", fontWeight: "normal", fontSize: 13, userSelect: "none" }}>
                         Tự động log theo estimate và chuyển Resolve khi đến End Date?
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

                <div className="bulk-manual-mode-tabs">
                  <button
                    type="button"
                    className={`btn btn-sm ${manualMode === "independent" ? "btn-primary" : "btn-secondary"}`}
                    onClick={() => setManualMode("independent")}
                    disabled={isRunning}
                  >
                    Tạo Task / Story độc lập
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${manualMode === "subtask" ? "btn-primary" : "btn-secondary"}`}
                    onClick={() => setManualMode("subtask")}
                    disabled={isRunning}
                  >
                    Tạo Sub-task cho Issue có sẵn
                  </button>
                </div>

                <form onSubmit={handleBulkCreateManual}>
                  <div className="form-group">
                    <label>Dự án (Project)</label>
                    <select
                      value={selectedProject}
                      onChange={(e) => setSelectedProject(e.target.value)}
                      disabled={isRunning}
                    >
                      {jiraProjects.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.name} ({p.key})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-group">
                    <label>Chọn Sprint</label>
                    <select
                      value={selectedSprint}
                      onChange={(e) => setSelectedSprint(e.target.value)}
                      disabled={isRunning}
                    >
                      <option value="">-- Backlog (Không thêm vào Sprint) --</option>
                      {availableSprints.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {manualMode === "subtask" && (
                    <div className="form-group">
                      <label>Task/Story cha (Key) *</label>
                      <input
                        type="text"
                        list="parent-task-list"
                        placeholder="VD: JIRA-123 hoặc chọn từ danh sách"
                        value={parentTaskKey}
                        onChange={e => setParentTaskKey(e.target.value)}
                        disabled={isRunning || loadingTasks}
                        required
                        autoComplete="off"
                      />
                      {recentTasks.length > 0 && (
                        <datalist id="parent-task-list">
                          {recentTasks.map(t => (
                            <option key={t.key} value={t.key}>
                              {t.fields.summary}
                            </option>
                          ))}
                        </datalist>
                      )}
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                        {loadingTasks ? "Đang tải danh sách gợi ý..." : "Gợi ý từ 100 task mới cập nhật."}
                      </div>
                    </div>
                  )}

                  <div className="form-group checkbox-row">
                    <input
                      id="checkbox-general-config"
                      type="checkbox"
                      checked={useGeneralConfig}
                      onChange={(e) => setUseGeneralConfig(e.target.checked)}
                      disabled={isRunning}
                      style={{ width: "auto", margin: 0, cursor: "pointer" }}
                    />
                    <label htmlFor="checkbox-general-config" style={{ cursor: "pointer", fontWeight: "bold", fontSize: 13, userSelect: "none" }}>
                      Tạo nhanh nhiều task cùng lúc (Tự động tăng ngày theo cấu hình chung)
                    </label>
                  </div>

                  <div className="form-group">
                    <label>Tài khoản Assignee (Dùng chung)</label>
                    <UserSelect
                      users={assignableUsers}
                      value={assignee}
                      onChange={setAssignee}
                      loading={loadingUsers}
                      disabled={isRunning}
                      placeholder="-- Tự động assign cho bạn --"
                    />
                  </div>

                  {useGeneralConfig ? (
                    <>
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

                      <div className="form-group checkbox-row">
                        <input
                          id="checkbox-autolog"
                          type="checkbox"
                          checked={autoLogWork}
                          onChange={(e) => setAutoLogWork(e.target.checked)}
                          disabled={isRunning}
                          style={{ width: "auto", margin: 0, cursor: "pointer" }}
                        />
                        <label htmlFor="checkbox-autolog" style={{ cursor: "pointer", fontWeight: "normal", fontSize: 13, userSelect: "none" }}>
                          Tự động log theo estimate và chuyển Resolve khi đến End Date?
                        </label>
                      </div>

                      <div className="form-group">
                        <label htmlFor="input-start-date-log">
                          Ngày bắt đầu của Task *
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
                    </>
                  ) : (
                    <div className="bulk-manual-list">
                      <label>Danh sách Task nhập thủ công</label>
                      <div className="form-hint">
                        Tick Auto Resolve để đến End Date hệ thống tự log theo Estimate và chuyển Resolve với Output.
                      </div>
                      {manualRows.map((row, idx) => (
                        <div key={row.id} className="bulk-manual-row">
                          <div className="bulk-manual-field bulk-manual-summary">
                            <span className="field-label-mobile">Summary</span>
                            <input
                              type="text"
                              placeholder="Tóm tắt công việc (Summary)..."
                              value={row.summary}
                              onChange={(e) => {
                                const newRows = [...manualRows];
                                newRows[idx].summary = e.target.value;
                                setManualRows(newRows);
                              }}
                              disabled={isRunning}
                              required
                            />
                          </div>
                          <div className="bulk-manual-field">
                            <span className="field-label-mobile">Start</span>
                            <input
                              type="date"
                              title="Ngày Start"
                              value={row.startDate}
                              onChange={(e) => {
                                const newRows = [...manualRows];
                                newRows[idx].startDate = e.target.value;
                                setManualRows(newRows);
                              }}
                              disabled={isRunning}
                            />
                          </div>
                          <div className="bulk-manual-field">
                            <span className="field-label-mobile">End</span>
                            <input
                              type="date"
                              title="Ngày End"
                              value={row.endDate}
                              onChange={(e) => {
                                const newRows = [...manualRows];
                                newRows[idx].endDate = e.target.value;
                                setManualRows(newRows);
                              }}
                              disabled={isRunning}
                            />
                          </div>
                          <div className="bulk-manual-field">
                            <span className="field-label-mobile">Estimate</span>
                            <input
                              type="text"
                              title="Estimate"
                              placeholder="7h"
                              value={row.estimate}
                              onChange={(e) => {
                                const newRows = [...manualRows];
                                newRows[idx].estimate = e.target.value;
                                setManualRows(newRows);
                              }}
                              disabled={isRunning}
                            />
                          </div>
                          <label className="bulk-manual-auto">
                            <input
                              type="checkbox"
                              title="Auto log theo estimate và Resolve khi đến End Date"
                              checked={row.autoLogWork}
                              onChange={(e) => {
                                const newRows = [...manualRows];
                                newRows[idx].autoLogWork = e.target.checked;
                                setManualRows(newRows);
                              }}
                              disabled={isRunning}
                              style={{ margin: 0 }}
                            />
                            Auto Resolve
                          </label>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm bulk-row-delete"
                            onClick={() => {
                              setManualRows(manualRows.filter((_, i) => i !== idx));
                            }}
                            disabled={isRunning || manualRows.length === 1}
                          >
                            🗑️
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          const today = new Date().toISOString().slice(0, 10);
                          setManualRows([...manualRows, { id: Date.now().toString(), summary: "", startDate: today, endDate: today, estimate: "7h", autoLogWork: true }]);
                        }}
                        disabled={isRunning}
                        style={{ alignSelf: "flex-start" }}
                      >
                        ➕ Thêm Task
                      </button>
                    </div>
                  )}

                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={isRunning || (useGeneralConfig ? !bulkText.trim() : manualRows.filter(r => r.summary.trim()).length === 0)}
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
          <div className="settings-section bulk-progress-card">
            <div className="settings-section-title">📊 Tiến trình thực hiện</div>
            <div className="settings-section-desc">Theo dõi trạng thái tạo tự động thời gian thực.</div>

            <div className="bulk-progress-list">
              {logs.length === 0 ? (
                <div className="bulk-progress-empty">
                  <span style={{ fontSize: 32, marginBottom: 8 }}>📋</span>
                  <span style={{ fontSize: 13 }}>Danh sách trống.</span>
                </div>
              ) : (
                logs.map((log, idx) => (
                  <div
                    key={idx}
                    className="bulk-progress-item"
                  >
                    <div className="bulk-progress-main">
                      <div
                        className="bulk-progress-title"
                      >
                        {log.summary}
                      </div>
                      {log.logDateText && (
                        <div className="bulk-progress-date">
                          📅 {log.logDateText}
                        </div>
                      )}
                      {log.errorMsg && (
                        <div className="bulk-progress-error">
                          ⚠️ {log.errorMsg}
                        </div>
                      )}
                    </div>

                    <div className="bulk-progress-status">
                      {log.status === "pending" && (
                        <span style={{ color: "var(--text-muted)" }}>⏳ Đang chờ</span>
                      )}
                      {log.status === "processing" && (
                        <span style={{ color: "var(--accent-blue)", fontWeight: 600 }} className="spinning-slow">
                          🌀 Đang tạo...
                        </span>
                      )}
                      {log.status === "success" && (
                        <div className="bulk-success-actions">
                          <a
                            href={`https://20.84.97.109:3033/browse/${log.key}`}
                            target="_blank"
                            rel="noreferrer"
                            className="bulk-success-link"
                          >
                            ✅ {log.key} ↗
                          </a>
                          <button
                            title="Copy Link"
                            onClick={() => {
                              copyToClipboard(`https://20.84.97.109:3033/browse/${log.key}`);
                            }}
                            className="btn btn-secondary btn-sm bulk-copy-btn"
                          >
                            📋
                          </button>
                        </div>
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
