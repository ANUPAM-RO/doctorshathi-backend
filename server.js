import "dotenv/config";
import express from "express";
import cors from "cors";
import { connectDb } from "./config/db.js";
import authRoutes from "./routes/auth.js";
import hospitalRoutes from "./routes/hospitals.js";
import doctorRoutes from "./routes/doctors.js";
import availabilityRoutes from "./routes/availability.js";
import medicineRoutes from "./routes/medicines.js";
import searchRoutes from "./routes/search.js";
import { apiLimiter, authLimiter } from "./middleware/rateLimit.js";

const app = express();
const port = process.env.PORT || 4000;
const allowedOrigins = (process.env.CLIENT_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

app.use(
  cors({
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

await connectDb(process.env.MONGO_URI);
app.listen(port, () => {
  console.log(`API running on http://localhost:${port}`);
});
