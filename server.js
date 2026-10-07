import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import { connectDb } from "./config/db.js";
import Admin from "./models/Admin.js";
import authRoutes from "./routes/auth.js";
import hospitalRoutes from "./routes/hospitals.js";
import doctorRoutes from "./routes/doctors.js";
import availabilityRoutes from "./routes/availability.js";
import medicineRoutes from "./routes/medicines.js";
import searchRoutes from "./routes/search.js";
import { apiLimiter, authLimiter } from "./middleware/rateLimit.js";

const app = express();
const port = process.env.PORT || 4000;
const allowedOrigins = (
  process.env.CLIENT_ORIGINS ||
  "http://localhost:3000,http://127.0.0.1:3000,http://localhost:8081,http://127.0.0.1:8081,http://localhost:19006,http://127.0.0.1:19006"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

app.use(
  cors({
    credentials: true,
    origin: (requestOrigin, cb) => {
      if (!requestOrigin || allowedOrigins.includes(requestOrigin)) {
        return cb(null, true);
      }

      return cb(new Error("Not allowed by CORS"));
    },
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(apiLimiter);

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "doctorshathi-api" });
});

app.use("/auth", authLimiter, authRoutes);
app.use("/hospitals", hospitalRoutes);
app.use("/doctors", doctorRoutes);
app.use("/availability", availabilityRoutes);
app.use("/medicines", medicineRoutes);
app.use("/search", searchRoutes);

app.use((_req, res) => {
  res.status(404).json({ message: "Route not found" });
});

app.use((error, _req, res, _next) => {
  console.error("Unhandled error:", error?.message || error);
  res.status(500).json({ message: "Internal server error" });
});

await connectDb(process.env.MONGO_URI);

// The admin in ADMIN_EMAIL / ADMIN_PASSWORD is created on first start, and its
// password is re-synced whenever ADMIN_PASSWORD in .env changes.
const seedInitialAdmin = async () => {
  const adminEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const adminPassword = String(process.env.ADMIN_PASSWORD || "");
  if (!adminEmail || !adminPassword) return;

  const existing = await Admin.findOne({ email: adminEmail });
  if (!existing) {
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    await Admin.create({ email: adminEmail, passwordHash, role: "superadmin" });
    console.log(`Initial admin created: ${adminEmail}`);
    return;
  }

  const matches = existing.passwordHash && (await bcrypt.compare(adminPassword, existing.passwordHash));
  if (!matches) {
    existing.passwordHash = await bcrypt.hash(adminPassword, 12);
    await existing.save();
    console.log(`Admin password updated from .env for: ${adminEmail}`);
  }
};

await seedInitialAdmin();

app.listen(port, () => {
  console.log(`API running on http://localhost:${port}`);
});
