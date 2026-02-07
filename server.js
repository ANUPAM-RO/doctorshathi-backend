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

const app = express();
const port = process.env.PORT || 4000;
const origin = process.env.CLIENT_ORIGIN || "http://localhost:3000";

app.use(cors({ origin }));
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "doctorshathi-api" });
});

app.use("/auth", authRoutes);
app.use("/hospitals", hospitalRoutes);
app.use("/doctors", doctorRoutes);
app.use("/availability", availabilityRoutes);
app.use("/medicines", medicineRoutes);
app.use("/search", searchRoutes);

await connectDb(process.env.MONGO_URI);
app.listen(port, () => {
  console.log(`API running on http://localhost:${port}`);
});
