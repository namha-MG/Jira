import { useState, useCallback, useEffect } from "react";
import { useIsAuthenticated, useMsal } from "@azure/msal-react";
import { HashRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import LoginPage from "./pages/LoginPage";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Issues from "./pages/Issues";
import LogWork from "./pages/LogWork";
import GitReconciliation from "./pages/GitReconciliation";
import Settings from "./pages/Settings";
import BulkCreate from "./pages/BulkCreate";
import AutoSchedules from "./pages/AutoSchedules";
import JobLogs from "./pages/JobLogs";
import Teams from "./pages/Teams";
import UnassignedIssues from "./pages/UnassignedIssues";
import { silentAutoProcessTasks } from "./autoProcessor";

export default function App() {
  const isAuthenticated = useIsAuthenticated();
  const { instance } = useMsal();
  const [bypassAuth, setBypassAuth] = useState(() => localStorage.getItem("auth_bypass") === "true");

  const handleLogout = useCallback(() => {
    localStorage.removeItem("auth_bypass");
    setBypassAuth(false);
    try {
      instance.logoutPopup();
    } catch (e) {
      console.warn("Msal logout skipped in bypass mode");
    }
  }, [instance]);

  useEffect(() => {
    if (!isAuthenticated && !bypassAuth) return;

    const runAutoResolve = () => {
      silentAutoProcessTasks().catch((err) => console.warn("Auto resolve skipped", err));
    };

    runAutoResolve();
    const interval = window.setInterval(runAutoResolve, 5 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [isAuthenticated, bypassAuth]);

  if (!isAuthenticated && !bypassAuth) {
    return (
      <LoginPage
        onBypass={() => {
          localStorage.setItem("auth_bypass", "true");
          setBypassAuth(true);
        }}
      />
    );
  }

  return (
    <Router>
      <Layout onLogout={handleLogout}>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/issues" element={<Issues />} />
          <Route path="/logwork" element={<LogWork />} />
          <Route path="/git-reconciliation" element={<GitReconciliation />} />
          <Route path="/bulkcreate" element={<BulkCreate />} />
          <Route path="/autoschedules" element={<AutoSchedules />} />
          <Route path="/teams" element={<Teams />} />
          <Route path="/joblogs" element={<JobLogs />} />
          <Route path="/unassigned" element={<UnassignedIssues />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Layout>
    </Router>
  );
}
