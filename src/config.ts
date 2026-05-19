// ===============================================
// AZURE MSAL CONFIG
// Điền Client ID và Tenant ID sau khi đăng ký app
// ===============================================
export const msalConfig = {
  auth: {
    clientId: "e63223b5-72fd-44a2-8603-8986f8e69a23",
    authority: "https://login.microsoftonline.com/c5bcb2d8-6b4a-4cd4-a517-7cd85a7a8a55",
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: "localStorage",
    storeAuthStateInCookie: false,
  },
};

export const loginRequest = {
  scopes: ["User.Read"],
};

// ===============================================
// JIRA CONFIG
// ===============================================
export const JIRA_BASE_URL = "https://20.84.97.109:3033";

export const JIRA_PROJECTS = [
  { key: "BXDCSDL", name: "BXD.CSDL" },
  { key: "BXDHHHTGT", name: "BXD.HH.HTGT" },
  { key: "BXDBE", name: "BXD.BE.03" },
];
