import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Admin from "../models/Admin.js";
import Customer from "../models/Customer.js";

const router = express.Router();
const CUSTOMER_COOKIE_NAME = "ds_customer_token";
const cookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 7 * 24 * 60 * 60 * 1000
};

const mapCustomer = (customer) => ({
  id: customer._id,
  name: customer.name,
  email: customer.email,
  phone: customer.phone,
  defaultAddress: customer.defaultAddress || {}
});

router.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    const existing = await Admin.findOne({ email });
    if (existing) {
      return res.status(409).json({ message: "Admin already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const admin = await Admin.create({ email, passwordHash });
    return res.status(201).json({ id: admin._id, email: admin.email });
  } catch (error) {
    return res.status(500).json({ message: "Failed to register admin" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    const admin = await Admin.findOne({ email });
    if (!admin) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const ok = await bcrypt.compare(password, admin.passwordHash);
    if (!ok) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign({ sub: admin._id }, process.env.JWT_SECRET, {
      expiresIn: "7d"
    });

    return res.json({ token });
  } catch (error) {
    return res.status(500).json({ message: "Failed to login" });
  }
});

router.post("/customer/register", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const phone = String(req.body?.phone || "").trim();
    const password = String(req.body?.password || "");

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Name, email and password required." });
    }

    const existing = await Customer.findOne({ email });
    if (existing) {
      return res.status(409).json({ message: "Customer already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const customer = await Customer.create({
      name,
      email,
      phone: phone || undefined,
      defaultAddress: {
        line1: "",
        line2: "",
        city: "",
        state: "",
        pincode: ""
      },
      passwordHash
    });

    const token = jwt.sign({ sub: customer._id, role: "customer" }, process.env.JWT_SECRET, {
      expiresIn: "7d"
    });

    res.cookie(CUSTOMER_COOKIE_NAME, token, cookieOptions);

    return res.status(201).json({
      customer: mapCustomer(customer)
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to register customer" });
  }
});

router.post("/customer/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    const customer = await Customer.findOne({ email });
    if (!customer) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const ok = await bcrypt.compare(password, customer.passwordHash);
    if (!ok) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign({ sub: customer._id, role: "customer" }, process.env.JWT_SECRET, {
      expiresIn: "7d"
    });

    res.cookie(CUSTOMER_COOKIE_NAME, token, cookieOptions);

    return res.json({
      customer: mapCustomer(customer)
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to login customer" });
  }
});

router.get("/customer/me", async (req, res) => {
  try {
    const header = req.headers.authorization || "";
    const cookieHeader = req.headers.cookie || "";
    const cookieToken = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${CUSTOMER_COOKIE_NAME}=`));
    const token = header.startsWith("Bearer ")
      ? header.slice(7)
      : cookieToken
        ? decodeURIComponent(cookieToken.split("=").slice(1).join("="))
        : null;
    if (!token) {
      return res.status(401).json({ message: "Missing token" });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload?.role !== "customer") {
      return res.status(401).json({ message: "Invalid token" });
    }

    const customer = await Customer.findById(payload.sub).lean();
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    return res.json(mapCustomer(customer));
  } catch (error) {
    return res.status(401).json({ message: "Invalid token" });
  }
});

router.patch("/customer/me", async (req, res) => {
  try {
    const header = req.headers.authorization || "";
    const cookieHeader = req.headers.cookie || "";
    const cookieToken = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${CUSTOMER_COOKIE_NAME}=`));
    const token = header.startsWith("Bearer ")
      ? header.slice(7)
      : cookieToken
        ? decodeURIComponent(cookieToken.split("=").slice(1).join("="))
        : null;
    if (!token) {
      return res.status(401).json({ message: "Missing token" });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload?.role !== "customer") {
      return res.status(401).json({ message: "Invalid token" });
    }

    const name = String(req.body?.name || "").trim();
    const phone = String(req.body?.phone || "").trim();
    const defaultAddress = req.body?.defaultAddress || {};

    const updated = await Customer.findByIdAndUpdate(
      payload.sub,
      {
        ...(name ? { name } : {}),
        phone,
        defaultAddress: {
          line1: String(defaultAddress.line1 || "").trim(),
          line2: String(defaultAddress.line2 || "").trim(),
          city: String(defaultAddress.city || "").trim(),
          state: String(defaultAddress.state || "").trim(),
          pincode: String(defaultAddress.pincode || "").trim()
        }
      },
      { new: true }
    ).lean();

    if (!updated) {
      return res.status(404).json({ message: "Customer not found" });
    }

    return res.json(mapCustomer(updated));
  } catch (error) {
    return res.status(401).json({ message: "Invalid token" });
  }
});

router.post("/customer/logout", async (_req, res) => {
  res.clearCookie(CUSTOMER_COOKIE_NAME, {
    ...cookieOptions,
    maxAge: undefined
  });
  return res.json({ ok: true });
});

export default router;
