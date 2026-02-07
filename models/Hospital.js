import mongoose from "mongoose";

const hospitalSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    address: { type: String, required: true },
    state: { type: String, required: true },
    district: { type: String, required: true },
    citySubdivision: { type: String, required: true },
    pinCode: { type: String, required: true },
    phone: { type: String },
    email: { type: String },
    services: [{ type: String }]
  },
  { timestamps: true }
);

export default mongoose.model("Hospital", hospitalSchema);
