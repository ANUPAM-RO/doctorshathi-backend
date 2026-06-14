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

const validatePassword = (password) => {
  if (typeof password !== "string" || password.length < 6) {
    return "Password must be at least 6 characters.";
  }
  if (password.length > 128) {
    return "Password must be less than 128 characters.";
  }
  return null;
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

    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ message: passwordError });
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

    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ message: passwordError });
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

// Admin user management routes
const verifyAdmin = async (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ message: "Missing token" });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.adminId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
};

router.get("/users", verifyAdmin, async (req, res) => {
  try {
    const admins = await Admin.find().select("email role createdAt").lean();
    const customers = await Customer.find().select("name email phone createdAt").lean();
    return res.json({
      admins: admins.map(a => ({
        _id: a._id,
        email: a.email,
        role: a.role || "admin",
        createdAt: a.createdAt,
        type: "admin"
      })),
      customers: customers.map(c => ({
        _id: c._id,
        name: c.name,
        email: c.email,
        phone: c.phone,
        createdAt: c.createdAt,
        type: "customer"
      }))
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch users" });
  }
});

router.post("/users", verifyAdmin, async (req, res) => {
  try {
    const { email, password, role } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ message: passwordError });
    }

    const existing = await Admin.findOne({ email });
    if (existing) {
      return res.status(409).json({ message: "Admin already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const admin = await Admin.create({ email, passwordHash, role: role || "admin" });
    return res.status(201).json({ id: admin._id, email: admin.email, role: admin.role });
  } catch (error) {
    return res.status(500).json({ message: "Failed to create admin user" });
  }
});

router.delete("/users/:id", verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (id === req.adminId) {
      return res.status(400).json({ message: "Cannot delete yourself" });
    }

    let deleted = await Admin.findByIdAndDelete(id);
    if (deleted) {
      return res.json({ message: "Admin user deleted", type: "admin" });
    }

    deleted = await Customer.findByIdAndDelete(id);
    if (deleted) {
      return res.json({ message: "Customer deleted", type: "customer" });
    }

    return res.status(404).json({ message: "User not found" });
  } catch (error) {
    return res.status(500).json({ message: "Failed to delete user" });
  }
});

router.post("/users/bulk", verifyAdmin, async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items)) {
      return res.status(400).json({ message: "Items array required" });
    }

    const results = { created: 0, skipped: 0, errors: [] };
    for (const item of items) {
      try {
        const { email, password, role, type } = item;
        if (!email || !password) {
          results.errors.push({ email, error: "Missing email or password" });
          results.skipped++;
          continue;
        }

        if (type === "customer") {
          const existing = await Customer.findOne({ email });
          if (existing) {
            results.skipped++;
            continue;
          }
          const passwordHash = await bcrypt.hash(password, 12);
          await Customer.create({
            name: item.name || email.split("@")[0],
            email,
            phone: item.phone || "",
            passwordHash
          });
          results.created++;
        } else {
          const existing = await Admin.findOne({ email });
          if (existing) {
            results.skipped++;
            continue;
          }
          const passwordHash = await bcrypt.hash(password, 12);
          await Admin.create({ email, passwordHash, role: role || "admin" });
          results.created++;
        }
      } catch (err) {
        results.errors.push({ email: item.email, error: err.message });
        results.skipped++;
      }
    }

    return res.json({ message: "Bulk upload complete", ...results });
  } catch (error) {
    return res.status(500).json({ message: "Failed to bulk upload users" });
  }
});

export default router;
