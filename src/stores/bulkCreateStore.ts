export interface CreationLog {
  summary: string;
  status: "pending" | "processing" | "success" | "error";
  key?: string;
  errorMsg?: string;
  logDateText?: string;
}

type Listener = () => void;

let logs: CreationLog[] = [];
let isRunning: boolean = false;
let listeners: Listener[] = [];

export const bulkCreateStore = {
  getLogs: () => logs,
  getIsRunning: () => isRunning,
  
  setLogs: (updater: CreationLog[] | ((prev: CreationLog[]) => CreationLog[])) => {
    if (typeof updater === "function") {
      logs = updater(logs);
    } else {
      logs = updater;
    }
    bulkCreateStore.notify();
  },
  
  setIsRunning: (running: boolean) => {
    isRunning = running;
    bulkCreateStore.notify();
  },
  
  subscribe: (listener: Listener) => {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter(l => l !== listener);
    };
  },
  
  notify: () => {
    listeners.forEach(l => l());
  }
};
