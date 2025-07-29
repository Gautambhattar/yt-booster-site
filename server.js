const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config();

// --- Firebase Initialization ---
// Make sure your FIREBASE_CONFIG env variable is the full JSON string
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

// --- Middleware Setup ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));

// --- Authentication Middleware ---
function ensureAuth(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login.html');
}

function ensureAdmin(req, res, next) {
    if (!req.session.user || req.session.user.email !== ADMIN_EMAIL) {
      return res.status(403).send('Forbidden: Admin access required.');
    }
    next();
}

// --- Routes ---

// Static file and login/logout routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', ensureAuth, (_, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));
app.get('/admin', ensureAuth, ensureAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views', 'admin.html')));
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login.html')));

// Firebase session login
app.post('/sessionLogin', async (req, res) => {
  try {
    const decoded = await admin.auth().verifyIdToken(req.body.idToken);
    req.session.user = decoded;

    const userRef = db.collection('users').doc(decoded.uid);
    const doc = await userRef.get();
    if (!doc.exists) {
      await userRef.set({ wallet: 0, email: decoded.email, role: 'user' });
    }

    res.send('Login success');
  } catch (err) {
    console.error('Login error:', err);
    res.status(401).send('Unauthorized');
  }
});

// --- User Dashboard APIs ---

// Get user session info (wallet, email, role)
app.get('/session-info', ensureAuth, async (req, res) => {
  try {
    const uid = req.session.user.uid;
    const doc = await db.collection('users').doc(uid).get();
    const userData = doc.exists ? doc.data() : { wallet: 0, email: req.session.user.email };
    res.json({ email: userData.email, balance: userData.wallet || 0, role: userData.email === ADMIN_EMAIL ? 'admin' : 'user' });
  } catch (err) {
    res.status(500).send('Failed to get session info');
  }
});

// Place an order
app.post('/place-order', ensureAuth, async (req, res) => {
  try {
    const { url, service, amount } = req.body;
    const uid = req.session.user.uid;
    const orderAmount = parseInt(amount);

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

// Get user's orders
app.get('/my-orders', ensureAuth, async (req, res) => {
  try {
    const snapshot = await db.collection('orders')
      .where('uid', '==', req.session.user.uid)
      .orderBy('createdAt', 'desc')
      .get();
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(orders);
  } catch (err) {
    res.status(500).send('Failed to get orders');
  }
});

// Submit a manual recharge request with UTR
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

// --- Admin Panel APIs ---

// Admin: Get all orders
app.get('/admin-orders', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('orders').orderBy('createdAt', 'desc').get();
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(orders);
  } catch (err) {
    res.status(500).send('Admin order fetch failed');
  }
});

// Admin: Update an order
app.post('/update-order', ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const { orderId, status, message } = req.body;
    await db.collection('orders').doc(orderId).update({ status, message: message || '' });
    res.send('✅ Order updated');
  } catch (err) {
    res.status(500).send('❌ Update failed');
  }
});

// Admin: Update user wallet manually
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

// Admin: Get pending recharge requests
app.get('/admin-recharge-requests', ensureAuth, ensureAdmin, async (req, res) => {
    try {
      const snapshot = await db.collection('rechargeRequests').where('status', '==', 'pending').orderBy('createdAt', 'asc').get();
      const requests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      res.json(requests);
    } catch (err) {
      res.status(500).send('Failed to fetch recharge requests');
    }
});

// Admin: Approve or reject a recharge request
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
            } else { // 'rejected'
                t.update(requestRef, { status: 'rejected' });
            }
        });
        res.send(`Request has been ${status}.`);
    } catch (err) {
        res.status(500).send(err.message || 'Failed to update recharge status.');
    }
});


app.listen(PORT, () => {
  console.log(`✅ Server is running on http://localhost:${PORT}`);
});
