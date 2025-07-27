require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const admin = require('firebase-admin');

const app = express();

// =========================
// 🔐 Firebase Admin Init
// =========================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '{}');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL || "https://your-project-id.firebaseio.com" // Replace this if needed
});
const db = admin.firestore(); // Optional, if you're using Firestore

// =========================
// Session setup
// =========================
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // secure: true only if using HTTPS
}));

// =========================
// Middleware
// =========================
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(bodyParser.json());
app.use(express.static('public'));

// =========================
// In-memory Data
// =========================
const users = [
  { email: 'user@example.com', password: 'password123' } // Replace with DB in real app
];
const rechargeHistory = [];
const supportTickets = [];

// =========================
// Helpers
// =========================
function generateOrderId() {
  return 'order_' + crypto.randomBytes(8).toString('hex');
}

// =========================
// Auth APIs
// =========================
app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email && u.password === password);
  if (user) {
    req.session.user = user;
    res.json({ success: true, email: user.email });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/session-status', (req, res) => {
  if (req.session.user) {
    res.json({ loggedIn: true, email: req.session.user.email });
  } else {
    res.json({ loggedIn: false });
  }
});

// =========================
// Firebase Test Route (Optional)
// =========================
app.get('/firebase-user/:email', async (req, res) => {
  try {
    const userRecord = await admin.auth().getUserByEmail(req.params.email);
    res.json(userRecord);
  } catch (error) {
    res.status(404).json({ error: 'User not found in Firebase' });
  }
});

// =========================
// Cashfree Payment API
// =========================
app.post('/create-order', async (req, res) => {
  try {
    const { amount, currency, customerEmail, customerPhone } = req.body;
    if (!amount || !currency || !customerEmail || !customerPhone) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const orderId = generateOrderId();
    const orderData = {
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

    const response = await axios.post(
      `${process.env.CASHFREE_API_URL}/orders`,
      orderData,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-version': '2022-09-01',
          'x-client-id': process.env.CASHFREE_APP_ID,
          'x-client-secret': process.env.CASHFREE_SECRET_KEY
        }
      }
    );

    const result = response.data;
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
    console.error('Cashfree Error:', err?.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      error: err.response?.data?.message || 'Payment initiation failed'
    });
  }
});

app.post('/verify-payment', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });

    const response = await axios.get(
      `${process.env.CASHFREE_API_URL}/orders/${orderId}`,
      {
        headers: {
          'x-api-version': '2022-09-01',
          'x-client-id': process.env.CASHFREE_APP_ID,
          'x-client-secret': process.env.CASHFREE_SECRET_KEY
        }
      }
    );

    const status = response.data.order_status;
    const idx = rechargeHistory.findIndex(r => r.orderId === orderId);
    if (idx !== -1) rechargeHistory[idx].status = status;

    res.json({
      orderStatus: status,
      paymentStatus: status === 'PAID' ? 'SUCCESS' : 'FAILED'
    });
  } catch (err) {
    console.error('Verification Error:', err?.response?.data || err.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// =========================
// Support Chat
// =========================
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

// =========================
// Recharge History
// =========================
app.get('/user-recharges', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const history = rechargeHistory.filter(r => r.email === email);
  res.json(history);
});

// =========================
// Default Route
// =========================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// =========================
// Server Start
// =========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
