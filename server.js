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

app.post('/create-payment', async (req, res) => {
  try {
    const { email, variantId, quantity, amount } = req.body;
    const draft = await axios.post(
      `https://${SHOPIFY_STORE}/admin/api/2026-10/draft_orders.json`,
      {
        draft_order: {
          line_items: [{ variant_id: variantId, quantity: quantity || 1 }],
          email
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

    res.json({ payUrl: payment.data.payment.pay_url });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

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
    console.error(err.response?.data || err.message);
    res.sendStatus(500);
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Live'));
