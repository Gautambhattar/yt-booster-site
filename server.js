require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const { Cashfree } = require('cashfree-pg');

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true
}));
app.use(bodyParser.json());
app.use(express.static('public'));

const cashfree = new Cashfree({
  env: process.env.CASHFREE_ENV, // 'TEST' or 'PROD'
  appId: process.env.CASHFREE_APP_ID,
  secretKey: process.env.CASHFREE_SECRET_KEY
});

function generateOrderId() {
  return 'order_' + crypto.randomBytes(8).toString('hex');
}

// In-memory mock DB (replace with DB for production)
const rechargeHistory = [];
const supportTickets = [];

// ==== Payment Flow ====

app.post('/create-order', async (req, res) => {
  try {
    const { amount, currency, customerEmail, customerPhone } = req.body;
    if (!amount || !currency || !customerEmail || !customerPhone) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const orderId = generateOrderId();
    const orderObj = {
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

    const result = await cashfree.orders.create(orderObj);

    if (result.payment_session_id) {
      rechargeHistory.push({
        orderId,
        email: customerEmail,
        amount,
        phone: customerPhone,
        date: new Date().toISOString(),
        status: 'INITIATED',
        txnId: orderId
      });
      return res.json({ paymentSessionId: result.payment_session_id, orderId });
    } else {
      return res.status(502).json({ error: 'Invalid response from Cashfree' });
    }
  } catch (err) {
    console.error('Cashfree Error:', err);
    return res.status(err.response?.status || 500).json({
      error: err.response?.data?.message || 'Payment initiation failed'
    });
  }
});

app.post('/verify-payment', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });

    const resp = await cashfree.orders.get(orderId);
    const status = resp.order_status;

    const idx = rechargeHistory.findIndex(r => r.orderId === orderId);
    if (idx !== -1) rechargeHistory[idx].status = status;

    res.json({
      orderStatus: status,
      paymentStatus: status === 'PAID' ? 'SUCCESS' : 'FAILED'
    });
  } catch (err) {
    console.error('Verification Error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ==== Optional Cashfree Webhook ====

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];

    cashfree.PGVerifyWebhookSignature(signature, req.body, timestamp);

    const payload = JSON.parse(req.body);
    const idx = rechargeHistory.findIndex(r => r.orderId === payload.order_id);
    if (idx !== -1) rechargeHistory[idx].status = payload.order_status;

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook Error:', err);
    res.sendStatus(400);
  }
});

// ==== Support Chat ====

app.post('/support-message', (req, res) => {
  const { email, message, role = 'user', to } = req.body;
  if (!email || !message) return res.status(400).json({ error: 'Missing fields' });

  supportTickets.push({
    from: role === 'admin' ? 'admin' : email,
    to: role === 'admin' && to ? to : 'admin',
    email,
    message,
    timestamp: new Date().toISOString()
  });

  res.json({ success: true });
});

app.get('/support-messages', (req, res) => {
  const { email, role, user } = req.query;

  if (role === 'admin') {
    const conv = supportTickets.filter(m =>
      (m.from === user && m.to === 'admin') || (m.from === 'admin' && m.to === user)
    );
    return res.json(conv);
  } else {
    const conv = supportTickets.filter(m => m.email === email);
    return res.json(conv);
  }
});

app.get('/support-users', (req, res) => {
  const users = Array.from(new Set(supportTickets.map(m => m.email).filter(Boolean)));
  res.json(users);
});

// ==== Recharge History ====

app.get('/user-recharges', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const history = rechargeHistory.filter(r => r.email === email);
  res.json(history);
});

// ==== Serve Static ====

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/checkout.html');
});

// ==== Start Server ====

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
