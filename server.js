const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors({ origin: 'https://shophomura.com' }));
app.use(express.json());

const SHOPIFY_STORE = '://myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SIKKPAY_KEY = process.env.SIKKPAY_KEY;
const SIKKPAY_SECRET = process.env.SIKKPAY_SECRET;
const SIKKPAY_BASE = 'https://sikkpay.org';

// 1. Create Draft Order with Shipping Info & Get Sikkpay Link
app.post('/create-payment', async (req, res) => {
  try {
    const { email, name, phone, address, city, variantId, quantity, amount } = req.body;
    const nameParts = (name || 'Customer').trim().split(' ');
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(' ') || '.';

    const draft = await axios.post(
      `https://${SHOPIFY_STORE}/admin/api/2026-10/draft_orders.json`,
      {
        draft_order: {
          line_items: [{ variant_id: variantId, quantity: quantity || 1 }],
          email,
          note: `WhatsApp/Phone: ${phone}`,
          shipping_address: {
            first_name: firstName,
            last_name: lastName,
            address1: address,
            city: city,
            country: 'Pakistan',
            phone: phone
          }
        }
      },
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
    );

    const draftId = String(draft.data.draft_order.id);
    const wholeAmount = Math.round(Number(amount));

    const payment = await axios.post(
      `${SIKKPAY_BASE}/payments`,
      {
        amount: wholeAmount,
        order_id: draftId,
        description: `HOMURA Order ${draftId}`,
        return_url: `https://shophomura.com{draftId}`
      },
      {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-Sikkpay-Key': SIKKPAY_KEY,
          'X-Sikkpay-Secret': SIKKPAY_SECRET
        }
      }
    );

    res.json({
      orderId: draftId,
      payUrl: payment.data.payment.pay_url
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// 2. Check if customer paid (so the popup auto-redirects them)
app.get('/check-status/:orderId', async (req, res) => {
  try {
    const check = await axios.get(
      `${SIKKPAY_BASE}/payments/${req.params.orderId}`,
      {
        headers: {
          'Accept': 'application/json',
          'X-Sikkpay-Key': SIKKPAY_KEY,
          'X-Sikkpay-Secret': SIKKPAY_SECRET
        }
      }
    );
    res.json({ status: check.data.payment?.status || 'open' });
  } catch (err) {
    res.json({ status: 'open' });
  }
});

// 3. Sikkpay Webhook to mark Shopify order Paid
app.post('/sikkpay/webhook', async (req, res) => {
  try {
    const event = req.body;
    const paymentObj = event.payment || event.data || event;
    const draftId = paymentObj.order_id;

    if ((event.event === 'payment.paid' || paymentObj.status === 'paid') && draftId) {
      await axios.put(
        `https://${SHOPIFY_STORE}/admin/api/2026-10/draft_orders/${draftId}/complete.json`,
        {},
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
      );
    }
    res.sendStatus(200);
  } catch (err) {
    res.sendStatus(500);
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Live'));


