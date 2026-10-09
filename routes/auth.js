import express from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import Admin from "../models/Admin.js";
import Customer from "../models/Customer.js";
import { requireCustomerAuth } from "../middleware/auth.js";
import { sendMail } from "../config/mailer.js";

const router = express.Router();
const CUSTOMER_COOKIE_NAME = "ds_customer_token";
const isProduction = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
// In production the frontend may call the API from another site (e.g. a different
// *.vercel.app subdomain), and browsers only send cross-site cookies marked None + Secure.
const cookieOptions = {
  httpOnly: true,
  sameSite: isProduction ? "none" : "lax",
  secure: isProduction,
  path: "/",
  maxAge: 7 * 24 * 60 * 60 * 1000
};

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

// Base URL for links in emails: APP_URL, else the first allowed client origin.
const appUrl = () =>
  (process.env.APP_URL || String(process.env.CLIENT_ORIGINS || "").split(",")[0] || "http://localhost:3000")
    .trim()
    .replace(/\/$/, "");

const issueCustomerSession = (res, customer) => {
  const token = jwt.sign({ sub: customer._id, role: "customer" }, process.env.JWT_SECRET, {
    expiresIn: "7d"
  });
  res.cookie(CUSTOMER_COOKIE_NAME, token, cookieOptions);
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

const PHONE_PATTERN = /^[6-9]\d{9}$/;
const PINCODE_PATTERN = /^\d{6}$/;
const ADDRESS_LABELS = ["home", "work", "other"];
const GENDERS = ["", "male", "female", "other"];
const MAX_ADDRESSES = 10;

// Accepts "+91 98765 43210", "098765-43210" etc. and returns the 10-digit number.
const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

const mapAddress = (address) => ({
  id: address._id,
  label: address.label || "home",
  fullName: address.fullName || "",
  phone: address.phone || "",
  line1: address.line1 || "",
  line2: address.line2 || "",
  landmark: address.landmark || "",
  city: address.city || "",
  state: address.state || "",
  pincode: address.pincode || "",
  isDefault: Boolean(address.isDefault)
});

const mapCustomer = (customer) => ({
  id: customer._id,
  name: customer.name,
  email: customer.email,
  phone: customer.phone || "",
  gender: customer.gender || "",
  dateOfBirth: customer.dateOfBirth || null,
  addresses: (customer.addresses || []).map(mapAddress),
  defaultAddress: customer.defaultAddress || {},
  createdAt: customer.createdAt
});

const parseAddressInput = (body) => {
  const address = {
    label: ADDRESS_LABELS.includes(String(body?.label || "").toLowerCase())
      ? String(body.label).toLowerCase()
      : "home",
    fullName: String(body?.fullName || "").trim(),
    phone: normalizePhone(body?.phone),
    line1: String(body?.line1 || "").trim(),
    line2: String(body?.line2 || "").trim(),
    landmark: String(body?.landmark || "").trim(),
    city: String(body?.city || "").trim(),
    state: String(body?.state || "").trim(),
    pincode: String(body?.pincode || "").trim()
  };

  if (!address.fullName) return { error: "Recipient name is required." };
  if (!PHONE_PATTERN.test(address.phone)) return { error: "Enter a valid 10-digit mobile number." };
  if (!address.line1) return { error: "House / street address is required." };
  if (!address.city || !address.state) return { error: "City and state are required." };
  if (!PINCODE_PATTERN.test(address.pincode)) return { error: "Enter a valid 6-digit pincode." };
  return { address };
};

// Exactly one address is default; the legacy `defaultAddress` field mirrors it.
const syncDefaultAddress = (customer) => {
  const addresses = customer.addresses || [];
  if (addresses.length && !addresses.some((a) => a.isDefault)) {
    addresses[0].isDefault = true;
  }
  const current = addresses.find((a) => a.isDefault);
  customer.defaultAddress = current
    ? {
        line1: current.line1,
        line2: current.line2,
        city: current.city,
        state: current.state,
        pincode: current.pincode
      }
    : { line1: "", line2: "", city: "", state: "", pincode: "" };
};

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
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
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
    const phone = normalizePhone(req.body?.phone);
    const password = String(req.body?.password || "");

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Name, email and password required." });
    }
    if (phone && !PHONE_PATTERN.test(phone)) {
      return res.status(400).json({ message: "Enter a valid 10-digit mobile number." });
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
      passwordHash
    });

    issueCustomerSession(res, customer);

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

    issueCustomerSession(res, customer);

    return res.json({
      customer: mapCustomer(customer)
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to login customer" });
  }
});

router.get("/customer/me", requireCustomerAuth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.customerId);
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    // Accounts from before saved addresses: move the single legacy address into the list once.
    const legacy = customer.defaultAddress || {};
    if (!customer.addresses.length && legacy.line1 && legacy.city && legacy.state && legacy.pincode) {
      customer.addresses.push({
        label: "home",
        fullName: customer.name,
        phone: customer.phone,
        line1: legacy.line1,
        line2: legacy.line2,
        city: legacy.city,
        state: legacy.state,
        pincode: legacy.pincode,
        isDefault: true
      });
      await customer.save();
    }
    return res.json(mapCustomer(customer));
  } catch (error) {
    return res.status(500).json({ message: "Failed to load profile" });
  }
});

router.patch("/customer/me", requireCustomerAuth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.customerId);
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    const body = req.body || {};
    if (body.name !== undefined) {
      const name = String(body.name || "").trim();
      if (!name) return res.status(400).json({ message: "Name cannot be empty." });
      customer.name = name;
    }
    if (body.phone !== undefined) {
      const phone = normalizePhone(body.phone);
      if (phone && !PHONE_PATTERN.test(phone)) {
        return res.status(400).json({ message: "Enter a valid 10-digit mobile number." });
      }
      customer.phone = phone;
    }
    if (body.gender !== undefined) {
      const gender = String(body.gender || "").toLowerCase();
      if (!GENDERS.includes(gender)) {
        return res.status(400).json({ message: "Invalid gender value." });
      }
      customer.gender = gender;
    }
    if (body.dateOfBirth !== undefined) {
      if (!body.dateOfBirth) {
        customer.dateOfBirth = undefined;
      } else {
        const dob = new Date(body.dateOfBirth);
        if (Number.isNaN(dob.getTime()) || dob > new Date()) {
          return res.status(400).json({ message: "Invalid date of birth." });
        }
        customer.dateOfBirth = dob;
      }
    }

    // Legacy clients send a single `defaultAddress`; store it as the default saved address.
    if (body.defaultAddress && String(body.defaultAddress.line1 || "").trim()) {
      const legacy = body.defaultAddress;
      const current = customer.addresses.find((a) => a.isDefault);
      const fields = {
        line1: String(legacy.line1 || "").trim(),
        line2: String(legacy.line2 || "").trim(),
        city: String(legacy.city || "").trim(),
        state: String(legacy.state || "").trim(),
        pincode: String(legacy.pincode || "").trim()
      };
      if (current) {
        Object.assign(current, fields);
      } else {
        customer.addresses.push({
          ...fields,
          label: "home",
          fullName: customer.name,
          phone: customer.phone,
          isDefault: true
        });
      }
    }

    syncDefaultAddress(customer);
    await customer.save();
    return res.json(mapCustomer(customer));
  } catch (error) {
    if (error?.name === "ValidationError") {
      return res.status(400).json({ message: "Please check the address details." });
    }
    return res.status(500).json({ message: "Failed to update profile" });
  }
});

router.post("/customer/addresses", requireCustomerAuth, async (req, res) => {
  try {
    const { address, error } = parseAddressInput(req.body);
    if (error) return res.status(400).json({ message: error });

    const customer = await Customer.findById(req.customerId);
    if (!customer) return res.status(404).json({ message: "Customer not found" });
    if (customer.addresses.length >= MAX_ADDRESSES) {
      return res.status(400).json({ message: `You can save up to ${MAX_ADDRESSES} addresses.` });
    }

    const makeDefault = Boolean(req.body?.isDefault) || customer.addresses.length === 0;
    if (makeDefault) {
      customer.addresses.forEach((a) => {
        a.isDefault = false;
      });
    }
    customer.addresses.push({ ...address, isDefault: makeDefault });
    syncDefaultAddress(customer);
    await customer.save();

    const created = customer.addresses[customer.addresses.length - 1];
    return res.status(201).json({ address: mapAddress(created), customer: mapCustomer(customer) });
  } catch (error) {
    return res.status(500).json({ message: "Failed to save address" });
  }
});

router.put("/customer/addresses/:addressId", requireCustomerAuth, async (req, res) => {
  try {
    const { address, error } = parseAddressInput(req.body);
    if (error) return res.status(400).json({ message: error });

    const customer = await Customer.findById(req.customerId);
    if (!customer) return res.status(404).json({ message: "Customer not found" });
    const existing = customer.addresses.id(req.params.addressId);
    if (!existing) return res.status(404).json({ message: "Address not found" });

    Object.assign(existing, address);
    if (req.body?.isDefault) {
      customer.addresses.forEach((a) => {
        a.isDefault = String(a._id) === String(existing._id);
      });
    }
    syncDefaultAddress(customer);
    await customer.save();
    return res.json({ address: mapAddress(existing), customer: mapCustomer(customer) });
  } catch (error) {
    return res.status(500).json({ message: "Failed to update address" });
  }
});

router.post("/customer/addresses/:addressId/default", requireCustomerAuth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.customerId);
    if (!customer) return res.status(404).json({ message: "Customer not found" });
    const target = customer.addresses.id(req.params.addressId);
    if (!target) return res.status(404).json({ message: "Address not found" });

    customer.addresses.forEach((a) => {
      a.isDefault = String(a._id) === String(target._id);
    });
    syncDefaultAddress(customer);
    await customer.save();
    return res.json(mapCustomer(customer));
  } catch (error) {
    return res.status(500).json({ message: "Failed to update default address" });
  }
});

router.delete("/customer/addresses/:addressId", requireCustomerAuth, async (req, res) => {
  try {
    const customer = await Customer.findById(req.customerId);
    if (!customer) return res.status(404).json({ message: "Customer not found" });
    const target = customer.addresses.id(req.params.addressId);
    if (!target) return res.status(404).json({ message: "Address not found" });

    target.deleteOne();
    syncDefaultAddress(customer);
    await customer.save();
    return res.json(mapCustomer(customer));
  } catch (error) {
    return res.status(500).json({ message: "Failed to delete address" });
  }
});

router.post("/customer/password", requireCustomerAuth, async (req, res) => {
  try {
    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");
    const passwordError = validatePassword(newPassword);
    if (passwordError) return res.status(400).json({ message: passwordError });

    const customer = await Customer.findById(req.customerId);
    if (!customer) return res.status(404).json({ message: "Customer not found" });

    const ok = await bcrypt.compare(currentPassword, customer.passwordHash);
    if (!ok) return res.status(400).json({ message: "Current password is incorrect." });

    customer.passwordHash = await bcrypt.hash(newPassword, 12);
    customer.passwordChangedAt = new Date();
    await customer.save();
    issueCustomerSession(res, customer);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ message: "Failed to change password" });
  }
});

// Always answers the same way so the endpoint can't be used to discover registered emails.
router.post("/customer/forgot-password", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const genericReply = {
    ok: true,
    message: "If an account exists for that email, we've sent a link to reset the password."
  };
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ message: "Enter a valid email address." });
  }

  try {
    const customer = await Customer.findOne({ email });
    if (!customer) return res.json(genericReply);

    const token = crypto.randomBytes(32).toString("hex");
    customer.resetPasswordTokenHash = hashToken(token);
    customer.resetPasswordExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    await customer.save();

    const link = `${appUrl()}/reset-password?token=${token}&email=${encodeURIComponent(email)}`;
    try {
      await sendMail({
        to: email,
        subject: "Reset your DoctorShathi password",
        text:
          `Hi ${customer.name || "there"},\n\n` +
          `We received a request to reset your DoctorShathi password. Open this link within 30 minutes:\n\n${link}\n\n` +
          "If you didn't ask for this, you can ignore this email; your password won't change.",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#121a17">
            <h2 style="color:#0f6a4e;margin-bottom:8px">Reset your password</h2>
            <p>Hi ${String(customer.name || "there").replace(/[<>&"]/g, "")},</p>
            <p>We received a request to reset your DoctorShathi password. This link works for 30 minutes.</p>
            <p style="margin:28px 0">
              <a href="${link}" style="background:#13835f;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:bold">Choose a new password</a>
            </p>
            <p style="font-size:13px;color:#4f5b55">If you didn't ask for this, ignore this email. Your password won't change.</p>
          </div>`
      });
    } catch (mailError) {
      // Same reply as success: a different answer would reveal that this email is registered.
      console.error("Password reset email failed:", mailError?.message || mailError);
    }

    return res.json(genericReply);
  } catch (error) {
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

router.post("/customer/reset-password", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const token = String(req.body?.token || "");
    const password = String(req.body?.password || "");

    const passwordError = validatePassword(password);
    if (passwordError) return res.status(400).json({ message: passwordError });
    if (!email || !/^[a-f0-9]{64}$/.test(token)) {
      return res.status(400).json({ message: "This reset link is invalid. Request a new one." });
    }

    const customer = await Customer.findOne({ email }).select("+resetPasswordTokenHash +resetPasswordExpires");
    const stored = customer?.resetPasswordTokenHash;
    const valid =
      stored &&
      customer.resetPasswordExpires &&
      customer.resetPasswordExpires.getTime() > Date.now() &&
      crypto.timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(hashToken(token), "hex"));
    if (!valid) {
      return res.status(400).json({ message: "This reset link is invalid or has expired. Request a new one." });
    }

    customer.passwordHash = await bcrypt.hash(password, 12);
    customer.passwordChangedAt = new Date();
    customer.resetPasswordTokenHash = undefined;
    customer.resetPasswordExpires = undefined;
    await customer.save();

    issueCustomerSession(res, customer);
    return res.json({ ok: true, message: "Password updated. You're now signed in." });
  } catch (error) {
    return res.status(500).json({ message: "Failed to reset password." });
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
