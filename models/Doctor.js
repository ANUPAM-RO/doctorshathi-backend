import mongoose from "mongoose";

const doctorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    specialty: { type: String, required: true },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true
    },
    phone: { type: String },
    email: { type: String },
    badge: { type: String }
  },
  { timestamps: true }
);

export default mongoose.model("Doctor", doctorSchema);
