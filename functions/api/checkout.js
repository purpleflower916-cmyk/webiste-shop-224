// POST /api/checkout
// Validates the bag against server-side prices, creates a Yoco checkout and
// returns the Yoco payment page address. Card details never touch this site.

import { json, rand, validateOrder, describeItems, customerBlock, sendEmail, money } from '../_lib/shared.js';

const YOCO_CHECKOUTS = 'https://payments.yoco.com/api/checkouts';

export async function onRequestPost({ request, env }) {
  const site = (env.SITE_URL || 'https://shop224.co.za').replace(/\/+$/, '');

  if (!env.YOCO_SECRET_KEY) return json({ error: 'Payments are not set up yet. Please email us to complete your order.' }, 503);

  // Only accept requests that come from our own site
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin && origin !== site) return json({ error: 'Request not allowed.' }, 403);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400); }

  // Honeypot: real customers never fill this in
  if (body && body.company) return json({ error: 'Request not allowed.' }, 400);

  const v = validateOrder(body);
  if (v.error) return json({ error: v.error }, 400);

  const orderRef = 'S224-' + rand(6);
  const amount = v.totalRand * 100; // Yoco wants cents

  // Everything we need to email the order once Yoco confirms payment
  const metadata = {
    orderRef,
    customerName: v.customer.name,
    customerEmail: v.customer.email,
    customerPhone: v.customer.phone,
    deliveryAddress: v.customer.address,
    items: JSON.stringify(v.items),
    expectedAmount: String(amount),
  };

  let yoco;
  try {
    const res = await fetch(YOCO_CHECKOUTS, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.YOCO_SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount,
        currency: 'ZAR',
        successUrl: `${site}/thanks?ref=${orderRef}`,
        cancelUrl: `${site}/#bag`,
        failureUrl: `${site}/?checkout=failed#bag`,
        metadata,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.redirectUrl) {
      console.log('Yoco checkout error', res.status, JSON.stringify(data).slice(0, 500));
      return json({ error: 'We could not start your payment. Please try again, or email us.' }, 502);
    }
    yoco = data;
  } catch (e) {
    console.log('Yoco checkout request failed', String(e && e.message || e));
    return json({ error: 'We could not reach the payment service. Please try again in a moment.' }, 502);
  }

  // Safety net: tell the owner about the order straight away, marked as NOT PAID.
  if (env.SEND_PENDING_EMAIL !== 'false') {
    await sendEmail(env, {
      subject: `Payment started ${orderRef} (NOT PAID YET) ${money(v.totalRand)}`,
      replyTo: v.customer.email,
      text: [
        `A customer has been sent to the Yoco payment page. This order is NOT PAID until you receive a "PAID" email for ${orderRef}.`,
        '',
        `Order reference: ${orderRef}`,
        `Yoco checkout id: ${yoco.id || 'unknown'}`,
        '',
        customerBlock(v.customer),
        '',
        'Items:',
        describeItems(v.items),
        '',
        `Total (delivery free): ${money(v.totalRand)}`,
      ].join('\n'),
    });
  }

  return json({ redirectUrl: yoco.redirectUrl, orderRef });
}

// Any other method
export async function onRequest() {
  return json({ error: 'Method not allowed.' }, 405);
}
