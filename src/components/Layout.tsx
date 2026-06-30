import { ReactNode } from "react";
import { useMsal } from "@azure/msal-react";
import { NavLink } from "react-router-dom";
import JobManager from "./JobManager";
import type { Page } from "../types";

interface LayoutProps {
  children: ReactNode;
  onLogout: () => void;
}

const navItems: { id: Page; icon: string; label: string; path: string }[] = [
  { id: "dashboard",  icon: "📊", label: "Dashboard", path: "/dashboard" },
  { id: "issues",     icon: "📋", label: "Danh sách Issues", path: "/issues" },
  { id: "logwork",    icon: "⏱️", label: "Log Công Việc", path: "/logwork" },
  { id: "bulkcreate", icon: "➕", label: "Tạo Issue Nhanh", path: "/bulkcreate" },
  { id: "unassigned", icon: "👤", label: "Task Chưa Gán", path: "/unassigned" },
  { id: "teams",      icon: "🏢", label: "Quản lý Team", path: "/teams" },
  { id: "joblogs",    icon: "🤖", label: "Lịch sử Job Tự động", path: "/joblogs" },
  { id: "settings",   icon: "⚙️", label: "Cài đặt", path: "/settings" },
];

export default function Layout({ children, onLogout }: LayoutProps) {
  const { accounts } = useMsal();
  const user = accounts[0];
  const displayName = user?.name || user?.username || localStorage.getItem("jira_user_name") || "Local User";
  const email = user?.username || "local@offline.dev";
  const initials = displayName
    .split(" ")
    .map((n: string) => n ? n[0] : "")
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase() || "LU";

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <aside className="sidebar">
        {/* Logo */}
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">📊</div>
          <div>
            <div className="sidebar-logo-text">Jira Monitor</div>
            <div className="sidebar-logo-sub">Time Tracking</div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="sidebar-nav">
          <div className="nav-section-title">Menu</div>
          {navItems.map((item) => (
            <NavLink
              key={item.id}
              to={item.path}
              id={`nav-${item.id}`}
              className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
              style={{ textDecoration: "none" }}
            >
              <span className="nav-item-icon">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* User footer */}
        <div className="sidebar-footer">
          <div className="user-card">
            <div className="user-avatar-placeholder">{initials}</div>
            <div className="user-info">
              <div className="user-name">{displayName}</div>
              <div className="user-email">{email}</div>
            </div>
            <button
              id="btn-logout"
              className="btn btn-ghost btn-icon"
              onClick={onLogout}
              title="Đăng xuất"
              style={{ marginLeft: "auto", padding: "4px" }}
            >
              🚪
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="main-content">{children}</main>

      <JobManager />
    </div>
  );
}
