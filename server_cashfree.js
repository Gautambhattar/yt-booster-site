// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const { Cashfree } = require('cashfree-pg');

const app = express();

// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true
}));
app.use(bodyParser.json());
app.use(express.static('public'));

// Initialize Cashfree SDK
const cashfree = new Cashfree({
  env: process.env.CASHFREE_ENV,
  appId: process.env.CASHFREE_APP_ID,
  secretKey: process.env.CASHFREE_SECRET_KEY
});

// Utility: Robust Order ID Generator
function generateOrderId() {
  return 'order_' + crypto.randomBytes(8).toString('hex');
}

// 1. Create Order & Return Payment Session ID
app.post('/create-order', async (req, res) => {
  try {
    const { amount, currency, customerEmail, customerPhone } = req.body;
    if (!amount || !currency || !customerEmail || !customerPhone) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const orderId = generateOrderId();
    const order = {
      order_id: orderId,
      order_amount: amount,
      order_currency: currency,
      customer_details: {
        customer_id: 'cust_' + crypto.randomBytes(4).toString('hex'),
        customer_email: customerEmail,
        customer_phone: customerPhone
      },
      order_meta: {
        return_url: `${process.env.FRONTEND_URL}/payment-success?order_id=${orderId}`
      }
    };

    const result = await cashfree.orders.create(order);

    if (result.payment_session_id) {
      res.json({ paymentSessionId: result.payment_session_id, orderId });
    } else {
      res.status(502).json({ error: 'Invalid response from Cashfree' });
    }
  } catch (error) {
    console.error('Cashfree Error:', error);
    const status = error.response?.status || 500;
    const message = error.response?.data?.message || 'Payment initiation failed';
    res.status(status).json({ error: message });
  }
});

// 2. Verify Payment Status
app.post('/verify-payment', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required' });
    }

    const response = await cashfree.orders.get(orderId);
    const status = response.order_status;
    res.json({
      orderStatus: status,
      paymentStatus: status === 'PAID' ? 'SUCCESS' : 'FAILED'
    });
  } catch (error) {
    console.error('Verification Error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// 3. Webhook Handler for Real-Time Updates
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];

    cashfree.PGVerifyWebhookSignature(signature, req.body, timestamp);

    const payload = JSON.parse(req.body);
    console.log('Webhook payload:', payload);

    // TODO: Update your order database based on payload.order_id and payload.order_status

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook verification failed:', error);
    res.status(400).send('Invalid webhook');
  }
});

// Serve Frontend (changed to checkout.html)
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/checkout.html');
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
