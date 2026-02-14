import express from "express";
import Hospital from "../models/Hospital.js";
import Doctor from "../models/Doctor.js";
import Availability from "../models/Availability.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const rawQuery = (req.query.q || "").trim();
    const dayFilter = (req.query.day || "").trim();
    const doctorFilter = (req.query.doctor || "").trim();
    const departmentFilter = (req.query.department || "").trim();
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "6", 10), 1), 50);
    const skip = (page - 1) * limit;
    const regex = rawQuery ? new RegExp(rawQuery, "i") : null;

    const hospitalFilter = regex ? { name: regex } : {};
    const hospitals = await Hospital.find(hospitalFilter)
      .sort({ createdAt: -1 })
      .limit(12);

    const hospitalIds = hospitals.map((hospital) => hospital._id);
    const baseDoctorFilter = regex
      ? {
          $or: [
            { name: regex },
            { specialty: regex },
            { hospitalId: { $in: hospitalIds } }
          ]
        }
      : {};

    const baseDoctorIds = await Doctor.distinct("_id", baseDoctorFilter);
    const weekdayOptions = baseDoctorIds.length
      ? await Availability.distinct("day", { doctorId: { $in: baseDoctorIds } })
      : [];
    const doctorOptions = await Doctor.distinct("name", baseDoctorFilter);
    const departmentOptions = await Doctor.distinct("specialty", baseDoctorFilter);

    const finalDoctorFilter = {
      ...baseDoctorFilter
    };

    if (doctorFilter) {
      finalDoctorFilter.name = new RegExp(`^${doctorFilter}$`, "i");
    }
    if (departmentFilter) {
      finalDoctorFilter.specialty = new RegExp(`^${departmentFilter}$`, "i");
    }
    if (dayFilter) {
      const dayDoctorIds = await Availability.distinct("doctorId", {
        day: dayFilter
      });
      finalDoctorFilter._id = { $in: dayDoctorIds };
    }

    const totalDoctors = await Doctor.countDocuments(finalDoctorFilter);
    const doctors = await Doctor.find(finalDoctorFilter)
      .populate("hospitalId")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const doctorIds = doctors.map((doctor) => doctor._id);
    const availability = await Availability.find(
      dayFilter
        ? { doctorId: { $in: doctorIds }, day: dayFilter }
        : { doctorId: { $in: doctorIds } }
    ).sort({ day: 1 });

    const availabilityByDoctor = availability.reduce((acc, slot) => {
      const key = slot.doctorId.toString();
      if (!acc[key]) acc[key] = [];
      acc[key].push(slot);
      return acc;
    }, {});

    const doctorsWithAvailability = doctors.map((doctor) => ({
      ...doctor.toObject(),
      availability: availabilityByDoctor[doctor._id.toString()] || []
    }));

    res.json({
      query: rawQuery,
      appliedFilters: {
        day: dayFilter || null,
        doctor: doctorFilter || null,
        department: departmentFilter || null
      },
      filters: {
        weekdays: weekdayOptions.sort(),
        doctors: doctorOptions.sort((a, b) => a.localeCompare(b)),
        departments: departmentOptions.sort((a, b) => a.localeCompare(b))
      },
      hospitals,
      doctors: doctorsWithAvailability,
      pagination: {
        page,
        limit,
        total: totalDoctors,
        totalPages: Math.ceil(totalDoctors / limit) || 1
      }
    });
  } catch (error) {
    res.status(500).json({ message: "Search failed" });
  }
});

export default router;
