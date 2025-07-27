
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const dotenv = require("dotenv");
const { Cashfree } = require("cashfree-pg");

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

const cashfree = new Cashfree({
  env: "TEST", // Change to "PROD" for live environment
  appId: process.env.CASHFREE_APP_ID,
  secretKey: process.env.CASHFREE_SECRET_KEY,
});

app.post("/create-order", async (req, res) => {
  try {
    const orderId = "order_" + Date.now();
    const order = {
      order_id: orderId,
      order_amount: 99.0,
      order_currency: "INR",
      customer_details: {
        customer_id: "user_" + Date.now(),
        customer_email: "test@example.com",
        customer_phone: "9999999999",
      },
      order_meta: {
        return_url: "http://localhost:3000/payment-success?order_id={order_id}",
      },
    };

    const result = await cashfree.orders.create(order);
    res.json({ paymentSessionId: result.payment_session_id });
  } catch (error) {
    console.error("Cashfree Error:", error);
    res.status(500).send("Payment initiation failed");
  }
});


app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/login.html");
});


app.listen(3000, () => {
  console.log("Cashfree server running on http://localhost:3000");
});
