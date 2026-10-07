import mongoose from "mongoose";

const addressSchema = new mongoose.Schema(
  {
    label: { type: String, enum: ["home", "work", "other"], default: "home" },
    fullName: { type: String, trim: true },
    phone: { type: String, trim: true },
    line1: { type: String, trim: true, required: true },
    line2: { type: String, trim: true },
    landmark: { type: String, trim: true },
    city: { type: String, trim: true, required: true },
    state: { type: String, trim: true, required: true },
    pincode: { type: String, trim: true, required: true },
    isDefault: { type: Boolean, default: false }
  },
  { timestamps: true }
);

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    gender: { type: String, enum: ["", "male", "female", "other"], default: "" },
    dateOfBirth: { type: Date },
    addresses: { type: [addressSchema], default: [] },
    // Mirrors the default entry in `addresses`; kept for older clients.
    defaultAddress: {
      line1: { type: String, trim: true },
      line2: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      pincode: { type: String, trim: true }
    },
    passwordHash: { type: String, required: true },
    // Sessions (JWTs) issued before this moment are rejected, so a password change logs out other devices.
    passwordChangedAt: { type: Date },
    // Only a SHA-256 hash of the emailed reset token is stored.
    resetPasswordTokenHash: { type: String, select: false },
    resetPasswordExpires: { type: Date, select: false }
  },
  { timestamps: true }
);

export default mongoose.model("Customer", customerSchema);
