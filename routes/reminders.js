import express from "express";
import mongoose from "mongoose";
import Order from "../models/Order.js";
import RefillReminder, { REFILL_INTERVALS, nextReminderDate } from "../models/RefillReminder.js";
import { requireCustomerAuth } from "../middleware/auth.js";

const router = express.Router();

router.use(requireCustomerAuth);

const toResponse = (reminder) => ({
  id: reminder._id,
  orderId: reminder.orderId,
  items: reminder.items,
  intervalDays: reminder.intervalDays,
  nextRemindAt: reminder.nextRemindAt,
  active: reminder.active,
  lastSentAt: reminder.lastSentAt,
  createdAt: reminder.createdAt
});

const parseInterval = (value) => {
  const days = Number(value);
  return REFILL_INTERVALS.includes(days) ? days : null;
};

router.get("/", async (req, res) => {
  try {
    const reminders = await RefillReminder.find({ customerId: req.customerId }).sort({ createdAt: -1 }).lean();
    return res.json(reminders.map(toResponse));
  } catch (_error) {
    return res.status(500).json({ message: "Failed to load reminders" });
  }
});

// Creates (or updates) the reminder for one of the customer's orders.
router.post("/", async (req, res) => {
  try {
    const orderId = String(req.body?.orderId || "").trim();
    const intervalDays = parseInterval(req.body?.intervalDays);
    if (!mongoose.isValidObjectId(orderId)) {
      return res.status(400).json({ message: "A valid order is required." });
    }
    if (!intervalDays) {
      return res.status(400).json({ message: `Choose one of: ${REFILL_INTERVALS.join(", ")} days.` });
    }

    const order = await Order.findOne({ _id: orderId, customerId: req.customerId }).lean();
    if (!order) {
      return res.status(404).json({ message: "Order not found." });
    }
    if (order.status === "rejected") {
      return res.status(400).json({ message: "Reminders can't be set for a rejected order." });
    }

    const reminder = await RefillReminder.findOneAndUpdate(
      { customerId: req.customerId, orderId: order._id },
      {
        $set: {
          customerEmail: order.customerEmail,
          customerName: order.customerName,
          items: order.items.map((item) => ({
            medicineId: item.medicineId,
            medicineName: item.medicineName,
            quantity: item.quantity
          })),
          intervalDays,
          nextRemindAt: nextReminderDate(intervalDays),
          active: true
        }
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    return res.status(201).json(toResponse(reminder));
  } catch (_error) {
    return res.status(500).json({ message: "Failed to save reminder" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Reminder not found." });
    }
    const reminder = await RefillReminder.findOne({ _id: req.params.id, customerId: req.customerId });
    if (!reminder) {
      return res.status(404).json({ message: "Reminder not found." });
    }

    if (req.body?.intervalDays !== undefined) {
      const intervalDays = parseInterval(req.body.intervalDays);
      if (!intervalDays) {
        return res.status(400).json({ message: `Choose one of: ${REFILL_INTERVALS.join(", ")} days.` });
      }
      reminder.intervalDays = intervalDays;
      reminder.nextRemindAt = nextReminderDate(intervalDays);
    }
    if (typeof req.body?.active === "boolean") {
      // Resuming starts a fresh cycle instead of firing for the paused period.
      if (req.body.active && !reminder.active) {
        reminder.nextRemindAt = nextReminderDate(reminder.intervalDays);
      }
      reminder.active = req.body.active;
    }

    await reminder.save();
    return res.json(toResponse(reminder));
  } catch (_error) {
    return res.status(500).json({ message: "Failed to update reminder" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Reminder not found." });
    }
    const result = await RefillReminder.deleteOne({ _id: req.params.id, customerId: req.customerId });
    if (!result.deletedCount) {
      return res.status(404).json({ message: "Reminder not found." });
    }
    return res.json({ ok: true });
  } catch (_error) {
    return res.status(500).json({ message: "Failed to delete reminder" });
  }
});

export default router;
