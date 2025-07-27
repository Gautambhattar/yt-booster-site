require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const bodyParser = require("body-parser");
const { Cashfree } = require("cashfree-pg");

const app = express();

const cashfree = new Cashfree({
  env: process.env.CASHFREE_ENV,
  appId: process.env.CASHFREE_APP_ID,
  secretKey: process.env.CASHFREE_SECRET_KEY,
});

app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(bodyParser.json());
app.use(express.static("public"));

// In-memory storage
const rechargeHistory = [];
const supportTickets = [];

const generateOrderId = () =>
  "order_" + crypto.randomBytes(8).toString("hex");

// ===============================
// ✅ Create Cashfree Order
// ===============================
app.post("/create-order", async (req, res) => {
  const { amount, currency, customerEmail, customerPhone } = req.body;

  if (!amount || !currency || !customerEmail || !customerPhone) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const orderId = generateOrderId();

  const orderPayload = {
    order_id: orderId,
    order_amount: amount,
    order_currency: currency,
    customer_details: {
      customer_id: "cust_" + crypto.randomBytes(4).toString("hex"),
      customer_email: customerEmail,
      customer_phone: customerPhone,
    },
    order_meta: {
      return_url: `${process.env.FRONTEND_URL}/payment-success?order_id=${orderId}`,
    },
  };

  try {
    const response = await cashfree.orders.create(orderPayload);

    rechargeHistory.push({
      orderId,
      email: customerEmail,
      amount,
      phone: customerPhone,
      status: "INITIATED",
      date: new Date().toISOString(),
    });

    return res.json({
      paymentSessionId: response.payment_session_id,
      orderId,
    });
  } catch (error) {
    console.error("Cashfree Error:", error.response?.data || error.message);
    return res.status(500).json({
      error: error.response?.data?.message || "Payment failed to initiate",
    });
  }
});

// ===============================
// ✅ Verify Cashfree Payment
// ===============================
app.post("/verify-payment", async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: "orderId required" });

  try {
    const result = await cashfree.orders.get(orderId);
    const status = result.order_status;

    const index = rechargeHistory.findIndex((r) => r.orderId === orderId);
    if (index !== -1) rechargeHistory[index].status = status;

    return res.json({
      orderStatus: status,
      paymentStatus: status === "PAID" ? "SUCCESS" : "FAILED",
    });
  } catch (error) {
    console.error("Verify Payment Error:", error.message);
    return res.status(500).json({ error: "Verification failed" });
  }
});

// ===============================
// ✅ Recharge History
// ===============================
app.get("/api/history/:email", (req, res) => {
  const email = req.params.email;
  const history = rechargeHistory.filter((r) => r.email === email);
  return res.json(history);
});

// ===============================
// ✅ Submit Support Message
// ===============================
app.post("/api/support", (req, res) => {
  const { email, message, role } = req.body;
  if (!email || !message)
    return res.status(400).json({ error: "Missing fields" });

  supportTickets.push({
    email,
    role: role || "user",
    message,
    timestamp: new Date().toISOString(),
  });

  return res.json({ success: true });
});

// ===============================
// ✅ Fetch Support Messages
// ===============================
app.get("/api/support", (req, res) => {
  const { email, role } = req.query;
  if (role === "admin") return res.json(supportTickets);

  const userMessages = supportTickets.filter((t) => t.email === email);
  return res.json(userMessages);
});

// ===============================
// ✅ Webhook (optional)
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  try {
    const signature = req.headers["x-webhook-signature"];
    const timestamp = req.headers["x-webhook-timestamp"];
    cashfree.PGVerifyWebhookSignature(signature, req.body, timestamp);

    const payload = JSON.parse(req.body);

    const index = rechargeHistory.findIndex(
      (r) => r.orderId === payload.order_id
    );
    if (index !== -1) rechargeHistory[index].status = payload.order_status;

    return res.status(200).send("OK");
  } catch (err) {
    console.error("Invalid Webhook:", err.message);
    return res.status(400).send("Invalid webhook");
  }
});

// ===============================
// ✅ Root Route for HTML
// ===============================
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/checkout.html");
});

// ===============================
// ✅ Start Server
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
