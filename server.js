const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const path = require('path');
const axios = require('axios');
require('dotenv').config();
const { getFirestore } = require('firebase-admin/firestore');

const serviceAccount = require('./firebase-service-account.json');
const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = 'gautambhattar2005@gmail.com';

// Firebase Init
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = getFirestore();

// Cashfree (TEST mode) credentials
const CF_CLIENT_ID = process.env.CASHFREE_APP_ID;
const CF_CLIENT_SECRET = process.env.CASHFREE_SECRET_KEY;
const CF_ENV = 'https://sandbox.cashfree.com/pg';
const CF_AUTH_URL = `${CF_ENV}/v1/auth/login`;

app.use(express.static('public'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: false,
}));

function ensureAuth(req, res, next) {
  if (req.session.user) return next();
  return res.redirect('/login.html');
}

// Firebase Login
app.post('/sessionLogin', async (req, res) => {
  try {
    const decoded = await admin.auth().verifyIdToken(req.body.idToken);
    req.session.user = decoded;

    const userRef = db.collection('users').doc(decoded.uid);
    const doc = await userRef.get();
    if (!doc.exists) {
      await userRef.set({ wallet: 0, email: decoded.email });
    }

    res.send('Login success');
  } catch (err) {
    console.error('Login error:', err);
    res.status(401).send('Unauthorized');
  }
});

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', ensureAuth, (_, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));
app.get('/admin', ensureAuth, (req, res) => {
  if (req.session.user.email !== ADMIN_EMAIL) return res.status(403).send('Forbidden');
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});
app.get('/admin-balance', ensureAuth, (req, res) => {
  if (req.session.user.email !== ADMIN_EMAIL) return res.status(403).send('Forbidden');
  res.sendFile(path.join(__dirname, 'views', 'admin-balance.html'));
});
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login.html')));

// Session Info
app.get('/session-info', ensureAuth, async (req, res) => {
  try {
    const uid = req.session.user.uid;
    const doc = await db.collection('users').doc(uid).get();
    const wallet = doc.exists ? doc.data().wallet || 0 : 0;
    res.json({ email: req.session.user.email, balance: wallet });
  } catch (err) {
    res.status(500).send('Failed to get session info');
  }
});

// ✅ Cashfree Integration (TEST mode) with dynamic inputs
app.post("/create-order", ensureAuth, async (req, res) => {
  try {
    // Parse values from request body
    const orderAmount = typeof req.body.amount !== "undefined" ? Number(req.body.amount) : null;
    const customerEmail = req.body.customerEmail || req.session.user.email || "";
    const customerPhone = req.body.customerPhone || "9999999999";

    // Basic validations
    if (!orderAmount || isNaN(orderAmount) || orderAmount <= 0) {
      return res.status(400).send("Invalid or missing order amount");
    }
    if (!customerEmail || typeof customerEmail !== "string") {
      return res.status(400).send("Invalid or missing customer email");
    }
    if (!customerPhone || !/^\d{10}$/.test(customerPhone)) {
      return res.status(400).send("Invalid or missing customer phone");
    }

    // Authenticate with Cashfree
    const authRes = await axios.post(CF_AUTH_URL, {}, {
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': CF_CLIENT_ID,
        'x-client-secret': CF_CLIENT_SECRET
      }
    });

    const token = authRes.data.data.token;
    const orderId = "order_" + Date.now();

    // Prepare Cashfree order payload
    const orderPayload = {
      orderId: orderId,
      orderAmount: orderAmount,
      orderCurrency: "INR",
      customerDetails: {
        customerId: req.session.user.uid,
        customerEmail,
        customerPhone
      },
      orderMeta: {
        returnUrl: `http://localhost:${PORT}/payment-success?order_id=${orderId}&amount=${orderAmount}`
      }
    };

    // Create order
    const orderRes = await axios.post(`${CF_ENV}/orders`, orderPayload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });

    res.json({ payment_session_id: orderRes.data.data.payment_session_id });

  } catch (error) {
    console.error("Cashfree Error:", error.response?.data || error.message || error);
    res.status(500).send("Payment initiation failed");
  }
});

// ✅ Payment Success → Add balance
app.get('/payment-success', ensureAuth, async (req, res) => {
  const amount = parseInt(req.query.amount);
  const uid = req.session.user.uid;

  try {
    const userRef = db.collection('users').doc(uid);
    const doc = await userRef.get();
    const current = doc.exists ? doc.data().wallet || 0 : 0;
    await userRef.update({ wallet: current + amount });
    res.redirect('/dashboard');
  } catch (err) {
    res.status(500).send('Wallet update failed');
  }
});

// ✅ Place Order
app.post('/place-order', ensureAuth, async (req, res) => {
  const { url, service, amount } = req.body;
  const uid = req.session.user.uid;
  const orderAmount = parseInt(amount);

  try {
    const userRef = db.collection('users').doc(uid);
    const doc = await userRef.get();
    const balance = doc.exists ? doc.data().wallet || 0 : 0;

    if (balance < orderAmount) return res.send('❌ Not enough balance. Please recharge.');

    await userRef.update({ wallet: balance - orderAmount });

    await db.collection('orders').add({
      uid,
      email: req.session.user.email,
      url,
      service,
      amount: orderAmount,
      status: 'pending',
      createdAt: new Date()
    });

    res.send('✅ Order placed successfully!');
  } catch (err) {
    res.status(500).send('⚠️ Order failed');
  }
});

// ✅ My Orders
app.get('/my-orders', ensureAuth, async (req, res) => {
  try {
    const uid = req.session.user.uid;
    const snapshot = await db.collection('orders')
      .where('uid', '==', uid)
      .orderBy('createdAt', 'desc')
      .get();

    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(orders);
  } catch (err) {
    res.status(500).send('Failed to get orders');
  }
});

// ✅ Admin: All Orders
app.get('/admin-orders', ensureAuth, async (req, res) => {
  if (req.session.user.email !== ADMIN_EMAIL) return res.status(403).send('Forbidden');
  try {
    const snapshot = await db.collection('orders').orderBy('createdAt', 'desc').get();
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(orders);
  } catch (err) {
    res.status(500).send('Admin order fetch failed');
  }
});

// ✅ Admin: Update Order
app.post('/update-order', ensureAuth, async (req, res) => {
  const { orderId, status, message } = req.body;
  if (req.session.user.email !== ADMIN_EMAIL) return res.status(403).send('Forbidden');
  try {
    await db.collection('orders').doc(orderId).update({ status, message });
    res.send('✅ Order updated');
  } catch (err) {
    res.status(500).send('❌ Update failed');
  }
});

// ✅ Admin: Update Wallet
app.post('/admin-update-wallet', ensureAuth, async (req, res) => {
  if (req.session.user.email !== ADMIN_EMAIL) return res.status(403).send('Forbidden');
  const { email, balance } = req.body;
  try {
    const snap = await db.collection('users').where('email', '==', email).get();
    if (snap.empty) return res.status(404).send('User not found');
    await snap.docs[0].ref.update({ wallet: parseInt(balance) });
    res.send('✅ Wallet updated');
  } catch (err) {
    res.status(500).send('❌ Failed to update wallet');
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
