require('dotenv').config();
const crypto = require('crypto');

// 1. Enter the exact reference from your Supabase 'orders' table!
const TARGET_REFERENCE = "T197104581511115"; 

// 2. This is the exact fake JSON payload Paystack sends
const mockPayload = {
  event: 'charge.success',
  data: {
    reference: TARGET_REFERENCE,
    amount: 612000000,
    status: 'success'
  }
};

const payloadString = JSON.stringify(mockPayload);

// 3. We digitally sign the payload using your secret key (acting as Paystack)
const secret = process.env.PAYSTACK_SECRET_KEY.replace(/['"]/g, '').trim();
const signature = crypto
  .createHmac('sha512', secret)
  .update(payloadString)
  .digest('hex');

// 4. Fire the payload at your local server
console.log(`🚀 Simulating Paystack 'charge.success' for reference: ${TARGET_REFERENCE}...`);

fetch('http://localhost:3000/paystack-webhook', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-paystack-signature': signature // The golden ticket!
  },
  body: payloadString
})
.then(async (res) => {
  console.log(`✅ Webhook hit! Server responded with HTTP ${res.status}`);
})
.catch(err => console.error("🔴 Error hitting webhook:", err));