import express from "express";
import Availability from "../models/Availability.js";
import Doctor from "../models/Doctor.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.get("/", async (req, res) => {
  const page = Math.max(parseInt(req.query.page || "1", 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || "50", 10), 1), 200);
  const skip = (page - 1) * limit;

  const total = await Availability.countDocuments();
  const availability = await Availability.find()
    .populate("doctorId")
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  res.json({
    availability,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1
    }
  });
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const slot = await Availability.create(req.body);
    res.status(201).json(slot);
  } catch (error) {
    res.status(400).json({ message: "Failed to create availability" });
  }
});

router.post("/bulk", requireAuth, async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) {
      return res.status(400).json({ message: "No availability data provided" });
    }

    const doctorNames = items
      .map((slot) => slot.doctorName)
      .filter(Boolean);
    const doctorDocs = doctorNames.length
      ? await Doctor.find({ name: { $in: doctorNames } })
      : [];
    const doctorByName = new Map(
      doctorDocs.map((doctor) => [doctor.name, doctor])
    );

    const missingDoctors = new Set();
    const writes = [];
    for (const slot of items) {
      const doctorId =
        slot.doctorId || doctorByName.get(slot.doctorName)?._id;
      if (!doctorId) {
        if (slot.doctorName) missingDoctors.add(slot.doctorName);
        continue;
      }

      writes.push({
        updateOne: {
          filter: {
            doctorId,
            day: slot.day,
            startTime: slot.startTime,
            endTime: slot.endTime
          },
          update: {
            $set: {
              doctorId,
              day: slot.day,
              startTime: slot.startTime,
              endTime: slot.endTime
            }
          },
          upsert: true
        }
      });
    }

    const result = writes.length
      ? await Availability.bulkWrite(writes)
      : null;
    res.json({
      ok: true,
      result,
      missingDoctors: [...missingDoctors]
    });
  } catch (error) {
    res.status(400).json({ message: "Failed to bulk upload availability" });
  }
});

router.put("/:id", requireAuth, async (req, res) => {
  try {
    const updated = await Availability.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    res.json(updated);
  } catch (error) {
    res.status(400).json({ message: "Failed to update availability" });
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    await Availability.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ message: "Failed to delete availability" });
  }
});

export default router;
