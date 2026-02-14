import express from "express";
import Hospital from "../models/Hospital.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.get("/", async (_req, res) => {
  const hospitals = await Hospital.find().sort({ createdAt: -1 });
  res.json(hospitals);
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const hospital = await Hospital.create(req.body);
    res.status(201).json(hospital);
  } catch (error) {
    res.status(400).json({ message: "Failed to create hospital" });
  }
});

router.post("/bulk", requireAuth, async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) {
      return res.status(400).json({ message: "No hospital data provided" });
    }

    const writes = items.map((hospital) => {
      const services =
        typeof hospital.services === "string"
          ? hospital.services
              .split(/[|,]/)
              .map((item) => item.trim())
              .filter(Boolean)
          : Array.isArray(hospital.services)
          ? hospital.services
          : [];

      return {
        updateOne: {
          filter: { name: hospital.name },
          update: {
            $set: {
              name: hospital.name,
              address: hospital.address,
              state: hospital.state,
              district: hospital.district,
              citySubdivision: hospital.citySubdivision,
              pinCode: hospital.pinCode,
              phone: hospital.phone || undefined,
              email: hospital.email || undefined,
              services,
              opdScheduleText: hospital.opdScheduleText || undefined,
              bookingInstructions: Array.isArray(hospital.bookingInstructions)
                ? hospital.bookingInstructions
                : undefined,
              transportInfo: hospital.transportInfo || undefined,
              foodInfo: hospital.foodInfo || undefined,
              stayInfo: hospital.stayInfo || undefined,
              languageInfo: hospital.languageInfo || undefined
            }
          },
          upsert: true
        }
      };
    });

    const result = await Hospital.bulkWrite(writes);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(400).json({ message: "Failed to bulk upload hospitals" });
  }
});

router.put("/:id", requireAuth, async (req, res) => {
  try {
    const updated = await Hospital.findByIdAndUpdate(req.params.id, req.body, {
      new: true
    });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ message: "Failed to update hospital" });
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    await Hospital.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ message: "Failed to delete hospital" });
  }
});

export default router;
