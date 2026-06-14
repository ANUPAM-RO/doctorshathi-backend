import mongoose from "mongoose";

const adminSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true },
    passwordHash: { type: String, required: true },
    role: { type: String, default: "admin", enum: ["admin", "superadmin", "moderator"] }
  },
  { timestamps: true }
);

export default mongoose.model("Admin", adminSchema);
