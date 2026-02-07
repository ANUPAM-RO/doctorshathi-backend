import mongoose from "mongoose";

const medicineSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    category: { type: String },
    description: { type: String },
    dosage: { type: String },
    manufacturer: { type: String }
  },
  { timestamps: true }
);

export default mongoose.model("Medicine", medicineSchema);
