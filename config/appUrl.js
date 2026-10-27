// Base URL for links in emails: APP_URL, else the first allowed client origin.
export const appUrl = () =>
  (process.env.APP_URL || String(process.env.CLIENT_ORIGINS || "").split(",")[0] || "http://localhost:3000")
    .trim()
    .replace(/\/$/, "");
