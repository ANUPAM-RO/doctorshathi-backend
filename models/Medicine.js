import mongoose from "mongoose";

const medicineSchema = new mongoose.Schema(
  {
    productType: {
      type: String,
      enum: ["medicine", "wellness"],
      default: "medicine"
    },
    name: { type: String, required: true },
    category: { type: String },
    description: { type: String },
    dosage: { type: String },
    manufacturer: { type: String },
    imageUrl: { type: String },
    images: { type: [String], default: [] },
    highlights: { type: [String], default: [] },
    details: { type: String },
    price: { type: Number, min: 0, default: 0 },
    stock: { type: Number, min: 0, default: 0 },
    prescriptionRequired: { type: Boolean, default: false }
  },
  { timestamps: true }
);

export default mongoose.model("Medicine", medicineSchema);
