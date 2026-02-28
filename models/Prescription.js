import mongoose from "mongoose";

const prescriptionSchema = new mongoose.Schema(
  {
    patientName: { type: String, trim: true },
    patientEmail: { type: String, trim: true, lowercase: true },
    notes: { type: String, trim: true },
    fileName: { type: String, trim: true },
    mimeType: { type: String, trim: true },
    sizeBytes: { type: Number, min: 0 },
    fileData: { type: String }
  },
  { timestamps: true }
);

export default mongoose.model("Prescription", prescriptionSchema);
