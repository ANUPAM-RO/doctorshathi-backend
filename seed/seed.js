import "dotenv/config";
import { connectDb } from "../config/db.js";
import Hospital from "../models/Hospital.js";
import Doctor from "../models/Doctor.js";
import Availability from "../models/Availability.js";
import Medicine from "../models/Medicine.js";
import { hospitals, doctors, availability, medicines } from "./data.js";

await connectDb(process.env.MONGO_URI);

await Hospital.deleteMany({});
await Doctor.deleteMany({});
await Availability.deleteMany({});
await Medicine.deleteMany({});

const hospitalDocs = await Hospital.insertMany(hospitals);
const hospitalByName = new Map(
  hospitalDocs.map((hospital) => [hospital.name, hospital])
);

const doctorDocs = await Doctor.insertMany(
  doctors.map((doctor) => ({
    name: doctor.name,
    specialty: doctor.specialty,
    hospitalId: hospitalByName.get(doctor.hospitalName)?._id,
    phone: doctor.phone,
    email: doctor.email,
    badge: doctor.badge
  }))
);

const doctorByName = new Map(
  doctorDocs.map((doctor) => [doctor.name, doctor])
);

await Availability.insertMany(
  availability.map((slot) => ({
    doctorId: doctorByName.get(slot.doctorName)?._id,
    day: slot.day,
    startTime: slot.startTime,
    endTime: slot.endTime
  }))
);

const buildDemoPrice = (index) => {
  const base = 35;
  const step = 12;
  return base + (index % 10) * step;
};

await Medicine.insertMany(
  medicines.map((medicine, index) => ({
    ...medicine,
    price:
      typeof medicine.price === "number" && Number.isFinite(medicine.price)
        ? medicine.price
        : buildDemoPrice(index)
  }))
);

console.log("Seed complete.");
process.exit(0);
