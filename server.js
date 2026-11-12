
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-10";

const SIKKPAY_KEY = process.env.SIKKPAY_KEY;
const SIKKPAY_SECRET = process.env.SIKKPAY_SECRET;
const SIKKPAY_WEBHOOK_SECRET = process.env.SIKKPAY_WEBHOOK_SECRET;
const SIKKPAY_BASE_URL =
  (process.env.SIKKPAY_BASE_URL ||
    "https://sikkpay.org/api/sikkpay/v1").replace(/\/+$/, "");

const FRONTEND_ORIGINS = (
  process.env.FRONTEND_ORIGINS ||
  "https://shophomura.com,https://www.shophomura.com"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function checkEnvironment() {
  const required = [
    "SHOPIFY_STORE_DOMAIN",
    "SHOPIFY_ADMIN_TOKEN",
    "SIKKPAY_KEY",
    "SIKKPAY_SECRET",
    "SIKKPAY_WEBHOOK_SECRET",
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
}

function validateOrderId(value) {
  return /^\d{1,20}$/.test(String(value || ""));
}

function sendError(res, message, status = 500) {
  return res.status(status).json({ error: message });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const raw = await response.text();

  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  if (!response.ok) {
    const detail =
      data?.errors ||
      data?.error ||
      data?.message ||
      `HTTP ${response.status}`;

    throw new Error(
      `${response.status}: ${JSON.stringify(detail)}`
    );
  }

  return data;
}

async function shopifyRequest(path, options = {}) {
  const base =
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`;

  return requestJson(`${base}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      ...(options.headers || {}),
    },
  });
}

async function sikkpayRequest(path, options = {}) {
  return requestJson(`${SIKKPAY_BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Sikkpay-Key": SIKKPAY_KEY,
      "X-Sikkpay-Secret": SIKKPAY_SECRET,
      ...(options.headers || {}),
    },
  });
}

async function getDraftOrder(orderId) {
  const data = await shopifyRequest(
    `/draft_orders/${encodeURIComponent(orderId)}.json`
  );

  if (!data.draft_order) {
    throw new Error("Shopify draft order was not found.");
  }

  return data.draft_order;
}

function getPaymentObject(data) {
  return data?.payment || data?.data?.payment || data?.data || data;
}

async function getSikkpayPayment(orderId) {
  const data = await sikkpayRequest(
    `/payments/${encodeURIComponent(orderId)}`
  );

  return getPaymentObject(data);
}

async function completeDraftOrder(orderId) {
  const existing = await getDraftOrder(orderId);

  // Avoid completing the same draft order twice.
  if (existing.status === "completed") {
    return existing;
  }

  const data = await shopifyRequest(
    `/draft_orders/${encodeURIComponent(orderId)}/complete.json?payment_pending=false`,
    {
      method: "PUT",
      body: JSON.stringify({}),
    }
  );

  if (!data.draft_order) {
    throw new Error("Shopify did not return the completed order.");
  }

  return data.draft_order;
}

async function confirmAndComplete(orderId) {
  if (!validateOrderId(orderId)) {
    throw new Error("Invalid order ID.");
  }

  // Always check Sikkpay directly. Never trust the return URL alone.
  const payment = await getSikkpayPayment(orderId);

  if (String(payment?.status || "").toLowerCase() !== "paid") {
    return { status: "open" };
  }

  if (
    payment.order_id &&
    String(payment.order_id) !== String(orderId)
  ) {
    throw new Error("Sikkpay order ID does not match.");
  }

  const draft = await getDraftOrder(orderId);

  if (String(draft.currency || "").toUpperCase() !== "PKR") {
    throw new Error("Shopify order currency must be PKR.");
  }

  const total = Number(draft.total_price);
  const expectedAmount = Math.round(total);

  if (
    !Number.isFinite(total) ||
    Math.abs(total - expectedAmount) > 0.001 ||
    expectedAmount < 5 ||
    expectedAmount > 500000
  ) {
    throw new Error("Invalid Shopify order amount.");
  }

  if (payment.amount !== undefined && payment.amount !== null) {
    if (Number(payment.amount) !== expectedAmount) {
      throw new Error("Sikkpay payment amount does not match the order.");
    }
  }

  if (
    payment.currency &&
    String(payment.currency).toUpperCase() !== "PKR"
  ) {
    throw new Error("Sikkpay payment currency does not match.");
  }

  const completed = await completeDraftOrder(orderId);

  return {
    status: "paid",
    orderId: String(orderId),
    orderNumber: completed.name || null,
  };
}

function verifySikkpaySignature(signatureHeader, rawBody) {
  if (!signatureHeader || !SIKKPAY_WEBHOOK_SECRET) {
    return false;
  }

  const parts = signatureHeader
    .split(",")
    .map((part) => part.trim().split("="));

  const timestamp = parts.find((part) => part[0] === "t")?.[1];
  const signatures = parts
    .filter((part) => part[0] === "v1")
    .map((part) => part[1]);

  if (!timestamp || !signatures.length) {
    return false;
  }

  const timestampNumber = Number(timestamp);

  if (!Number.isFinite(timestampNumber)) {
    return false;
  }

  // Reject webhook signatures older than five minutes.
  if (Math.abs(Date.now() / 1000 - timestampNumber) > 300) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", SIKKPAY_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody.toString("utf8")}`)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "hex");

  return signatures.some((signature) => {
    try {
      const suppliedBuffer = Buffer.from(signature, "hex");

      return (
        suppliedBuffer.length === expectedBuffer.length &&
        crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
      );
    } catch {
      return false;
    }
  });
}

// CORS: allow your storefront, not arbitrary websites.
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || FRONTEND_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Origin not allowed."));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

// IMPORTANT: webhook must receive the original, unparsed request body.
app.post(
  "/sikkpay/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        return res.sendStatus(400);
      }

      const signature = req.get("Sikkpay-Signature");

      if (!verifySikkpaySignature(signature, req.body)) {
        return res.sendStatus(401);
      }

      const event = JSON.parse(req.body.toString("utf8"));
      const eventType = event.event || event.type;

      // Ignore other event types.
      if (eventType !== "payment.paid") {
        return res.sendStatus(200);
      }

      const payment =
        event.payment ||
        event.data?.payment ||
        event.data ||
        event;

      const orderId = String(payment.order_id || "");

      if (!validateOrderId(orderId)) {
        return res.sendStatus(400);
      }

      // Re-check payment through Sikkpay's authenticated API.
      const result = await confirmAndComplete(orderId);

      if (result.status !== "paid") {
        return res.sendStatus(409);
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error("Sikkpay webhook error:", error.message);
      return res.sendStatus(500);
    }
  }
);

app.use(express.json({ limit: "100kb" }));

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "HOMURA payment backend" });
});

// Create Shopify draft order, then create Sikkpay payment.
app.post("/create-payment", async (req, res) => {
  try {
    checkEnvironment();

    const { name, email, phone, address, city, items } = req.body || {};

    if (
      !name?.trim() ||
      !email?.trim() ||
      !phone?.trim() ||
      !address?.trim() ||
      !city?.trim()
    ) {
      return sendError(res, "Please complete all customer details.", 400);
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return sendError(res, "Please enter a valid email address.", 400);
    }

    if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
      return sendError(res, "Your cart is empty or invalid.", 400);
    }

    const lineItems = items.map((item) => {
      const variantId = String(item.variant_id || "");
      const quantity = Number(item.quantity);

      if (
        !/^\d+$/.test(variantId) ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 50
      ) {
        throw new Error("A cart item is invalid.");
      }

      const properties = Object.entries(item.properties || {})
        .slice(0, 20)
        .map(([key, value]) => ({
          name: String(key).slice(0, 255),
          value: String(value).slice(0, 255),
        }));

      return {
        variant_id: Number(variantId),
        quantity,
        ...(properties.length ? { properties } : {}),
      };
    });

    const nameParts = name.trim().split(/\s+/);
    const firstName = nameParts.shift() || "Customer";
    const lastName = nameParts.join(" ");

    const shippingAmount = Number(
      process.env.SHIPPING_AMOUNT_PKR || "0"
    );

    if (!Number.isFinite(shippingAmount) || shippingAmount < 0) {
      return sendError(res, "Shipping configuration is invalid.", 500);
    }

    const draftOrder = {
      line_items: lineItems,
      email: email.trim(),
      note: `HOMURA custom checkout. Customer phone: ${phone.trim()}`,
      shipping_address: {
        first_name: firstName,
        last_name: lastName,
        address1: address.trim(),
        city: city.trim(),
        country_code: "PK",
        phone: phone.trim(),
      },
      ...(shippingAmount > 0
        ? {
            shipping_line: {
              title: "Shipping",
              price: shippingAmount.toFixed(2),
            },
          }
        : {}),
    };

    const created = await shopifyRequest("/draft_orders.json", {
      method: "POST",
      body: JSON.stringify({ draft_order: draftOrder }),
    });

    const draft = created.draft_order;

    if (!draft?.id) {
      throw new Error("Shopify did not create the draft order.");
    }

    if (String(draft.currency || "").toUpperCase() !== "PKR") {
      throw new Error(
        "Your Shopify store currency must be PKR for this Sikkpay integration."
      );
    }

    const total = Number(draft.total_price);
    const amount = Math.round(total);

    if (
      !Number.isFinite(total) ||
      Math.abs(total - amount) > 0.001 ||
      amount < 5 ||
      amount > 500000
    ) {
      throw new Error(
        "The order total must be a whole PKR amount between Rs 5 and Rs 500,000."
      );
    }

    const returnUrl = new URL(
      process.env.SIKKPAY_RETURN_URL || "https://shophomura.com/"
    );

    returnUrl.searchParams.set("homura_order_id", String(draft.id));

    const paymentResponse = await sikkpayRequest("/payments", {
      method: "POST",
      body: JSON.stringify({
        amount,
        order_id: String(draft.id),
        description: `HOMURA Order ${draft.name || draft.id}`,
        return_url: returnUrl.toString(),
      }),
    });

    const payment = getPaymentObject(paymentResponse);
    const payUrl = payment?.pay_url;

    if (!payUrl) {
      throw new Error("Sikkpay did not return a payment URL.");
    }

    const parsedPayUrl = new URL(payUrl);

    if (
      parsedPayUrl.protocol !== "https:" ||
      !(
        parsedPayUrl.hostname === "sikkpay.org" ||
        parsedPayUrl.hostname.endsWith(".sikkpay.org")
      )
    ) {
      throw new Error("Sikkpay returned an invalid payment URL.");
    }

    return res.status(201).json({
      orderId: String(draft.id),
      orderName: draft.name || null,
      amount,
      currency: "PKR",
      payUrl: parsedPayUrl.toString(),
    });
  } catch (error) {
    console.error("Create payment error:", error.message);
    return sendError(
      res,
      "We couldn't create your payment. Please try again or contact HOMURA.",
      500
    );
  }
});

// Check Sikkpay status. A paid response also completes the Shopify draft order.
app.get("/check-status/:orderId", async (req, res) => {
  try {
    checkEnvironment();

    const orderId = String(req.params.orderId || "");

    if (!validateOrderId(orderId)) {
      return sendError(res, "Invalid order ID.", 400);
    }

    const result = await confirmAndComplete(orderId);

    return res.json(result);
  } catch (error) {
    console.error("Payment status error:", error.message);
    return sendError(
      res,
      "Payment status is temporarily unavailable. Please try again.",
      502
    );
  }
});

app.use((error, req, res, next) => {
  console.error("Server error:", error.message);
  if (res.headersSent) return next(error);
  return res.status(500).json({ error: "Internal server error." });
});

module.exports = app;

// Local development only. Vercel imports the Express app above.
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`HOMURA backend running on port ${port}`);
  });
}


