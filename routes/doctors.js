import express from "express";
import Doctor from "../models/Doctor.js";
import Hospital from "../models/Hospital.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.get("/", async (_req, res) => {
  const doctors = await Doctor.find().populate("hospitalId").sort({
    createdAt: -1
  });
  res.json(doctors);
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const doctor = await Doctor.create(req.body);
    res.status(201).json(doctor);
  } catch (error) {
    res.status(400).json({ message: "Failed to create doctor" });
  }
});

router.post("/bulk", requireAuth, async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) {
      return res.status(400).json({ message: "No doctor data provided" });
    }

    const hospitalNames = items
      .map((doctor) => doctor.hospitalName)
      .filter(Boolean);
    const hospitalDocs = hospitalNames.length
      ? await Hospital.find({ name: { $in: hospitalNames } })
      : [];
    const hospitalByName = new Map(
      hospitalDocs.map((hospital) => [hospital.name, hospital])
    );

    const missingHospitals = new Set();
    const writes = [];
    for (const doctor of items) {
      const hospitalId =
        doctor.hospitalId || hospitalByName.get(doctor.hospitalName)?._id;
      if (!hospitalId) {
        if (doctor.hospitalName) missingHospitals.add(doctor.hospitalName);
        continue;
      }

      writes.push({
        updateOne: {
          filter: { name: doctor.name, hospitalId },
          update: {
            $set: {
              name: doctor.name,
              specialty: doctor.specialty,
              hospitalId,
              phone: doctor.phone || undefined,
              email: doctor.email || undefined,
              badge: doctor.badge || undefined
            }
          },
          upsert: true
        }
      });
    }

    const result = writes.length ? await Doctor.bulkWrite(writes) : null;
    res.json({
      ok: true,
      result,
      missingHospitals: [...missingHospitals]
    });
  } catch (error) {
    res.status(400).json({ message: "Failed to bulk upload doctors" });
  }
});

router.put("/:id", requireAuth, async (req, res) => {
  try {
    const updated = await Doctor.findByIdAndUpdate(req.params.id, req.body, {
      new: true
    });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ message: "Failed to update doctor" });
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    await Doctor.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ message: "Failed to delete doctor" });
  }
});

export default router;
