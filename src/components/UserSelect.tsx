import React, { useState, useRef, useEffect } from "react";
import { JiraUser } from "../jiraService";

interface UserSelectProps {
  users: JiraUser[];
  value: string; // accountId or name
  onChange: (val: string) => void;
  disabled?: boolean;
  loading?: boolean;
  placeholder?: string;
}

export default function UserSelect({ users, value, onChange, disabled, loading, placeholder = "-- Chọn người thực hiện --" }: UserSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedUser = users.find(u => (u.name || u.accountId) === value);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const filteredUsers = users.filter(u => {
    const term = search.toLowerCase();
    return u.displayName.toLowerCase().includes(term) || (u.name && u.name.toLowerCase().includes(term));
  });

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%" }}>
      <div
        style={{
          border: "1px solid var(--border)",
          padding: "8px 12px",
          borderRadius: 6,
          background: disabled ? "rgba(0,0,0,0.05)" : "var(--bg-card)",
          cursor: disabled ? "not-allowed" : "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          minHeight: "38px"
        }}
        onClick={() => {
          if (!disabled) {
            setIsOpen(!isOpen);
            setSearch("");
          }
        }}
      >
        <span style={{ opacity: selectedUser ? 1 : 0.6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 13 }}>
          {loading ? "Đang tải danh sách..." : selectedUser ? `${selectedUser.displayName} ${selectedUser.name ? `(${selectedUser.name})` : ""}` : placeholder}
        </span>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>▼</span>
      </div>

      {isOpen && (
        <div style={{
          position: "absolute",
          top: "100%",
          left: 0,
          right: 0,
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
          marginTop: 4,
          zIndex: 100,
          maxHeight: 250,
          display: "flex",
          flexDirection: "column"
        }}>
          <input
            autoFocus
            type="text"
            placeholder="Tìm kiếm tên..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ margin: 8, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 4, fontSize: 13 }}
            onClick={e => e.stopPropagation()}
          />
          <div style={{ overflowY: "auto", flex: 1, paddingBottom: 4, fontSize: 13 }}>
            <div
              style={{ padding: "8px 12px", cursor: "pointer", opacity: 0.7 }}
              onClick={() => { onChange(""); setIsOpen(false); }}
              onMouseEnter={e => e.currentTarget.style.background = "rgba(0,0,0,0.05)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              {placeholder}
            </div>
            {filteredUsers.length === 0 ? (
              <div style={{ padding: "8px 12px", opacity: 0.5, textAlign: "center" }}>Không tìm thấy</div>
            ) : (
              filteredUsers.map(u => {
                const val = u.name || u.accountId;
                return (
                  <div
                    key={val}
                    style={{
                      padding: "8px 12px",
                      cursor: "pointer",
                      background: value === val ? "rgba(16, 185, 129, 0.1)" : "transparent",
                    }}
                    onClick={() => { onChange(val); setIsOpen(false); }}
                    onMouseEnter={e => { if (value !== val) e.currentTarget.style.background = "rgba(0,0,0,0.05)"; }}
                    onMouseLeave={e => { if (value !== val) e.currentTarget.style.background = "transparent"; }}
                  >
                    {u.displayName} {u.name ? <span style={{ opacity: 0.5, fontSize: 12 }}>({u.name})</span> : ""}
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
