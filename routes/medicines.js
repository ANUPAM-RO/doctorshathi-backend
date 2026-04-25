import express from "express";
import crypto from "node:crypto";
import OpenAI from "openai";
import mongoose from "mongoose";
import Medicine from "../models/Medicine.js";
import Prescription from "../models/Prescription.js";
import Order from "../models/Order.js";
import { requireAuth, requireCustomerAuth } from "../middleware/auth.js";

const router = express.Router();
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const openaiClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBoolean = (value) => {
  if (typeof value === "boolean") return value;
  const text = String(value || "").trim().toLowerCase();
  return text === "true" || text === "1" || text === "yes";
};

const normalizeStringList = (value) => {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
};

const normalizeMedicineItems = (items) =>
  (Array.isArray(items) ? items : [])
    .map((item) => ({
      medicineId: String(item?.medicineId || item?.id || item?._id || "").trim(),
      quantity: Math.max(1, Math.floor(toNumber(item?.quantity, 1)))
    }))
    .filter(
      (item) => item.medicineId && mongoose.isValidObjectId(item.medicineId)
    );

const mergeCartItems = (items, medicineId, quantity = 1) => {
  const nextQuantity = Math.max(1, Math.floor(toNumber(quantity, 1)));
  const existing = items.find((item) => item.medicineId === medicineId);

  if (!existing) {
    return [...items, { medicineId, quantity: nextQuantity }];
  }

  return items.map((item) =>
    item.medicineId === medicineId
      ? { ...item, quantity: item.quantity + nextQuantity }
      : item
  );
};

const buildCheckoutSummary = async (items) => {
  const normalizedItems = normalizeMedicineItems(items);
  if (!normalizedItems.length) {
    return {
      ok: false,
      status: 400,
      body: { message: "Valid medicine items are required." }
    };
  }

  const medicineDocs = await Medicine.find({
    _id: { $in: normalizedItems.map((item) => item.medicineId) }
  });
  const medicineMap = new Map(medicineDocs.map((med) => [String(med._id), med]));

  const checkoutItems = [];
  let totalAmount = 0;
  let requiresPrescription = false;

  for (const item of normalizedItems) {
    const medicine = medicineMap.get(item.medicineId);
    if (!medicine) {
      return {
        ok: false,
        status: 404,
        body: { message: `Medicine not found: ${item.medicineId}` }
      };
    }

    const unitPrice = toNumber(medicine.price, 0);
    const stock = Math.max(0, Math.floor(toNumber(medicine.stock, 0)));
    if (stock > 0 && item.quantity > stock) {
      return {
        ok: false,
        status: 400,
        body: { message: `Only ${stock} units available for ${medicine.name}.` }
      };
    }

    const subtotal = unitPrice * item.quantity;
    const prescriptionRequired = Boolean(medicine.prescriptionRequired);

    totalAmount += subtotal;
    requiresPrescription = requiresPrescription || prescriptionRequired;

    checkoutItems.push({
      medicineId: medicine._id,
      medicineName: medicine.name,
      quantity: item.quantity,
      unitPrice,
      subtotal,
      stock,
      productType: medicine.productType,
      category: medicine.category,
      imageUrl: medicine.imageUrl || medicine.images?.[0] || "",
      prescriptionRequired
    });
  }

  return {
    ok: true,
    status: 200,
    body: {
      items: checkoutItems,
      totalItems: checkoutItems.reduce((sum, item) => sum + item.quantity, 0),
      totalAmount,
      requiresPrescription
    }
  };
};

const createRazorpayGatewayOrder = async ({ amount, receipt, notes }) => {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return {
      ok: false,
      status: 500,
      body: { message: "Razorpay keys are not configured." }
    };
  }

  const response = await fetch(`${RAZORPAY_API_BASE}/orders`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString(
        "base64"
      )}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      amount,
      currency: "INR",
      receipt,
      payment_capture: 1,
      notes
    })
  });

  const data = await response.json();
  if (!response.ok) {
    return {
      ok: false,
      status: response.status || 500,
      body: {
        message: data?.error?.description || data?.error?.reason || "Failed to create Razorpay order."
      }
    };
  }

  return { ok: true, status: 200, body: data };
};

const verifyRazorpaySignature = ({ orderId, paymentId, signature }) => {
  if (!RAZORPAY_KEY_SECRET) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
  .digest("hex");
  return expected === signature;
};

const prepareCheckoutOrder = async (body) => {
  const customerName = String(body?.customerName || "").trim();
  const customerEmail = String(body?.customerEmail || "")
    .trim()
    .toLowerCase();
  const customerPhone = String(body?.customerPhone || "").trim();
  const shippingAddress = String(body?.shippingAddress || "").trim();
  const address = body?.address || {};
  const paymentMethod = String(body?.paymentMethod || "cod")
    .trim()
    .toLowerCase();
  const items = Array.isArray(body?.items) ? body.items : [];
  const prescriptionInput = body?.prescription || null;

  if (!customerName || !customerEmail || !items.length) {
    return {
      ok: false,
      status: 400,
      body: { message: "customerName, customerEmail and items are required." }
    };
  }

  const checkoutSummary = await buildCheckoutSummary(items);
  if (!checkoutSummary.ok) {
    return checkoutSummary;
  }

  const orderItems = checkoutSummary.body.items.map((item) => ({
    medicineId: item.medicineId,
    medicineName: item.medicineName,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    prescriptionRequired: item.prescriptionRequired
  }));
  const totalAmount = checkoutSummary.body.totalAmount;
  const requiresPrescription = checkoutSummary.body.requiresPrescription;

  let prescriptionId = null;
  if (requiresPrescription) {
    if (!prescriptionInput || !String(prescriptionInput.fileData || "").trim()) {
      return {
        ok: false,
        status: 400,
        body: {
          message:
            "Prescription upload is required for restricted medicines. Include prescription.fileData."
        }
      };
    }

    const prescription = await Prescription.create({
      patientName: String(prescriptionInput.patientName || customerName).trim(),
      patientEmail: String(prescriptionInput.patientEmail || customerEmail)
        .trim()
        .toLowerCase(),
      notes: String(prescriptionInput.notes || "").trim(),
      fileName: String(prescriptionInput.fileName || "").trim(),
      mimeType: String(prescriptionInput.mimeType || "").trim(),
      sizeBytes: Math.max(0, Math.floor(toNumber(prescriptionInput.sizeBytes, 0))),
      fileData: String(prescriptionInput.fileData || "")
    });
    prescriptionId = prescription._id;
  }

  return {
    ok: true,
    status: 200,
    body: {
      customerName,
      customerEmail,
      customerPhone,
      shippingAddress,
      address: {
        line1: String(address.line1 || "").trim(),
        line2: String(address.line2 || "").trim(),
        city: String(address.city || "").trim(),
        state: String(address.state || "").trim(),
        pincode: String(address.pincode || "").trim()
      },
      paymentMethod,
      orderItems,
      totalAmount,
      requiresPrescription,
      prescriptionId
    }
  };
};

const generateFallbackPrescriptionHelp = (text) => {
  const lines = [];
  if (!text) {
    return "Share prescription text for a concise explanation of dosage and medicine purpose.";
  }
  lines.push("This is an informational summary, not a diagnosis.");
  if (/bd|twice/i.test(text)) {
    lines.push("Detected frequency hint: likely twice daily dosing.");
  }
  if (/od|once/i.test(text)) {
    lines.push("Detected frequency hint: likely once daily dosing.");
  }
  if (/after food|after meal/i.test(text)) {
    lines.push("Detected guidance: take after food.");
  }
  if (/fever|pain|infection/i.test(text)) {
    lines.push("Detected likely symptom focus in the prescription notes.");
  }
  if (lines.length === 1) {
    lines.push("Please verify dosage timing and duration directly with your doctor.");
  }
  return lines.join(" ");
};

const parseLlmJson = (content) => {
  if (!content) return null;
  const trimmed = content.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch (_innerError) {
      return null;
    }
  }
};

router.get("/", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const filter = q
    ? {
        $or: [
          { name: new RegExp(q, "i") },
          { category: new RegExp(q, "i") },
          { description: new RegExp(q, "i") },
          { dosage: new RegExp(q, "i") }
        ]
      }
    : {};
  const meds = await Medicine.find(filter).sort({ createdAt: -1 }).limit(100);
  res.json(meds);
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const med = await Medicine.create({
      ...req.body,
      productType: req.body.productType === "wellness" ? "wellness" : "medicine",
      imageUrl: req.body.imageUrl || undefined,
      images: normalizeStringList(req.body.images),
      highlights: normalizeStringList(req.body.highlights),
      details: req.body.details || undefined,
      price: toNumber(req.body.price, 0),
      stock: Math.max(0, Math.floor(toNumber(req.body.stock, 0))),
      prescriptionRequired: toBoolean(req.body.prescriptionRequired)
    });
    res.status(201).json(med);
  } catch (error) {
    res.status(400).json({ message: "Failed to create medicine" });
  }
});

router.post("/bulk", requireAuth, async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) {
      return res.status(400).json({ message: "No medicine data provided" });
    }

    const writes = items.map((med) => ({
      updateOne: {
        filter: { name: med.name },
        update: {
          $set: {
            name: med.name,
            productType: med.productType === "wellness" ? "wellness" : "medicine",
            category: med.category || undefined,
            description: med.description || undefined,
            dosage: med.dosage || undefined,
            manufacturer: med.manufacturer || undefined,
            imageUrl: med.imageUrl || undefined,
            images: normalizeStringList(med.images),
            highlights: normalizeStringList(med.highlights),
            details: med.details || undefined,
            price: toNumber(med.price, 0),
            stock: Math.max(0, Math.floor(toNumber(med.stock, 0))),
            prescriptionRequired: toBoolean(med.prescriptionRequired)
          }
        },
        upsert: true
      }
    }));

    const result = await Medicine.bulkWrite(writes);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(400).json({ message: "Failed to bulk upload medicines" });
  }
});

router.get("/smart-search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) {
      return res.status(400).json({ message: "Query is required." });
    }

    const match = {
      $or: [
        { name: new RegExp(q, "i") },
        { category: new RegExp(q, "i") },
        { description: new RegExp(q, "i") }
      ]
    };
    const medicines = await Medicine.find(match).limit(12).sort({ stock: -1, createdAt: -1 });
    return res.json({ query: q, medicines });
  } catch (_error) {
    return res.status(500).json({ message: "Smart search failed" });
  }
});

router.post("/cart/items", async (req, res) => {
  try {
    const summary = await buildCheckoutSummary(req.body?.items);
    return res.status(summary.status).json(summary.body);
  } catch (_error) {
    return res.status(500).json({ message: "Failed to prepare cart items" });
  }
});

router.post("/cart/add", async (req, res) => {
  try {
    const medicineId = String(req.body?.medicineId || "").trim();
    if (!medicineId || !mongoose.isValidObjectId(medicineId)) {
      return res.status(400).json({ message: "Valid medicineId is required." });
    }

    const nextItems = mergeCartItems(
      normalizeMedicineItems(req.body?.items),
      medicineId,
      req.body?.quantity
    );
    const summary = await buildCheckoutSummary(nextItems);
    return res.status(summary.status).json(summary.body);
  } catch (_error) {
    return res.status(500).json({ message: "Failed to add medicine to cart" });
  }
});

router.post("/ai/prescription-explain", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) {
      return res.status(400).json({ message: "Prescription text is required." });
    }

    if (!openaiClient) {
      return res.json({
        explanation: generateFallbackPrescriptionHelp(text),
        warning: "OPENAI_API_KEY not configured. Returned rule-based explanation."
      });
    }

    const response = await openaiClient.responses.create({
      model: DEFAULT_MODEL,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "You are a pharmacy assistant. Explain prescriptions in plain language. Do not diagnose. Return concise JSON."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Prescription text:\n${text}\n\nReturn strict JSON with keys: medicines (array of strings), dosageSummary (string), possibleSideEffects (array of strings), safetyNote (string).`
            }
          ]
        }
      ],
      text: { format: { type: "json_object" } }
    });

    const parsed = parseLlmJson(response.output_text || "");
    if (!parsed || typeof parsed !== "object") {
      return res.json({
        explanation: generateFallbackPrescriptionHelp(text),
        warning: "AI response was not parseable. Returned rule-based explanation."
      });
    }

    return res.json(parsed);
  } catch (_error) {
    return res.status(500).json({ message: "Failed to explain prescription" });
  }
});

router.post("/ai/check-interactions", async (req, res) => {
  try {
    const medicines = Array.isArray(req.body?.medicines)
      ? req.body.medicines.map((m) => String(m || "").trim()).filter(Boolean)
      : [];
    const allergies = Array.isArray(req.body?.allergies)
      ? req.body.allergies.map((a) => String(a || "").trim()).filter(Boolean)
      : [];

    if (medicines.length < 2) {
      return res.status(400).json({ message: "Add at least two medicines." });
    }

    if (!openaiClient) {
      return res.json({
        riskLevel: "unknown",
        warnings: ["AI interaction checker unavailable without OPENAI_API_KEY."],
        recommendation: "Consult a licensed pharmacist before combining medicines."
      });
    }

    const response = await openaiClient.responses.create({
      model: DEFAULT_MODEL,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "You are a drug safety assistant. Provide cautious informational guidance only. Return strict JSON."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Medicines: ${medicines.join(", ")}
Allergies: ${allergies.join(", ") || "none"}
Return strict JSON with keys: riskLevel ("low"|"moderate"|"high"|"unknown"), warnings (array of strings), recommendation (string).`
            }
          ]
        }
      ],
      text: { format: { type: "json_object" } }
    });

    const parsed = parseLlmJson(response.output_text || "");
    if (!parsed || typeof parsed !== "object") {
      return res.json({
        riskLevel: "unknown",
        warnings: ["Could not parse AI interaction output."],
        recommendation: "Consult a licensed pharmacist before combining medicines."
      });
    }
    return res.json(parsed);
  } catch (_error) {
    return res.status(500).json({ message: "Interaction check failed" });
  }
});

router.post("/orders", requireCustomerAuth, async (req, res) => {
  try {
    const prepared = await prepareCheckoutOrder(req.body);
    if (!prepared.ok) {
      return res.status(prepared.status).json(prepared.body);
    }

    const {
      customerName,
      customerEmail,
      customerPhone,
      shippingAddress,
      address,
      paymentMethod,
      orderItems,
      totalAmount,
      requiresPrescription,
      prescriptionId
    } = prepared.body;

    if (!["cod", "upi", "card"].includes(paymentMethod)) {
      return res.status(400).json({
        message: "Manual order creation only supports cod, upi, or card."
      });
    }

    const order = await Order.create({
      customerName,
      customerEmail,
      customerPhone,
      customerId: req.customerId,
      shippingAddress,
      address,
      paymentMethod,
      paymentStatus: "pending",
      status: requiresPrescription ? "pending" : "approved",
      items: orderItems,
      totalAmount,
      requiresPrescription,
      prescriptionId
    });

    return res.status(201).json({
      orderId: order._id,
      status: order.status,
      totalAmount: order.totalAmount,
      requiresPrescription: order.requiresPrescription,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus
    });
  } catch (_error) {
    return res.status(500).json({ message: "Failed to create order" });
  }
});

router.post("/orders/razorpay/create", requireCustomerAuth, async (req, res) => {
  try {
    const prepared = await prepareCheckoutOrder(req.body);
    if (!prepared.ok) {
      return res.status(prepared.status).json(prepared.body);
    }

    const {
      customerName,
      customerEmail,
      customerPhone,
      shippingAddress,
      address,
      paymentMethod,
      orderItems,
      totalAmount,
      requiresPrescription,
      prescriptionId
    } = prepared.body;

    if (!["upi", "razorpay"].includes(paymentMethod)) {
      return res.status(400).json({
        message: "Razorpay checkout is only for upi or razorpay payment methods."
      });
    }

    const localOrder = await Order.create({
      customerName,
      customerEmail,
      customerPhone,
      customerId: req.customerId,
      shippingAddress,
      address,
      paymentMethod,
      paymentStatus: "pending",
      status: "pending",
      items: orderItems,
      totalAmount,
      requiresPrescription,
      prescriptionId
    });

    const gatewayOrder = await createRazorpayGatewayOrder({
      amount: Math.round(totalAmount * 100),
      receipt: `order_${String(localOrder._id)}`,
      notes: {
        localOrderId: String(localOrder._id),
        customerEmail,
        customerName,
        paymentMethod,
        requiresPrescription: String(requiresPrescription)
      }
    });

    if (!gatewayOrder.ok) {
      await Order.findByIdAndUpdate(localOrder._id, {
        paymentStatus: "failed",
        verificationNote: gatewayOrder.body?.message || "Failed to create Razorpay order."
      });
      return res.status(gatewayOrder.status).json(gatewayOrder.body);
    }

    await Order.findByIdAndUpdate(localOrder._id, {
      razorpayOrderId: gatewayOrder.body.id
    });

    return res.status(201).json({
      orderId: localOrder._id,
      razorpayOrderId: gatewayOrder.body.id,
      razorpayKeyId: RAZORPAY_KEY_ID,
      amount: totalAmount,
      currency: gatewayOrder.body.currency || "INR",
      status: localOrder.status,
      paymentStatus: "pending",
      paymentMethod: localOrder.paymentMethod
    });
  } catch (_error) {
    return res.status(500).json({ message: "Failed to initialize Razorpay checkout" });
  }
});

router.post("/orders/razorpay/verify", requireCustomerAuth, async (req, res) => {
  try {
    const orderId = String(req.body?.orderId || "").trim();
    const razorpayOrderId = String(req.body?.razorpayOrderId || "").trim();
    const razorpayPaymentId = String(req.body?.razorpayPaymentId || "").trim();
    const razorpaySignature = String(req.body?.razorpaySignature || "").trim();

    if (
      !orderId ||
      !mongoose.isValidObjectId(orderId) ||
      !razorpayOrderId ||
      !razorpayPaymentId ||
      !razorpaySignature
    ) {
      return res.status(400).json({
        message: "orderId, razorpayOrderId, razorpayPaymentId and razorpaySignature are required."
      });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found." });
    }

    if (order.customerId && String(order.customerId) !== String(req.customerId)) {
      return res.status(403).json({ message: "You cannot verify another customer's order." });
    }

    if (order.razorpayOrderId && order.razorpayOrderId !== razorpayOrderId) {
      return res.status(400).json({ message: "Razorpay order id does not match." });
    }

    const validSignature = verifyRazorpaySignature({
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      signature: razorpaySignature
    });

    if (!validSignature) {
      await Order.findByIdAndUpdate(orderId, {
        paymentStatus: "failed",
        verificationNote: "Razorpay signature verification failed."
      });
      return res.status(400).json({ message: "Payment verification failed." });
    }

    const updated = await Order.findByIdAndUpdate(
      orderId,
      {
        paymentStatus: "paid",
        status: order.requiresPrescription ? "pending" : "approved",
        razorpayOrderId,
        razorpayPaymentId,
        razorpaySignature
      },
      { new: true }
    );

    return res.json({
      orderId: updated._id,
      status: updated.status,
      paymentStatus: updated.paymentStatus,
      paymentMethod: updated.paymentMethod,
      razorpayPaymentId: updated.razorpayPaymentId
    });
  } catch (_error) {
    return res.status(500).json({ message: "Failed to verify Razorpay payment" });
  }
});

router.get("/orders/track", async (req, res) => {
  try {
    const orderId = String(req.query.orderId || "").trim();
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();

    if (!orderId || !mongoose.isValidObjectId(orderId) || !email) {
      return res.status(400).json({ message: "orderId and email are required." });
    }

    const order = await Order.findOne({ _id: orderId, customerEmail: email }).lean();
    if (!order) {
      return res.status(404).json({ message: "Order not found." });
    }

    return res.json({
      orderId: order._id,
      status: order.status,
      totalAmount: order.totalAmount,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: order.razorpayPaymentId,
      requiresPrescription: order.requiresPrescription,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt
    });
  } catch (_error) {
    return res.status(500).json({ message: "Failed to track order" });
  }
});

router.get("/orders", requireAuth, async (_req, res) => {
  try {
    const orders = await Order.find()
      .populate("prescriptionId")
      .sort({ createdAt: -1 })
      .limit(200);
    return res.json(orders);
  } catch (_error) {
    return res.status(500).json({ message: "Failed to fetch orders" });
  }
});

router.get("/customer/orders", requireCustomerAuth, async (req, res) => {
  try {
    const orders = await Order.find({ customerId: req.customerId })
      .populate("prescriptionId")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    return res.json(
      orders.map((order) => ({
        id: order._id,
        customerName: order.customerName,
        customerEmail: order.customerEmail,
        customerPhone: order.customerPhone,
        shippingAddress: order.shippingAddress,
        address: order.address,
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        status: order.status,
        totalAmount: order.totalAmount,
        requiresPrescription: order.requiresPrescription,
        items: order.items,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        razorpayOrderId: order.razorpayOrderId,
        razorpayPaymentId: order.razorpayPaymentId
      }))
    );
  } catch (_error) {
    return res.status(500).json({ message: "Failed to fetch customer orders" });
  }
});

router.patch("/orders/:id/verify", requireAuth, async (req, res) => {
  try {
    const action = String(req.body?.action || "").trim().toLowerCase();
    const note = String(req.body?.note || "").trim();
    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({ message: "Action must be approve or reject." });
    }

    const status = action === "approve" ? "approved" : "rejected";
    const updated = await Order.findByIdAndUpdate(
      req.params.id,
      { status, verificationNote: note || undefined },
      { new: true }
    );
    if (!updated) {
      return res.status(404).json({ message: "Order not found." });
    }
    return res.json(updated);
  } catch (_error) {
    return res.status(500).json({ message: "Failed to verify order" });
  }
});

router.patch("/orders/:id/status", requireAuth, async (req, res) => {
  try {
    const status = String(req.body?.status || "").trim().toLowerCase();
    if (!["pending", "approved", "rejected", "shipped"].includes(status)) {
      return res.status(400).json({ message: "Invalid status value." });
    }
    const updated = await Order.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );
    if (!updated) {
      return res.status(404).json({ message: "Order not found." });
    }
    return res.json(updated);
  } catch (_error) {
    return res.status(500).json({ message: "Failed to update order status" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid medicine id." });
    }
    const medicine = await Medicine.findById(req.params.id);
    if (!medicine) {
      return res.status(404).json({ message: "Medicine not found." });
    }
    return res.json(medicine);
  } catch (_error) {
    return res.status(500).json({ message: "Failed to load medicine." });
  }
});

router.put("/:id", requireAuth, async (req, res) => {
  try {
    const payload = {
      ...req.body
    };
    if (req.body.price !== undefined) {
      payload.price = toNumber(req.body.price, 0);
    }
    if (req.body.stock !== undefined) {
      payload.stock = Math.max(0, Math.floor(toNumber(req.body.stock, 0)));
    }
    if (req.body.prescriptionRequired !== undefined) {
      payload.prescriptionRequired = toBoolean(req.body.prescriptionRequired);
    }
    if (req.body.productType !== undefined) {
      payload.productType = req.body.productType === "wellness" ? "wellness" : "medicine";
    }
    if (req.body.images !== undefined) {
      payload.images = normalizeStringList(req.body.images);
    }
    if (req.body.highlights !== undefined) {
      payload.highlights = normalizeStringList(req.body.highlights);
    }

    const updated = await Medicine.findByIdAndUpdate(req.params.id, payload, {
      new: true
    });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ message: "Failed to update medicine" });
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    await Medicine.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ message: "Failed to delete medicine" });
  }
});

export default router;
