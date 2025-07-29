const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const path = require('path');
const axios = require('axios');
require('dotenv').config();
const { getFirestore } = require('firebase-admin/firestore');

// Firebase Init
const serviceAccount = JSON.parse(process.env.FIRconst express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config();

const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

app.use(express.static('public'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));

function ensureAuth(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login.html');
}

app.post('/sessionLogin', async (req, res) => {
  try {
    const decoded = await admin.auth().verifyIdToken(req.body.idToken);
    req.session.user = decoded;

    const userRef = db.collection('users').doc(decoded.uid);
    const doc = await userRef.get();
    if (!doc.exists) {
      // Initialize user wallet and email if not exist
      await userRef.set({ wallet: 0, email: decoded.email });
    }

    res.send('Login success');
  } catch (err) {
    console.error('Login error:', err);
    res.status(401).send('Unauthorized');
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', ensureAuth, (_, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));
app.get('/admin', ensureAuth, (req, res) => {
  if (req.session.user.email !== ADMIN_EMAIL) return res.status(403).send('Forbidden');
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login.html')));

// User session info including wallet and email
app.get('/session-info', ensureAuth, async (req, res) => {
  try {
    const uid = req.session.user.uid;
    const doc = await db.collection('users').doc(uid).get();
    const wallet = doc.exists ? doc.data().wallet || 0 : 0;
    res.json({ email: req.session.user.email, balance: wallet, role: req.session.user.email === ADMIN_EMAIL ? 'admin' : 'user' });
  } catch (err) {
    res.status(500).send('Failed to get session info');
  }
});

// Place order: Check wallet balance, deduct, create order
app.post('/place-order', ensureAuth, async (req, res) => {
  try {
    const { url, service, amount } = req.body;
    const uid = req.session.user.uid;
    const orderAmount = parseInt(amount);

    if (!url || !service || !orderAmount || orderAmount <= 0) {
      return res.status(400).send('Invalid order data');
    }

    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    const balance = userDoc.exists ? userDoc.data().wallet || 0 : 0;

    if (balance < orderAmount) return res.send('❌ Not enough balance. Please recharge.');

    // Atomic update with Firestore transaction
    await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      const currentBalance = doc.data().wallet || 0;
      if (currentBalance < orderAmount) throw new Error('Insufficient balance');
      t.update(userRef, { wallet: currentBalance - orderAmount });
      const ordersRef = db.collection('orders').doc();
      t.set(ordersRef, {
        uid,
        email: req.session.user.email,
        url,
        service,
        amount: orderAmount,
        status: 'pending',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        message: '',
      });
    });

    res.send('✅ Order placed successfully!');
  } catch (err) {
    console.error('Place order error:', err);
    res.status(500).send('⚠️ Order failed');
  }
});

// Get user's orders sorted by creation date
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
    console.error('Get my orders:', err);
    res.status(500).send('Failed to get orders');
  }
});

// Manual recharge request with UTR for admin approval
app.post('/manual-recharge-request', ensureAuth, async (req, res) => {
  try {
    const { amount, email, mobile, utr, method } = req.body;
    if (!amount || !email || !mobile || !utr) {
      return res.status(400).send('Missing recharge data');
    }
    await db.collection('rechargeRequests').add({
      email,
      amount: parseInt(amount),
      mobile,
      utr,
      method,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ ok: true, message: 'Recharge request submitted for admin approval' });
  } catch (err) {
    console.error('Recharge request error:', err);
    res.status(500).send('Failed to submit recharge request');
  }
});

// Admin routes validation middleware
function ensureAdmin(req, res, next) {
  if (!req.session.user || req.session.user.email !== ADMIN_EMAIL) {
    return res.status(403).send('Forbidden');
  }
  next();
}

// Admin: get all orders
app.get('/admin-orders', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('orders').orderBy('createdAt', 'desc').get();
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(orders);
  } catch (err) {
    console.error('Admin get orders error:', err);
    res.status(500).send('Admin order fetch failed');
  }
});

// Admin: update order status/message
app.post('/update-order', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const { orderId, status, message } = req.body;
    if (!orderId || !status) return res.status(400).send('Missing parameters');
    await db.collection('orders').doc(orderId).update({ status, message: message || '' });
    res.send('✅ Order updated');
  } catch (err) {
    console.error('Admin update order error:', err);
    res.status(500).send('❌ Update failed');
  }
});

// Admin: update user wallet
app.post('/admin-update-wallet', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const { email, balance } = req.body;
    if (!email || balance === undefined) return res.status(400).send('Missing parameters');
    const usersRef = db.collection('users');
    const snap = await usersRef.where('email', '==', email).get();
    if (snap.empty) return res.status(404).send('User not found');
    await snap.docs[0].ref.update({ wallet: parseInt(balance) });
    res.send('✅ Wallet updated');
  } catch (err) {
    console.error('Admin update wallet error:', err);
    res.status(500).send('❌ Failed to update wallet');
  }
});

// Add additional APIs as per your frontend requirements here...

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
EBASE_CONFIG);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = getFirestore();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

// Cashfree credentials and environment config
const CF_CLIENT_ID = process.env.CASHFREE_APP_ID;
const CF_CLIENT_SECRET = process.env.CASHFREE_SECRET_KEY;
const IS_PROD = process.env.NODE_ENV === 'production';
const CF_ENV = IS_PROD ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com';
const CF_AUTH_URL = `${CF_ENV}/v1/auth/login`;

app.use(express.static('public'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET,
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

// ✅ Cashfree: Create Order with user input (production-ready)
app.post("/create-order", ensureAuth, async (req, res) => {
  try {
    const { amount, customerEmail, customerPhone, returnUrl } = req.body;
    const orderAmount = Number(amount);
    const email = customerEmail || req.session.user.email;
    const phone = customerPhone || "9999999999";

    if (!orderAmount || isNaN(orderAmount) || orderAmount <= 0) {
      return res.status(400).send("Invalid or missing order amount");
    }
    if (!email || typeof email !== "string") {
      return res.status(400).send("Invalid or missing customer email");
    }
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).send("Invalid or malformed customer phone number");
    }

    const authRes = await axios.post(CF_AUTH_URL, {}, {
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': CF_CLIENT_ID,
        'x-client-secret': CF_CLIENT_SECRET
      }
    });

    const token = authRes.data.data.token;
    const orderId = `order_${Date.now()}`;

    const orderPayload = {
      orderId,
      orderAmount,
      orderCurrency: "INR",
      customerDetails: {
        customerId: req.session.user.uid,
        customerEmail: email,
        customerPhone: phone
      },
      orderMeta: {
        returnUrl: returnUrl || `${req.protocol}://${req.get('host')}/payment-success?order_id=${orderId}&amount=${orderAmount}`
      }
    };

    const orderRes = await axios.post(`${CF_ENV}/pg/orders`, orderPayload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });

    res.json({
      success: true,
      payment_session_id: orderRes.data.data.payment_session_id,
      order_id: orderId
    });

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
