import { useIsAuthenticated, useMsal } from "@azure/msal-react";
import { loginRequest } from "../config";

export default function LoginPage({ onBypass }: { onBypass: () => void }) {
  const { instance, inProgress } = useMsal();
  const isAuthenticated = useIsAuthenticated();

  const handleLogin = async () => {
    try {
      await instance.loginPopup(loginRequest);
    } catch (e) {
      console.error("Login failed:", e);
    }
  };

  if (isAuthenticated) return null;

  return (
    <div className="login-page">
      <div className="login-bg" />
      <div className="login-card">
        <div className="login-logo">📊</div>
        <h1 className="login-title">Jira Time Monitor</h1>
        <p className="login-subtitle">
          Theo dõi giờ estimate & worklog của bạn<br />
          Đăng nhập bằng tài khoản tổ chức
        </p>

        <button
          className="btn btn-primary login-btn"
          onClick={handleLogin}
          disabled={inProgress === "login"}
          id="btn-login-microsoft"
        >
          <svg className="login-ms-icon" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="1" y="1" width="9" height="9" fill="#F25022"/>
            <rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
            <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/>
            <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
          </svg>
          {inProgress === "login" ? "Đang đăng nhập..." : "Đăng nhập với Microsoft"}
        </button>

        <button
          className="btn btn-secondary login-btn"
          onClick={onBypass}
          style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: "rgba(255, 255, 255, 0.05)", border: "1px solid var(--border)", width: "100%" }}
          id="btn-login-bypass"
        >
          ⚡ Chạy thử nghiệm (Bypass Azure AD)
        </button>

        <div className="login-footer">
          Được bảo vệ bởi Microsoft Entra ID (Azure AD)<br />
          Kết nối với Jira Server tại 20.84.97.109:3033
        </div>
      </div>
    </div>
  );
}
