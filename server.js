
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

const SHOPIFY_STORE_DOMAIN = (process.env.SHOPIFY_STORE_DOMAIN || "")
  .replace(/^https?:\/\//, "")
  .replace(/\/+$/, "");

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-10";

const SIKKPAY_KEY = process.env.SIKKPAY_KEY;
const SIKKPAY_SECRET = process.env.SIKKPAY_SECRET;
const SIKKPAY_WEBHOOK_SECRET = process.env.SIKKPAY_WEBHOOK_SECRET;
const SIKKPAY_BASE_URL = (
  process.env.SIKKPAY_BASE_URL ||
  "https://sikkpay.org/api/sikkpay/v1"
).replace(/\/+$/, "");

const FRONTEND_ORIGINS = (
  process.env.FRONTEND_ORIGINS ||
  "https://shophomura.com,https://www.shophomura.com"
)
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

let cachedShopifyToken = null;
let tokenExpiresAt = 0;
let tokenRequestPromise = null;

function checkEnvironment() {
  const required = [
    "SHOPIFY_STORE_DOMAIN",
    "SHOPIFY_CLIENT_ID",
    "SHOPIFY_CLIENT_SECRET",
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

    throw new Error(`${response.status}: ${JSON.stringify(detail)}`);
  }

  return data;
}

// Shopify Client Credentials grant.
// Tokens last 24 hours; refresh five minutes before expiry.
async function getShopifyAccessToken() {
  if (cachedShopifyToken && Date.now() < tokenExpiresAt - 300000) {
    return cachedShopifyToken;
  }

  if (tokenRequestPromise) {
    return tokenRequestPromise;
  }

  tokenRequestPromise = (async () => {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    });

    const data = await requestJson(
      `https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      }
    );

    if (!data.access_token) {
      throw new Error("Shopify did not return an access token.");
    }

    const scopes = String(data.scope || "").split(",").map((x) => x.trim());

    if (
      !scopes.includes("read_draft_orders") ||
      !scopes.includes("write_draft_orders")
    ) {
      throw new Error(
        `Shopify token is missing required draft-order scopes. Granted: ${data.scope || "none"}`
      );
    }

    cachedShopifyToken = data.access_token;
    tokenExpiresAt = Date.now() + Number(data.expires_in || 86399) * 1000;

    return cachedShopifyToken;
  })();

  try {
    return await tokenRequestPromise;
  } finally {
    tokenRequestPromise = null;
  }
}

async function shopifyGraphQL(query, variables = {}) {
  const token = await getShopifyAccessToken();

  const data = await requestJson(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (data.errors?.length) {
    throw new Error(
      `Shopify GraphQL error: ${JSON.stringify(data.errors)}`
    );
  }

  return data.data;
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

function getPaymentObject(data) {
  return data?.payment || data?.data?.payment || data?.data || data;
}

async function getDraftOrder(orderId) {
  const gid = `gid://shopify/DraftOrder/${orderId}`;

  const data = await shopifyGraphQL(
    `query GetDraftOrder($id: ID!) {
      draftOrder(id: $id) {
        id
        legacyResourceId
        name
        status
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
      }
    }`,
    { id: gid }
  );

  if (!data?.draftOrder) {
    throw new Error("Shopify draft order was not found.");
  }

  return data.draftOrder;
}

async function getSikkpayPayment(orderId) {
  const data = await sikkpayRequest(
    `/payments/${encodeURIComponent(orderId)}`
  );

  return getPaymentObject(data);
}

async function completeDraftOrder(orderId) {
  const draft = await getDraftOrder(orderId);

  if (String(draft.status).toUpperCase() === "COMPLETED") {
    return draft;
  }

  const data = await shopifyGraphQL(
    `mutation CompleteDraftOrder($id: ID!) {
      draftOrderComplete(id: $id, paymentPending: false) {
        draftOrder {
          id
          name
          status
          order {
            name
          }
        }
        userErrors {
          field
          message
        }
      }
    }`,
    { id: draft.id }
  );

  const result = data?.draftOrderComplete;

  if (result?.userErrors?.length) {
    throw new Error(
      `Shopify completion error: ${JSON.stringify(result.userErrors)}`
    );
  }

  if (!result?.draftOrder) {
    throw new Error("Shopify did not complete the draft order.");
  }

  return result.draftOrder;
}

async function confirmAndComplete(orderId) {
  if (!validateOrderId(orderId)) {
    throw new Error("Invalid order ID.");
  }

  // Never trust the customer's return URL as proof of payment.
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
  const money = draft.totalPriceSet?.shopMoney;

  if (String(money?.currencyCode || "").toUpperCase() !== "PKR") {
    throw new Error("Shopify store currency must be PKR.");
  }

  const total = Number(money.amount);
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
  } else {
    throw new Error("Sikkpay did not provide a verifiable payment amount.");
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
    orderName: completed.order?.name || completed.name || null,
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

  if (!timestamp || !signatures.length) return false;

  const timestampNumber = Number(timestamp);

  if (
    !Number.isFinite(timestampNumber) ||
    Math.abs(Date.now() / 1000 - timestampNumber) > 300
  ) {
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

// CORS for the HOMURA storefront.
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

// Webhook must receive the original, unparsed body.
app.post(
  "/sikkpay/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        return res.sendStatus(400);
      }

      if (
        !verifySikkpaySignature(
          req.get("Sikkpay-Signature"),
          req.body
        )
      ) {
        return res.sendStatus(401);
      }

      const event = JSON.parse(req.body.toString("utf8"));
      const eventType = event.event || event.type;

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
  res.json({
    status: "ok",
    service: "HOMURA payment backend",
  });
});

// Create a Shopify draft order, then create its Sikkpay payment.
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

      const customAttributes = Object.entries(item.properties || {})
        .slice(0, 20)
        .map(([key, value]) => ({
          key: String(key).slice(0, 255),
          value: String(value).slice(0, 255),
        }));

      return {
        variantId: `gid://shopify/ProductVariant/${variantId}`,
        quantity,
        ...(customAttributes.length ? { customAttributes } : {}),
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

    const draftInput = {
      lineItems,
      email: email.trim(),
      phone: phone.trim(),
      note: `HOMURA custom checkout. Customer phone: ${phone.trim()}`,
      shippingAddress: {
        firstName,
        lastName,
        address1: address.trim(),
        city: city.trim(),
        countryCode: "PK",
        phone: phone.trim(),
      },
      presentmentCurrencyCode: "PKR",
      ...(shippingAmount > 0
        ? {
            shippingLine: {
              title: "Shipping",
              priceWithCurrency: {
                amount: shippingAmount.toFixed(2),
                currencyCode: "PKR",
              },
            },
          }
        : {}),
    };

    const created = await shopifyGraphQL(
      `mutation CreateDraftOrder($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            legacyResourceId
            name
            status
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
      { input: draftInput }
    );

    const result = created?.draftOrderCreate;

    if (result?.userErrors?.length) {
      throw new Error(
        `Shopify draft-order error: ${JSON.stringify(result.userErrors)}`
      );
    }

    const draft = result?.draftOrder;

    if (!draft?.legacyResourceId) {
      throw new Error("Shopify did not create the draft order.");
    }

    const money = draft.totalPriceSet?.shopMoney;

    if (String(money?.currencyCode || "").toUpperCase() !== "PKR") {
      throw new Error("Your Shopify store currency must be PKR.");
    }

    const total = Number(money.amount);
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

    const orderId = String(draft.legacyResourceId);

    const returnUrl = new URL(
      process.env.SIKKPAY_RETURN_URL || "https://shophomura.com/"
    );

    returnUrl.searchParams.set("homura_order_id", orderId);

    const paymentResponse = await sikkpayRequest("/payments", {
      method: "POST",
      body: JSON.stringify({
        amount,
        order_id: orderId,
        description: `HOMURA Order ${draft.name || orderId}`,
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
      orderId,
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

// Verify payment status and complete the draft order only after payment.
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

app.get("/test-shopify", async (req, res) => {
  try {
    checkEnvironment();

    const data = await shopifyGraphQL(`
      query {
        shop {
          name
          myshopifyDomain
          currencyCode
        }
      }
    `);

    res.json({
      status: "success",
      shop: data.shop
    });
  } catch (error) {
    console.error("Shopify test:", error.message);
    res.status(500).json({
      status: "failed",
      error: error.message
    });
  }
});

module.exports = app;

// Local development only. Vercel imports the Express app above.
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`HOMURA backend running on port ${port}`);
  });
}


