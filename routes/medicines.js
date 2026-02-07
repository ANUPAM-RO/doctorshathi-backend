import express from "express";
import Medicine from "../models/Medicine.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.get("/", async (_req, res) => {
  const meds = await Medicine.find().sort({ createdAt: -1 });
  res.json(meds);
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const med = await Medicine.create(req.body);
    res.status(201).json(med);
  } catch (error) {
    res.status(400).json({ message: "Failed to create medicine" });
  }
});

router.post("/bulk", requireAuth, async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) {
      return res.status(400).json({ message: "No medicine data provided" });
    }

    const writes = items.map((med) => ({
      updateOne: {
        filter: { name: med.name },
        update: {
          $set: {
            name: med.name,
            category: med.category || undefined,
            description: med.description || undefined,
            dosage: med.dosage || undefined,
            manufacturer: med.manufacturer || undefined
          }
        },
        upsert: true
      }
    }));

    const result = await Medicine.bulkWrite(writes);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(400).json({ message: "Failed to bulk upload medicines" });
  }
});

router.put("/:id", requireAuth, async (req, res) => {
  try {
    const updated = await Medicine.findByIdAndUpdate(req.params.id, req.body, {
      new: true
    });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ message: "Failed to update medicine" });
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    await Medicine.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ message: "Failed to delete medicine" });
  }
});

export default router;
