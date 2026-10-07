import jwt from "jsonwebtoken";
import Customer from "../models/Customer.js";

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

export async function requireCustomerAuth(req, res, next) {
  const token = getTokenFromRequest(req, "ds_customer_token");

  if (!token) {
    return res.status(401).json({ message: "Missing token" });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({ message: "Invalid token" });
  }
  if (payload?.role !== "customer") {
    return res.status(401).json({ message: "Invalid token" });
  }

  try {
    // Reject sessions created before the last password change / reset.
    const customer = await Customer.findById(payload.sub).select("passwordChangedAt").lean();
    if (!customer) {
      return res.status(401).json({ message: "Account not found" });
    }
    if (customer.passwordChangedAt && payload.iat * 1000 < new Date(customer.passwordChangedAt).getTime() - 1000) {
      return res.status(401).json({ message: "Session expired. Please sign in again." });
    }
  } catch (error) {
    return res.status(500).json({ message: "Failed to verify session" });
  }

  req.customerId = payload.sub;
  next();
}
