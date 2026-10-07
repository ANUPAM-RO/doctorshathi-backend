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
// Delivery is free unless DELIVERY_FEE is set; FREE_DELIVERY_ABOVE waives it for larger carts.
const DELIVERY_FEE = Math.max(0, Number(process.env.DELIVERY_FEE) || 0);
const FREE_DELIVERY_ABOVE = Math.max(0, Number(process.env.FREE_DELIVERY_ABOVE) || 0);

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

const roundMoney = (value) => Math.round(value * 100) / 100;

const computeDeliveryFee = (itemsTotal) => {
  if (itemsTotal <= 0 || DELIVERY_FEE <= 0) return 0;
  if (FREE_DELIVERY_ABOVE > 0 && itemsTotal >= FREE_DELIVERY_ABOVE) return 0;
  return DELIVERY_FEE;
};

/**
 * Prices the cart from the database. In strict mode (placing an order) any missing
 * or unavailable item is an error; otherwise such items are dropped or flagged so
 * the cart page can still render and let the shopper fix them.
 */
const buildCheckoutSummary = async (items, { strict = true } = {}) => {
  const normalizedItems = normalizeMedicineItems(items);
  if (!normalizedItems.length) {
    return strict
      ? { ok: false, status: 400, body: { message: "Valid medicine items are required." } }
      : {
          ok: true,
          status: 200,
          body: {
            items: [],
            totalItems: 0,
            itemsTotal: 0,
            mrpTotal: 0,
            savings: 0,
            deliveryFee: 0,
            freeDeliveryAbove: FREE_DELIVERY_ABOVE,
            totalAmount: 0,
            requiresPrescription: false,
            hasUnavailableItems: false
          }
        };
  }

  const medicineDocs = await Medicine.find({
    _id: { $in: normalizedItems.map((item) => item.medicineId) }
  });
  const medicineMap = new Map(medicineDocs.map((med) => [String(med._id), med]));

  const checkoutItems = [];
  let itemsTotal = 0;
  let mrpTotal = 0;
  let requiresPrescription = false;
  let hasUnavailableItems = false;

  for (const item of normalizedItems) {
    const medicine = medicineMap.get(item.medicineId);
    if (!medicine) {
      if (strict) {
        return {
          ok: false,
          status: 404,
          body: { message: "An item in your cart is no longer available. Please review your cart." }
        };
      }
      continue;
    }

    const unitPrice = toNumber(medicine.price, 0);
    const mrp = Math.max(unitPrice, toNumber(medicine.mrp, unitPrice));
    const stock = Math.max(0, Math.floor(toNumber(medicine.stock, 0)));
    const available = stock > 0 && item.quantity <= stock;

    if (!available) {
      if (strict) {
        return {
          ok: false,
          status: 409,
          body: {
            message:
              stock <= 0
                ? `${medicine.name} is out of stock.`
                : `Only ${stock} units available for ${medicine.name}.`
          }
        };
      }
      hasUnavailableItems = true;
    }

    const subtotal = roundMoney(unitPrice * item.quantity);
    const prescriptionRequired = Boolean(medicine.prescriptionRequired);

    // Unavailable items stay visible in the cart but are not billed.
    if (available) {
      itemsTotal += subtotal;
      mrpTotal += mrp * item.quantity;
    }
    requiresPrescription = requiresPrescription || prescriptionRequired;

    checkoutItems.push({
      medicineId: medicine._id,
      medicineName: medicine.name,
      quantity: item.quantity,
      unitPrice,
      mrp,
      subtotal,
      stock,
      available,
      productType: medicine.productType,
      category: medicine.category,
      manufacturer: medicine.manufacturer,
      dosage: medicine.dosage,
      imageUrl: medicine.imageUrl || medicine.images?.[0] || "",
      prescriptionRequired
    });
  }

  itemsTotal = roundMoney(itemsTotal);
  mrpTotal = roundMoney(mrpTotal);
  const deliveryFee = computeDeliveryFee(itemsTotal);

  return {
    ok: true,
    status: 200,
    body: {
      items: checkoutItems,
      totalItems: checkoutItems.reduce((sum, item) => sum + item.quantity, 0),
      itemsTotal,
      mrpTotal,
      savings: roundMoney(Math.max(0, mrpTotal - itemsTotal)),
      deliveryFee,
      freeDeliveryAbove: FREE_DELIVERY_ABOVE,
      totalAmount: roundMoney(itemsTotal + deliveryFee),
      requiresPrescription,
      hasUnavailableItems
    }
  };
};

/**
 * Atomically takes stock for every order line. If any line cannot be fulfilled,
 * the lines already taken are put back and false is returned.
 */
const deductStock = async (orderItems) => {
  const taken = [];
  for (const item of orderItems) {
    const result = await Medicine.updateOne(
      { _id: item.medicineId, stock: { $gte: item.quantity } },
      { $inc: { stock: -item.quantity } }
    );
    if (result.modifiedCount !== 1) {
      await restoreStock(taken);
      return false;
    }
    taken.push(item);
  }
  return true;
};

const restoreStock = async (orderItems) => {
  for (const item of orderItems) {
    await Medicine.updateOne({ _id: item.medicineId }, { $inc: { stock: item.quantity } });
  }
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

const verifyRazorpaySignature = ({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) => {
  if (!RAZORPAY_KEY_SECRET) {
    return false;
  }

  const expected = Buffer.from(
    crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex")
  );
  const received = Buffer.from(String(razorpaySignature || ""));
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
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
  const { itemsTotal, deliveryFee, totalAmount, requiresPrescription } = checkoutSummary.body;

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
        label: String(address.label || "").trim(),
        fullName: String(address.fullName || customerName).trim(),
        phone: String(address.phone || customerPhone).trim(),
        line1: String(address.line1 || "").trim(),
        line2: String(address.line2 || "").trim(),
        landmark: String(address.landmark || "").trim(),
        city: String(address.city || "").trim(),
        state: String(address.state || "").trim(),
        pincode: String(address.pincode || "").trim()
      },
      paymentMethod,
      orderItems,
      itemsTotal,
      deliveryFee,
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

const sanitizeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

router.get("/", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const filter = q
    ? {
        $or: [
          { name: new RegExp(sanitizeRegex(q), "i") },
          { category: new RegExp(sanitizeRegex(q), "i") },
          { description: new RegExp(sanitizeRegex(q), "i") },
          { dosage: new RegExp(sanitizeRegex(q), "i") }
        ]
      }
    : {};
  const limit = Math.min(500, Math.max(1, Math.floor(toNumber(req.query.limit, 100))));
  const meds = await Medicine.find(filter).sort({ createdAt: -1 }).limit(limit);
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
      mrp: req.body.mrp ? toNumber(req.body.mrp, 0) : undefined,
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

    // Only columns present in the file are written, so a partial sheet (e.g. name + stock)
    // never resets price, stock, images or other fields of existing products.
    const listValue = (value) =>
      Array.isArray(value)
        ? normalizeStringList(value)
        : String(value).split(/[|;\n]/).map((item) => item.trim()).filter(Boolean);
    const writes = items
      .filter((med) => String(med?.name || "").trim())
      .map((med) => {
        const has = (key) => med[key] !== undefined && med[key] !== null && med[key] !== "";
        const set = { name: String(med.name).trim() };
        for (const key of ["category", "description", "dosage", "manufacturer", "imageUrl", "details"]) {
          if (has(key)) set[key] = String(med[key]).trim();
        }
        if (has("productType")) set.productType = String(med.productType).toLowerCase() === "wellness" ? "wellness" : "medicine";
        if (has("images")) set.images = listValue(med.images);
        if (has("highlights")) set.highlights = listValue(med.highlights);
        if (has("price")) set.price = Math.max(0, toNumber(med.price, 0));
        if (has("mrp")) set.mrp = Math.max(0, toNumber(med.mrp, 0));
        if (has("stock")) set.stock = Math.max(0, Math.floor(toNumber(med.stock, 0)));
        if (has("prescriptionRequired")) set.prescriptionRequired = toBoolean(med.prescriptionRequired);
        return { updateOne: { filter: { name: set.name }, update: { $set: set }, upsert: true } };
      });
    if (!writes.length) {
      return res.status(400).json({ message: "No rows with a name were found." });
    }

    const result = await Medicine.bulkWrite(writes);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(400).json({ message: "Failed to bulk upload medicines" });
  }
});

const SHEET_TEXT_FIELDS = ["name", "category", "description", "dosage", "manufacturer", "imageUrl", "details"];
const MAX_SHEET_ROWS = 2000;

/** Validates one spreadsheet row; returns { fields } or { error }. Only provided columns are set. */
const parseSheetRow = (row, { requireName }) => {
  const fields = {};
  for (const key of SHEET_TEXT_FIELDS) {
    if (row[key] !== undefined) fields[key] = String(row[key] ?? "").trim();
  }
  if (requireName || fields.name !== undefined) {
    if (!fields.name) return { error: "Name is required." };
  }
  if (row.productType !== undefined) {
    fields.productType = row.productType === "wellness" ? "wellness" : "medicine";
  }
  for (const key of ["price", "mrp"]) {
    if (row[key] === undefined || row[key] === "") continue;
    const value = Number(row[key]);
    if (!Number.isFinite(value) || value < 0) return { error: `${key} must be a number ≥ 0.` };
    fields[key] = Math.round(value * 100) / 100;
  }
  if (row.stock !== undefined && row.stock !== "") {
    const value = Number(row.stock);
    if (!Number.isInteger(value) || value < 0) return { error: "stock must be a whole number ≥ 0." };
    fields.stock = value;
  }
  if (row.prescriptionRequired !== undefined) fields.prescriptionRequired = toBoolean(row.prescriptionRequired);
  return { fields };
};

// Spreadsheet save: applies creates, updates and deletes in one request, all-or-nothing on validation.
router.post("/sheet", requireAuth, async (req, res) => {
  try {
    const creates = Array.isArray(req.body?.creates) ? req.body.creates : [];
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    const deletes = Array.isArray(req.body?.deletes) ? req.body.deletes.map(String) : [];
    if (creates.length + updates.length + deletes.length > MAX_SHEET_ROWS) {
      return res.status(400).json({ message: `Save at most ${MAX_SHEET_ROWS} rows at a time.` });
    }

    const errors = [];
    const createDocs = creates.map((row, index) => {
      const { fields, error } = parseSheetRow(row, { requireName: true });
      if (error) errors.push({ row: row?.rowKey ?? `new-${index}`, message: error });
      return fields;
    });
    const updateOps = updates.map((row) => {
      const id = String(row?._id || "");
      if (!mongoose.isValidObjectId(id)) {
        errors.push({ row: id, message: "Invalid id." });
        return null;
      }
      const { fields, error } = parseSheetRow(row, { requireName: false });
      if (error) errors.push({ row: id, message: error });
      return { updateOne: { filter: { _id: id }, update: { $set: fields } } };
    });
    if (deletes.some((id) => !mongoose.isValidObjectId(id))) {
      errors.push({ row: "delete", message: "Invalid id in deletes." });
    }
    if (errors.length) {
      return res.status(400).json({ message: "Some rows have problems. Nothing was saved.", errors });
    }

    if (createDocs.length) await Medicine.insertMany(createDocs);
    if (updateOps.length) await Medicine.bulkWrite(updateOps.filter(Boolean));
    if (deletes.length) await Medicine.deleteMany({ _id: { $in: deletes } });

    return res.json({
      ok: true,
      created: createDocs.length,
      updated: updateOps.length,
      deleted: deletes.length
    });
  } catch (_error) {
    return res.status(500).json({ message: "Failed to save the medicine sheet." });
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
        { name: new RegExp(sanitizeRegex(q), "i") },
        { category: new RegExp(sanitizeRegex(q), "i") },
        { description: new RegExp(sanitizeRegex(q), "i") }
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
    const summary = await buildCheckoutSummary(req.body?.items, { strict: false });
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

    const medicine = await Medicine.findById(medicineId).lean();
    if (!medicine) {
      return res.status(404).json({ message: "Medicine not found." });
    }

    const nextItems = mergeCartItems(
      normalizeMedicineItems(req.body?.items),
      medicineId,
      req.body?.quantity
    );
    const stock = Math.max(0, Math.floor(toNumber(medicine.stock, 0)));
    const requested = nextItems.find((item) => item.medicineId === medicineId)?.quantity || 0;
    if (stock <= 0) {
      return res.status(409).json({ message: `${medicine.name} is out of stock.` });
    }
    if (requested > stock) {
      return res.status(409).json({ message: `Only ${stock} units of ${medicine.name} available.` });
    }

    const summary = await buildCheckoutSummary(nextItems, { strict: false });
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
      itemsTotal,
      deliveryFee,
      totalAmount,
      requiresPrescription,
      prescriptionId
    } = prepared.body;

    if (!["cod", "upi", "card"].includes(paymentMethod)) {
      return res.status(400).json({
        message: "Manual order creation only supports cod, upi, or card."
      });
    }

    // Cash on delivery reserves stock immediately; online payments reserve on payment.
    const reserved = await deductStock(orderItems);
    if (!reserved) {
      return res.status(409).json({
        message: "Some items just went out of stock. Please review your cart."
      });
    }

    let order;
    try {
      order = await Order.create({
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
        itemsTotal,
        deliveryFee,
        totalAmount,
        stockDeducted: true,
        requiresPrescription,
        prescriptionId
      });
    } catch (error) {
      await restoreStock(orderItems);
      throw error;
    }

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
      itemsTotal,
      deliveryFee,
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
      itemsTotal,
      deliveryFee,
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
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature
    });

    if (!validSignature) {
      if (order.paymentStatus !== "paid") {
        await Order.findByIdAndUpdate(orderId, {
          paymentStatus: "failed",
          verificationNote: "Razorpay signature verification failed."
        });
      }
      return res.status(400).json({ message: "Payment verification failed." });
    }

    // A repeated verify call (retry / double click) must not take stock twice.
    if (order.paymentStatus === "paid") {
      return res.json({
        orderId: order._id,
        status: order.status,
        paymentStatus: order.paymentStatus,
        paymentMethod: order.paymentMethod,
        razorpayPaymentId: order.razorpayPaymentId
      });
    }

    const reserved = order.stockDeducted ? true : await deductStock(order.items);
    const updated = await Order.findByIdAndUpdate(
      orderId,
      {
        paymentStatus: "paid",
        // Paid but stock ran out meanwhile: keep it pending so the admin can refund or restock.
        status: order.requiresPrescription || !reserved ? "pending" : "approved",
        stockDeducted: reserved,
        ...(reserved
          ? {}
          : { verificationNote: "Paid, but stock ran out before payment completed. Refund or restock needed." }),
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
      razorpayPaymentId: updated.razorpayPaymentId,
      stockIssue: !reserved
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
        itemsTotal: order.itemsTotal ?? order.totalAmount,
        deliveryFee: order.deliveryFee || 0,
        totalAmount: order.totalAmount,
        requiresPrescription: order.requiresPrescription,
        verificationNote: order.verificationNote,
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
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found." });
    }

    // Rejected orders give their reserved stock back exactly once.
    const releaseStock = status === "rejected" && order.stockDeducted;
    if (releaseStock) {
      await restoreStock(order.items);
    }
    const updated = await Order.findByIdAndUpdate(
      req.params.id,
      {
        status,
        verificationNote: note || undefined,
        ...(releaseStock ? { stockDeducted: false } : {})
      },
      { new: true }
    );
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
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found." });
    }

    const releaseStock = status === "rejected" && order.stockDeducted;
    if (releaseStock) {
      await restoreStock(order.items);
    }
    const updated = await Order.findByIdAndUpdate(
      req.params.id,
      { status, ...(releaseStock ? { stockDeducted: false } : {}) },
      { new: true }
    );
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
    if (req.body.mrp !== undefined) {
      // 0 / empty clears the MRP so no discount is shown.
      payload.mrp = Math.max(0, toNumber(req.body.mrp, 0));
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
