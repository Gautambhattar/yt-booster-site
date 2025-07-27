// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const { Cashfree } = require('cashfree-pg');
const { check, validationResult } = require('express-validator');

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true
}));
app.use(bodyParser.json());
app.use('/webhook', express.raw({ type: '*/*' })); // raw for webhook
app.use(express.static('public'));

const cashfree = new Cashfree({
  env: process.env.CASHFREE_ENV,
  appId: process.env.CASHFREE_APP_ID,
  secretKey: process.env.CASHFREE_SECRET_KEY
});

function generateOrderId() {
  return 'order_' + crypto.randomBytes(8).toString('hex');
}

const rechargeHistory = [];
const supportTickets = [];

// Create Order
app.post('/create-order', [
  check('amount').isFloat({ gt: 0 }),
  check('currency').notEmpty(),
  check('customerEmail').isEmail(),
  check('customerPhone').isMobilePhone()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { amount, currency, customerEmail, customerPhone } = req.body;
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

  try {
    const result = await cashfree.orders.create(order);
    if (result.payment_session_id) {
      rechargeHistory.push({
        orderId,
        email: customerEmail,
        amount,
        phone: customerPhone,
        date: new Date().toISOString(),
        status: 'INITIATED'
      });
      return res.json({ paymentSessionId: result.payment_session_id, orderId });
    }
    res.status(502).json({ error: 'Invalid response from Cashfree' });
  } catch (err) {
    console.error('Create Order Error:', err);
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || 'Payment initiation failed';
    res.status(status).json({ error: message });
  }
});

// Verify Payment
app.post('/verify-payment', [
  check('orderId').notEmpty()
], async (req, res) => {
  const { orderId } = req.body;
  try {
    const response = await cashfree.orders.get(orderId);
    const status = response.order_status;

    const index = rechargeHistory.findIndex(r => r.orderId === orderId);
    if (index !== -1) rechargeHistory[index].status = status;

    res.json({
      orderStatus: status,
      paymentStatus: status === 'PAID' ? 'SUCCESS' : 'FAILED'
    });
  } catch (err) {
    console.error('Verification Error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Webhook (real-time status updates)
app.post('/webhook', (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];

    cashfree.PGVerifyWebhookSignature(signature, req.body, timestamp);
    const payload = JSON.parse(req.body);

    const index = rechargeHistory.findIndex(r => r.orderId === payload.order_id);
    if (index !== -1) {
      rechargeHistory[index].status = payload.order_status;
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook verification failed:', err);
    res.status(400).send('Invalid webhook');
  }
});

// Recharge History API
app.get('/api/history/:email', (req, res) => {
  const { email } = req.params;
  const history = rechargeHistory.filter(r => r.email === email);
  res.json(history);
});

// Submit Support Ticket
app.post('/api/support', [
  check('email').isEmail(),
  check('message').notEmpty()
], (req, res) => {
  const { email, message, role } = req.body;
  const id = 'ticket_' + crypto.randomBytes(6).toString('hex');

  supportTickets.push({
    id,
    email,
    role: role || 'user',
    message,
    timestamp: new Date().toISOString()
  });

  res.json({ success: true });
});

// Get Support Tickets
app.get('/api/support', (req, res) => {
  const { email, role } = req.query;

  if (role === 'admin') return res.json(supportTickets);

  const filtered = supportTickets.filter(t => t.email === email);
  res.json(filtered);
});

// Serve checkout page
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/checkout.html');
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
