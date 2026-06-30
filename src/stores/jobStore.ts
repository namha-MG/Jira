export interface BackgroundJob {
  id: string;
  type: string;
  title: string;
  status: "running" | "success" | "error";
  errorMsg?: string;
  createdAt: number;
}

type Listener = () => void;

let jobs: BackgroundJob[] = [];
let listeners: Listener[] = [];
let eventListeners: { [key: string]: ((data?: any) => void)[] } = {};

const generateId = () => Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

export const jobStore = {
  getJobs: () => jobs,
  
  addJob: (jobData: Omit<BackgroundJob, "id" | "status" | "createdAt">): string => {
    const id = generateId();
    const newJob: BackgroundJob = {
      ...jobData,
      id,
      status: "running",
      createdAt: Date.now()
    };
    jobs = [newJob, ...jobs];
    jobStore.notify();
    return id;
  },

  updateJobStatus: (id: string, status: "success" | "error", errorMsg?: string) => {
    jobs = jobs.map(job => 
      job.id === id ? { ...job, status, errorMsg } : job
    );
    jobStore.notify();
  },

  removeJob: (id: string) => {
    jobs = jobs.filter(job => job.id !== id);
    jobStore.notify();
  },

  clearCompleted: () => {
    jobs = jobs.filter(job => job.status === "running");
    jobStore.notify();
  },

  subscribe: (listener: Listener) => {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter(l => l !== listener);
    };
  },

  notify: () => {
    listeners.forEach(l => l());
  },

  // Event bus for component communication (e.g. to trigger fetchIssues)
  on: (event: string, callback: (data?: any) => void) => {
    if (!eventListeners[event]) {
      eventListeners[event] = [];
    }
    eventListeners[event].push(callback);
    return () => {
      eventListeners[event] = eventListeners[event].filter(cb => cb !== callback);
    };
  },

  emit: (event: string, data?: any) => {
    if (eventListeners[event]) {
      eventListeners[event].forEach(cb => cb(data));
    }
  }
};
