document.addEventListener('DOMContentLoaded', () => {
  const cashfreeCF = Cashfree({ mode: 'sandbox' }); // Change to 'production' when deploying live
  const form = document.getElementById('paymentForm');
  const messageDiv = document.getElementById('message');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = document.getElementById('amount').value;
    const email = document.getElementById('email').value;
    const phone = document.getElementById('phone').value;

    if (!amount || !email || !phone || phone.length !== 10) {
      messageDiv.textContent = '⚠️ Please enter valid inputs.';
      return;
    }

    messageDiv.textContent = 'Creating order...';
    form.querySelector('button').disabled = true;

    try {
      const createResp = await fetch('/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, currency: 'INR', customerEmail: email, customerPhone: phone })
      });

      if (!createResp.ok) {
        const errText = await createResp.text();
        throw new Error(errText);
      }

      const { paymentSessionId } = await createResp.json();
      cashfreeCF.checkout({ paymentSessionId, redirectTarget: '_self' });

    } catch (err) {
      console.error('Checkout Error:', err);
      messageDiv.textContent = '❌ Payment failed. Please try again.';
    } finally {
      form.querySelector('button').disabled = false;
    }
  });

  // After redirect from Cashfree
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
