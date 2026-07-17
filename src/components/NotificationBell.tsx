import { useState, useEffect, useRef } from "react";
import { getRecentNotificationsForUser, JiraNotification } from "../jiraService";
import { JiraImage } from "./JiraImage";

export default function NotificationBell() {
  const [notifications, setNotifications] = useState<JiraNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const fetchNotifications = async () => {
    setLoading(true);
    const notifs = await getRecentNotificationsForUser();
    setNotifications(notifs);
    
    // Check read status
    const readIds: string[] = JSON.parse(localStorage.getItem("read_notifications") || "[]");
    const unread = notifs.filter(n => !readIds.includes(n.id)).length;
    setUnreadCount(unread);
    setLoading(false);
  };

  useEffect(() => {
    fetchNotifications();
    // Poll every 5 minutes
    const interval = setInterval(fetchNotifications, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const markAllAsRead = () => {
    const allIds = notifications.map(n => n.id);
    localStorage.setItem("read_notifications", JSON.stringify(allIds));
    setUnreadCount(0);
  };

  const markAsReadAndGo = (id: string, issueKey: string) => {
    const readIds: string[] = JSON.parse(localStorage.getItem("read_notifications") || "[]");
    if (!readIds.includes(id)) {
      readIds.push(id);
      localStorage.setItem("read_notifications", JSON.stringify(readIds));
      setUnreadCount(prev => Math.max(0, prev - 1));
    }
    // You can redirect to the issue here if you have a global router, 
    // or just let them find it. For now, we just mark as read.
    setIsOpen(false);
  };

  return (
    <div className="notification-bell" ref={dropdownRef} style={{ position: "relative" }}>
      <button 
        className="btn btn-ghost btn-sm" 
        onClick={() => setIsOpen(!isOpen)}
        style={{ fontSize: 20, position: "relative", padding: "4px 8px" }}
      >
        🔔
        {unreadCount > 0 && (
          <span 
            className="badge badge-error" 
            style={{ 
              position: "absolute", 
              top: -2, 
              right: -2, 
              fontSize: 10, 
              padding: "2px 5px",
              minWidth: 16,
              height: 16,
              borderRadius: 8,
              lineHeight: 1,
              background: "#ff4d4f",
              color: "white"
            }}
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div 
          className="notification-dropdown"
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            width: 320,
            maxHeight: 400,
            background: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            zIndex: 1000,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            marginTop: 8
          }}
        >
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Thông báo</h3>
            {unreadCount > 0 && (
              <button 
                className="btn btn-ghost btn-sm" 
                style={{ fontSize: 12, color: "var(--accent-blue)" }}
                onClick={markAllAsRead}
              >
                Đánh dấu đã đọc
              </button>
            )}
          </div>
          
          <div style={{ overflowY: "auto", flex: 1, padding: 8 }}>
            {loading && notifications.length === 0 ? (
              <div style={{ padding: 16, textAlign: "center", color: "var(--text-secondary)", fontSize: 13 }}>Đang tải...</div>
            ) : notifications.length === 0 ? (
              <div style={{ padding: 16, textAlign: "center", color: "var(--text-secondary)", fontSize: 13 }}>Không có thông báo mới</div>
            ) : (
              notifications.map((n) => {
                const isUnread = !JSON.parse(localStorage.getItem("read_notifications") || "[]").includes(n.id);
                return (
                  <div 
                    key={n.id} 
                    style={{ 
                      padding: 12, 
                      borderRadius: 6,
                      background: isUnread ? "rgba(var(--accent-blue-rgb), 0.1)" : "transparent",
                      cursor: "pointer",
                      marginBottom: 4,
                      display: "flex",
                      gap: 12
                    }}
                    onClick={() => markAsReadAndGo(n.id, n.issueKey)}
                  >
                    {n.authorAvatar ? (
                      <JiraImage src={n.authorAvatar} alt="" style={{ width: 32, height: 32, borderRadius: "50%" }} />
                    ) : (
                      <div style={{ width: 32, height: 32, borderRadius: "50%", background: "var(--border)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>
                        {n.authorName.charAt(0)}
                      </div>
                    )}
                    <div style={{ flex: 1, overflow: "hidden" }}>
                      <div style={{ fontSize: 13, marginBottom: 4 }}>
                        <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{n.authorName}</span>
                        <span style={{ color: "var(--text-secondary)" }}> đã {n.type === "comment" ? "bình luận" : "thay đổi"} trên </span>
                        <strong style={{ color: "var(--accent-blue)" }}>{n.issueKey}</strong>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {n.content}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4, opacity: 0.7 }}>
                        {new Date(n.created).toLocaleString("vi-VN")}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
