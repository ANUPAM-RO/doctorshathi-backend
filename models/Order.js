import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema(
  {
    medicineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Medicine",
      required: true
    },
    medicineName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    prescriptionRequired: { type: Boolean, default: false }
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    customerName: { type: String, required: true, trim: true },
    customerEmail: { type: String, required: true, trim: true, lowercase: true },
    customerPhone: { type: String, trim: true },
    shippingAddress: { type: String, trim: true },
    address: {
      line1: { type: String, trim: true },
      line2: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      pincode: { type: String, trim: true }
    },
    paymentMethod: {
      type: String,
      enum: ["cod", "upi", "card"],
      default: "cod"
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "shipped"],
      default: "pending"
    },
    verificationNote: { type: String, trim: true },
    items: { type: [orderItemSchema], validate: (v) => Array.isArray(v) && v.length > 0 },
    totalAmount: { type: Number, min: 0, required: true },
    requiresPrescription: { type: Boolean, default: false },
    prescriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Prescription",
      default: null
    }
  },
  { timestamps: true }
);

export default mongoose.model("Order", orderSchema);
