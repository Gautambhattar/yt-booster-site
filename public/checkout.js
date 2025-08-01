document.addEventListener('DOMContentLoaded', () => {
  const cashfree = Cashfree({ mode: 'TEST' }); // Change to 'PROD' in production
  const form = document.getElementById('paymentForm');
  const messageDiv = document.getElementById('message');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    messageDiv.textContent = 'Initiating payment...';

    const amount = document.getElementById('amount').value;
    const email = document.getElementById('email').value;
    const phone = document.getElementById('phone').value;

    try {
      // 1. Create order
      const createResp = await fetch('/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, currency: 'INR', customerEmail: email, customerPhone: phone })
      });

      const data = await createResp.json();

      if (!data.paymentSessionId) {
        throw new Error('Invalid response from server');
      }

      // 2. Show animation and hide form
      document.getElementById("redirectAnimation").style.display = "block";
      document.getElementById("paymentForm").style.display = "none";

      // 3. Invoke Cashfree Checkout
      cashfree.checkout({
        paymentSessionId: data.paymentSessionId,
        redirectTarget: "_self"
      });
    } catch (err) {
      console.error('Checkout Error:', err);
      messageDiv.textContent = 'Failed to initiate payment.';
    }
  });

  // Handle return from Cashfree
  if (window.location.pathname === '/payment-success') {
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get('order_id');
    if (orderId) {
      fetch('/verify-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId })
      })
      .then(res => res.json())
      .then(data => {
        document.body.innerHTML = document.getElementById('successPage').innerHTML;
        document.getElementById('status').textContent = `Order ${orderId}: ${data.paymentStatus}`;
      });
    }
  }
});
