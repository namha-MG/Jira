import { useState, useCallback } from "react";
import { useIsAuthenticated, useMsal } from "@azure/msal-react";
import type { Page } from "./types";
import LoginPage from "./pages/LoginPage";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Issues from "./pages/Issues";
import LogWork from "./pages/LogWork";
import Settings from "./pages/Settings";
import BulkCreate from "./pages/BulkCreate";

export default function App() {
  const isAuthenticated = useIsAuthenticated();
  const { instance } = useMsal();
  const [currentPage, setCurrentPage] = useState<Page>("dashboard");
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

  const renderPage = () => {
    switch (currentPage) {
      case "dashboard":   return <Dashboard />;
      case "issues":      return <Issues />;
      case "logwork":     return <LogWork />;
      case "bulkcreate":  return <BulkCreate />;
      case "settings":    return <Settings />;
      default:            return <Dashboard />;
    }
  };

  return (
    <Layout
      currentPage={currentPage}
      onNavigate={setCurrentPage}
      onLogout={handleLogout}
    >
      {renderPage()}
    </Layout>
  );
}
