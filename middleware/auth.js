import jwt from "jsonwebtoken";

const parseCookieHeader = (cookieHeader = "") =>
  cookieHeader.split(";").reduce((acc, part) => {
    const index = part.indexOf("=");
    if (index === -1) return acc;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      acc[key] = decodeURIComponent(value);
    }
    return acc;
  }, {});

const getTokenFromRequest = (req, cookieName) => {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) {
    return header.slice(7);
  }

  const cookies = parseCookieHeader(req.headers.cookie || "");
  return cookies[cookieName] || null;
};

export function requireAuth(req, res, next) {
  const token = getTokenFromRequest(req, "ds_admin_token");

  if (!token) {
    return res.status(401).json({ message: "Missing token" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.adminId = payload.sub;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid token" });
  }
}

export function requireCustomerAuth(req, res, next) {
  const token = getTokenFromRequest(req, "ds_customer_token");

  if (!token) {
    return res.status(401).json({ message: "Missing token" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload?.role !== "customer") {
      return res.status(401).json({ message: "Invalid token" });
    }

    req.customerId = payload.sub;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid token" });
  }
}
