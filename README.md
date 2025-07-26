# YT Booster Site (Render-Ready)

## 🧾 Features
- Express.js backend
- Razorpay order API at `/create-order`
- Static frontend with Razorpay Checkout
- Deployable to Render.com

## 🚀 How to Deploy on Render

1. Push to GitHub
2. Create new Render Web Service:
   - Root Directory: `/`
   - Build Command: `npm install`
   - Start Command: `npm start`
3. Add Environment Variables:
   - `RAZORPAY_KEY_ID`
   - `RAZORPAY_KEY_SECRET`

## 🧪 Test
Visit `/` and click "Pay ₹99" to launch Razorpay Checkout.
