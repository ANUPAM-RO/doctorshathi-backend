import mongoose from "mongoose";

export const REFILL_INTERVALS = [15, 30, 45, 60, 90];
// The reminder goes out this many days before the supply is expected to run out.
export const REMIND_DAYS_BEFORE = 3;

const reminderItemSchema = new mongoose.Schema(
  {
    medicineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Medicine",
      required: true
    },
    medicineName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 }
  },
  { _id: false }
);

const refillReminderSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true
    },
    customerEmail: { type: String, required: true, trim: true, lowercase: true },
    customerName: { type: String, trim: true },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true
    },
    items: { type: [reminderItemSchema], validate: (v) => Array.isArray(v) && v.length > 0 },
    intervalDays: { type: Number, enum: REFILL_INTERVALS, required: true },
    nextRemindAt: { type: Date, required: true },
    active: { type: Boolean, default: true },
    lastSentAt: { type: Date }
  },
  { timestamps: true }
);

refillReminderSchema.index({ customerId: 1, orderId: 1 }, { unique: true });
refillReminderSchema.index({ active: 1, nextRemindAt: 1 });

/** When the next email should go out for a supply that lasts `intervalDays` from `from`. */
export const nextReminderDate = (intervalDays, from = new Date()) =>
  new Date(from.getTime() + Math.max(1, intervalDays - REMIND_DAYS_BEFORE) * 24 * 60 * 60 * 1000);

export default mongoose.model("RefillReminder", refillReminderSchema);
