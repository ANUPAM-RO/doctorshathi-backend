import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse } from "csv-parse/sync";
import { connectDb } from "../config/db.js";
import Hospital from "../models/Hospital.js";
import Doctor from "../models/Doctor.js";
import Availability from "../models/Availability.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const csvDir = path.join(__dirname, "csv");
const hospitalsFile = path.join(csvDir, "hospitals.csv");
const doctorsFile = path.join(csvDir, "doctors.csv");
const availabilityFile = path.join(csvDir, "availability.csv");

const loadCsv = (filePath) => {
  const content = fs.readFileSync(filePath, "utf8");
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });
};

const parseServices = (value) =>
  value
    ? value
        .split("|")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

await connectDb(process.env.MONGO_URI);

const shouldClear = process.env.SEED_CLEAR === "true";
if (shouldClear) {
  await Hospital.deleteMany({});
  await Doctor.deleteMany({});
  await Availability.deleteMany({});
}

const hospitalsCsv = loadCsv(hospitalsFile);
const doctorsCsv = loadCsv(doctorsFile);
const availabilityCsv = loadCsv(availabilityFile);

await Hospital.bulkWrite(
  hospitalsCsv.map((hospital) => ({
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
          services: parseServices(hospital.services)
        }
      },
      upsert: true
    }
  }))
);

const hospitalDocs = await Hospital.find({
  name: { $in: hospitalsCsv.map((hospital) => hospital.name) }
});
const hospitalByName = new Map(
  hospitalDocs.map((hospital) => [hospital.name, hospital])
);

const doctorWrites = [];
const missingHospitals = new Set();
for (const doctor of doctorsCsv) {
  const hospital = hospitalByName.get(doctor.hospitalName);
  if (!hospital) {
    missingHospitals.add(doctor.hospitalName);
    continue;
  }
  doctorWrites.push({
    updateOne: {
      filter: { name: doctor.name, hospitalId: hospital._id },
      update: {
        $set: {
          name: doctor.name,
          specialty: doctor.specialty,
          hospitalId: hospital._id,
          phone: doctor.phone || undefined,
          email: doctor.email || undefined,
          badge: doctor.badge || undefined
        }
      },
      upsert: true
    }
  });
}

if (doctorWrites.length) {
  await Doctor.bulkWrite(doctorWrites);
}

const doctorDocs = await Doctor.find({
  name: { $in: doctorsCsv.map((doctor) => doctor.name) }
}).populate("hospitalId");
const doctorByName = new Map(
  doctorDocs.map((doctor) => [doctor.name, doctor])
);

const availabilityWrites = [];
const missingDoctors = new Set();
for (const slot of availabilityCsv) {
  const doctor = doctorByName.get(slot.doctorName);
  if (!doctor) {
    missingDoctors.add(slot.doctorName);
    continue;
  }
  availabilityWrites.push({
    updateOne: {
      filter: {
        doctorId: doctor._id,
        day: slot.day,
        startTime: slot.startTime,
        endTime: slot.endTime
      },
      update: {
        $set: {
          doctorId: doctor._id,
          day: slot.day,
          startTime: slot.startTime,
          endTime: slot.endTime
        }
      },
      upsert: true
    }
  });
}

if (availabilityWrites.length) {
  await Availability.bulkWrite(availabilityWrites);
}

if (missingHospitals.size) {
  console.warn("Missing hospitals for doctors:", [...missingHospitals]);
}
if (missingDoctors.size) {
  console.warn("Missing doctors for availability:", [...missingDoctors]);
}

console.log("CSV import complete.");
process.exit(0);
