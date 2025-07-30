const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const path = require('path');
const multer = require('multer');
require('dotenv').config();

// --- Firebase Initialization ---
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

// -- Multer for QR uploads --
const upload = multer({ dest: path.join(__dirname, 'public', 'uploads') });

// --- Middleware ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

// --- Auth Middlewares ---
function ensureAuth(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login.html');
}
function ensureAdmin(req, res, next) {
  if (req.session.user && req.session.user.email === ADMIN_EMAIL) return next();
  res.status(403).send('Forbidden: Admin access required.');
}

// --- Static Entry Points ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', ensureAuth, (req, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));
app.get('/admin', ensureAuth, ensureAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views', 'admin.html')));
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login.html')));

// --- Firebase Session Login ---
app.post('/sessionLogin', async (req, res) => {
  try {
    if (!req.body.idToken) return res.status(400).send('idToken missing');
    const decoded = await admin.auth().verifyIdToken(req.body.idToken);
    req.session.user = decoded;
    const userRef = db.collection('users').doc(decoded.uid);
    const doc = await userRef.get();
    if (!doc.exists) {
      await userRef.set({
        wallet: 0,
        email: decoded.email,
        role: decoded.email === ADMIN_EMAIL ? 'admin' : 'user',
        referralCode: genReferralCode(decoded.email),
      });
    }
    res.send('Login success');
  } catch (err) {
    console.error('Login error:', err);
    res.status(401).send(process.env.NODE_ENV === 'development' ?
      `Unauthorized: ${err.message}` : 'Unauthorized');
  }
});

// --- Session info endpoints ---
app.get('/session-info', ensureAuth, async (req, res) => {
  try {
    const uid = req.session.user.uid;
    const doc = await db.collection('users').doc(uid).get();
    const userData = doc.exists ? doc.data() : {};
    res.json({
      email: userData.email,
      balance: userData.wallet || 0,
      role: userData.email === ADMIN_EMAIL ? 'admin' : (userData.role || 'user'),
      referralCode: userData.referralCode || ''
    });
  } catch (err) {
    res.status(500).send('Failed to get session info');
  }
});
app.get('/api/user-details', ensureAuth, async (req, res) => {
  try {
    const uid = req.session.user.uid;
    const doc = await db.collection('users').doc(uid).get();
    const userData = doc.exists ? doc.data() : {};
    res.json({
      email: userData.email,
      referralCode: userData.referralCode || '',
    });
  } catch (err) {
    res.status(500).send('Failed to fetch user details');
  }
});

// --- Payment Info (Public, used by all) ---
app.get('/payment-info', async (req, res) => {
  try {
    const snap = await db.collection('settings').doc('payment').get();
    const data = snap.exists ? snap.data() : {};
    res.json({
      upiId: data.upiId || '',
      qrImageUrl: data.qrImageUrl || '/qr.png', // default static image
    });
  } catch (err) {
    res.status(500).send('Failed to fetch payment info');
  }
});

// --- ADMIN updates payment info (UPI/QR) ---
app.post('/admin/update-payment-info', ensureAuth, ensureAdmin, upload.single('qrImage'), async (req, res) => {
  try {
    const upiId = req.body.upiId || '';
    let data = { upiId };
    if (req.file) {
      data.qrImageUrl = '/uploads/' + req.file.filename;
    }
    await db.collection('settings').doc('payment').set(data, { merge: true });
    res.send('Payment info updated');
  } catch (err) {
    res.status(500).send('Failed to update payment info');
  }
});

// --- Place order ---
app.post('/place-order', ensureAuth, async (req, res) => {
  try {
    const { url, service, amount } = req.body;
    const orderAmount = parseInt(amount);
    if (!url || !service || isNaN(orderAmount) || orderAmount <= 0) {
      return res.status(400).send('Invalid order data');
    }
    const uid = req.session.user.uid;
    const userRef = db.collection('users').doc(uid);
    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      const balance = userDoc.exists ? userDoc.data().wallet || 0 : 0;
      if (balance < orderAmount) throw new Error('Not enough balance. Please recharge.');
      t.update(userRef, { wallet: balance - orderAmount });
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
    res.status(400).send(`⚠️ ${err.message}`);
  }
});

// --- User's own orders ---
app.get('/my-orders', ensureAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('orders')
      .where('uid', '==', req.session.user.uid)
      .orderBy('createdAt', 'desc').get();
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(orders);
  } catch (err) {
    res.status(500).send('Failed to get orders');
  }
});

// --- Manual recharge for wallet ---
app.post('/manual-recharge-request', ensureAuth, async (req, res) => {
  try {
    const { amount, email, mobile, utr, method } = req.body;
    if (!amount || !email || !mobile || !utr) return res.status(400).send('Missing recharge data');
    await db.collection('rechargeRequests').add({
      email,
      amount: parseInt(amount),
      mobile,
      utr,
      method,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).send('Failed to submit recharge request');
  }
});

// --- SUPPORT CHAT LOGIC ---
// Get support messages (user or admin with ?user param)
app.get('/support-messages', ensureAuth, async (req, res) => {
  try {
    let forEmail = req.session.user.email;
    if (req.session.user.email === ADMIN_EMAIL && req.query.user) {
      forEmail = req.query.user;
    }
    const snap = await db.collection('supportMessages').doc(forEmail)
      .collection('messages').orderBy('timestamp', 'asc').get();
    const msgs = snap.docs.map(doc => doc.data());
    res.json(msgs);
  } catch (err) {
    res.status(500).send('Failed to fetch messages');
  }
});
// List support users (for admin)
app.get('/support-users', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const snaps = await db.collection('supportMessages').get();
    const users = snaps.docs.map(doc => doc.id);
    res.json(users);
  } catch (err) {
    res.status(500).send('Failed to fetch support users');
  }
});
// Send support message (user or admin to specific user)
app.post('/support-message', ensureAuth, async (req, res) => {
  try {
    const { message, to } = req.body;
    if (!message) return res.status(400).send('No message');
    const sender = req.session.user.email;
    let userEmail = sender;
    if (sender === ADMIN_EMAIL && to) userEmail = to;
    await db.collection('supportMessages').doc(userEmail)
      .collection('messages').add({
        from: sender === ADMIN_EMAIL ? 'admin' : sender,
        message,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).send('Failed to send message');
  }
});

// --- ADMIN: user recharge history ---
app.get('/user-recharges', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const email = req.query.email;
    const snaps = await db.collection('rechargeRequests')
      .where('email', '==', email)
      .orderBy('createdAt', 'desc')
      .get();
    const history = snaps.docs.map(doc => {
      const d = doc.data();
      return {
        ...d,
        timestamp: d.createdAt,
        txnId: d.utr || ''
      };
    });
    res.json(history);
  } catch (err) {
    res.status(500).send('Failed to fetch recharge history');
  }
});

// --- Referral code submission ---
app.post('/submit-referral', ensureAuth, async (req, res) => {
  try {
    const code = (req.body.code || '').trim().toUpperCase();
    if (!code) return res.status(400).send('No referral code entered');
    const uid = req.session.user.uid;
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(400).send('User not found');
    const userData = userDoc.data();
    if (userData.referralCode === code) return res.status(400).send('You cannot refer yourself.');
    const codeQuery = await db.collection('users').where('referralCode', '==', code).limit(1).get();
    if (codeQuery.empty) return res.status(400).send('Invalid referral code.');
    // Referral reward logic here
    res.send('Referral submitted successfully!');
  } catch (err) {
    res.status(500).send('Failed to submit referral code.');
  }
});

// --- ADMIN PANEL ENDPOINTS ---
// List all orders
app.get('/admin-orders', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('orders').orderBy('createdAt', 'desc').get();
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(orders);
  } catch (err) {
    res.status(500).send('Admin order fetch failed');
  }
});
app.post('/update-order', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const { orderId, status, message } = req.body;
    await db.collection('orders').doc(orderId).update({ status, message: message || '' });
    res.send('✅ Order updated');
  } catch (err) {
    res.status(500).send('❌ Update failed');
  }
});
app.get('/admin-recharge-requests', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('rechargeRequests').where('status', '==', 'pending').orderBy('createdAt', 'asc').get();
    const requests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(requests);
  } catch (err) {
    res.status(500).send('Failed to fetch recharge requests');
  }
});
app.post('/admin-update-recharge-status', ensureAuth, ensureAdmin, async (req, res) => {
  const { requestId, status } = req.body;
  if (!requestId || !['approved', 'rejected'].includes(status)) {
    return res.status(400).send('Invalid parameters');
  }
  const requestRef = db.collection('rechargeRequests').doc(requestId);
  try {
    await db.runTransaction(async (t) => {
      const requestDoc = await t.get(requestRef);
      if (!requestDoc.exists || requestDoc.data().status !== 'pending') throw new Error('Request already processed.');
      if (status === 'approved') {
        const { email, amount } = requestDoc.data();
        const userQuery = await db.collection('users').where('email', '==', email).limit(1).get();
        if (userQuery.empty) throw new Error(`User ${email} not found.`);
        const userRef = userQuery.docs[0].ref;
        const userDoc = await t.get(userRef);
        const currentBalance = userDoc.data().wallet || 0;
        t.update(userRef, { wallet: currentBalance + amount });
        t.update(requestRef, { status: 'approved' });
      } else {
        t.update(requestRef, { status: 'rejected' });
      }
    });
    res.send(`Request has been ${status}.`);
  } catch (err) {
    res.status(500).send(err.message || 'Failed to update recharge status.');
  }
});
app.post('/admin-update-wallet', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const { email, balance } = req.body;
    const userQuery = await db.collection('users').where('email', '==', email).limit(1).get();
    if (userQuery.empty) return res.status(404).send('User not found');
    const userRef = userQuery.docs[0].ref;
    await userRef.update({ wallet: parseInt(balance) });
    res.send('✅ Wallet updated');
  } catch (err) {
    res.status(500).send('❌ Failed to update wallet');
  }
});

// --- Helper to generate referral code ---
function genReferralCode(email) {
  return (email.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 8) + Math.floor(100 + Math.random() * 900)).slice(0, 10);
}

// --- Listen ---
app.listen(PORT, () => {
  console.log(`✅ Server is running on http://localhost:${PORT}`);
});
