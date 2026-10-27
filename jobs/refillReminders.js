import RefillReminder from "../models/RefillReminder.js";
import { sendMail } from "../config/mailer.js";
import { appUrl } from "../config/appUrl.js";

const RUN_EVERY_MS = 60 * 60 * 1000;
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
const BATCH_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

const escapeHtml = (value) =>
  String(value || "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]);

// The checkout page reads `add=<id>:<qty>,…` and puts those items in the cart.
const reorderLink = (items) =>
  `${appUrl()}/medicine/checkout?add=${items.map((item) => `${item.medicineId}:${item.quantity}`).join(",")}`;

const sendReminderEmail = async (reminder) => {
  const name = reminder.customerName || "there";
  const link = reorderLink(reminder.items);
  const manageLink = `${appUrl()}/account?tab=reminders`;
  const list = reminder.items.map((item) => `• ${item.medicineName} × ${item.quantity}`).join("\n");

  await sendMail({
    to: reminder.customerEmail,
    subject: "Time to refill your medicines",
    text:
      `Hi ${name},\n\n` +
      `Your ${reminder.intervalDays}-day supply from DoctorShathi will run out in a few days:\n\n${list}\n\n` +
      `Reorder in one tap: ${link}\n\n` +
      `Change or stop these reminders: ${manageLink}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#121a17">
        <h2 style="color:#0f6a4e;margin-bottom:8px">Time to refill your medicines</h2>
        <p>Hi ${escapeHtml(name)},</p>
        <p>Your ${reminder.intervalDays}-day supply will run out in a few days:</p>
        <ul style="padding-left:18px;line-height:1.7">
          ${reminder.items.map((item) => `<li>${escapeHtml(item.medicineName)} × ${item.quantity}</li>`).join("")}
        </ul>
        <p style="margin:28px 0">
          <a href="${link}" style="background:#13835f;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:bold">Reorder now</a>
        </p>
        <p style="font-size:13px;color:#4f5b55">
          Prescription medicines still need a valid prescription at checkout.
          <a href="${manageLink}" style="color:#0f6a4e">Change or stop these reminders</a>.
        </p>
      </div>`
  });
};

export async function runDueReminders(now = new Date()) {
  const due = await RefillReminder.find({ active: true, nextRemindAt: { $lte: now } })
    .sort({ nextRemindAt: 1 })
    .limit(BATCH_SIZE)
    .lean();

  for (const reminder of due) {
    // Claim it first, so a second server instance running the same job skips it.
    const claimed = await RefillReminder.findOneAndUpdate(
      { _id: reminder._id, active: true, nextRemindAt: reminder.nextRemindAt },
      { $set: { nextRemindAt: new Date(now.getTime() + reminder.intervalDays * DAY_MS), lastSentAt: now } }
    );
    if (!claimed) continue;

    try {
      await sendReminderEmail(reminder);
    } catch (error) {
      console.error(`Refill reminder ${reminder._id} failed:`, error?.message || error);
      await RefillReminder.updateOne(
        { _id: reminder._id },
        { $set: { nextRemindAt: new Date(now.getTime() + RETRY_AFTER_MS), lastSentAt: reminder.lastSentAt || null } }
      );
    }
  }
}

export function startRefillReminderJob() {
  const run = () =>
    runDueReminders().catch((error) => console.error("Refill reminder job failed:", error?.message || error));
  run();
  setInterval(run, RUN_EVERY_MS).unref();
}
