// Shared helpers for the Shop224 payment functions (Cloudflare Pages Functions).
// Prices live HERE, on the server, so a customer can never change what they pay.

export const PRODUCTS = {
  initial:        { name: 'Initial Necklace', price: 359, maxText: 3 },
  bracelet:       { name: 'Letter Bracelet',  price: 369, maxText: 7 },
  letternecklace: { name: 'Letter Necklace',  price: 369, maxText: 7 },
  studs:          { name: 'Stud Earrings',    price: 379, maxText: 2 },
};
// Black Friday sale: 15% off from Friday 27 to Monday 30 November 2026, South African time.
// The same dates and percentage are set in index.html. Change both together.
export const SALE = {
  start: Date.parse('2026-11-27T00:00:00+02:00'),
  end: Date.parse('2026-12-01T00:00:00+02:00'), // first moment after the sale
  percentOff: 15,
};

/** The price of one piece at a given moment, in rand. */
export function unitPrice(id, now = Date.now()) {
  const full = PRODUCTS[id].price;
  const onSale = now >= SALE.start && now < SALE.end;
  return onSale ? Math.round(full * (100 - SALE.percentOff)) / 100 : full;
}

/** The price an order line was sold at (saved at checkout, so it survives the sale ending). */
function linePrice(i) {
  return Number.isFinite(i.price) ? i.price : PRODUCTS[i.id].price;
}

export const METALS = { gold: 'Gold', silver: 'Silver' };
export const MAX_LINES = 20;
export const MAX_QTY = 9;

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function rand(n) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alike characters
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

const NO_CONTROL_OR_TAGS = /^[^\u0000-\u001f\u007f<>]+$/u;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function clean(v, max) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max + 1) : '';
}

/** Validate what the browser sent. Returns { error } or { customer, items, totalRand }. */
export function validateOrder(body) {
  if (!body || typeof body !== 'object') return { error: 'Invalid request.' };

  const c = body.customer || {};
  const customer = {
    name: clean(c.name, 100),
    email: clean(c.email, 200),
    phone: clean(c.phone, 30),
    // keep line breaks in the address
    address: typeof c.address === 'string'
      ? c.address.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n').slice(0, 401)
      : '',
  };
  if (!customer.name || customer.name.length > 100) return { error: 'Please enter your full name.' };
  if (!EMAIL.test(customer.email) || customer.email.length > 200) return { error: 'Please enter a valid email address.' };
  if (!/^[+0-9 ()-]{7,30}$/.test(customer.phone)) return { error: 'Please enter a valid cellphone number.' };
  if (!customer.address || customer.address.length > 400) return { error: 'Please enter your delivery address (up to 400 characters).' };
  if (!NO_CONTROL_OR_TAGS.test(customer.name)) return { error: 'Your name contains characters we cannot accept.' };
  if (!NO_CONTROL_OR_TAGS.test(customer.address.replace(/\n/g, ' '))) return { error: 'Your address contains characters we cannot accept.' };

  if (!Array.isArray(body.items) || body.items.length === 0) return { error: 'Your bag is empty.' };
  if (body.items.length > MAX_LINES) return { error: 'Your bag has too many lines. Please contact us to order in bulk.' };

  const items = [];
  const now = Date.now(); // one moment for the whole order
  let totalCents = 0;
  for (const raw of body.items) {
    const p = raw && PRODUCTS[raw.id];
    if (!p) return { error: 'One of the items in your bag is no longer available.' };
    if (!Object.prototype.hasOwnProperty.call(METALS, raw.metal)) return { error: 'Invalid metal choice.' };
    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (!text) return { error: `Please enter the text for your ${p.name}.` };
    if (text.length > p.maxText) return { error: `The ${p.name} takes up to ${p.maxText} letters.` };
    if (!NO_CONTROL_OR_TAGS.test(text)) return { error: `The text for your ${p.name} contains characters we cannot accept.` };
    const qty = Number(raw.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return { error: 'Invalid quantity.' };
    const price = unitPrice(raw.id, now);
    items.push({ id: raw.id, metal: raw.metal, text, qty, price });
    totalCents += Math.round(price * 100) * qty;
  }
  return { customer, items, totalRand: totalCents / 100 };
}

export function money(rand) {
  const s = Number.isInteger(rand) ? String(rand) : rand.toFixed(2);
  return 'R' + s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function describeItems(items) {
  return items.map((i, n) => {
    const p = PRODUCTS[i.id];
    return `${n + 1}. ${p.name} | ${METALS[i.metal]} | Personalisation text: "${i.text}" | Qty: ${i.qty} | ${money(Math.round(linePrice(i) * 100) * i.qty / 100)}`;
  }).join('\n');
}

export function orderTotal(items) {
  return items.reduce((t, i) => t + Math.round(linePrice(i) * 100) * i.qty, 0) / 100;
}

/** Send a plain-text email through Resend. Never throws: returns { ok, status }. */
export async function sendEmail(env, { subject, text, replyTo, to }) {
  const recipient = to || env.ORDER_TO_EMAIL; // default: the shop owner
  if (!env.RESEND_API_KEY || !recipient) return { ok: false, status: 0, reason: 'email not configured' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.ORDER_FROM_EMAIL || 'Shop224 Orders <onboarding@resend.dev>',
        to: [recipient],
        subject,
        text,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, reason: String(e && e.message || e) };
  }
}

export function customerBlock(c) {
  return `Name: ${c.name}\nEmail: ${c.email}\nCellphone: ${c.phone}\nDelivery address:\n${c.address}`;
}

/** The confirmation the customer receives once Yoco has confirmed their payment. */
export function customerConfirmation({ orderRef, customerName, items, paidRand }) {
  const first = String(customerName || '').split(' ')[0] || 'there';
  return [
    `Hi ${first},`,
    '',
    'Thank you for your order. Your payment has been received.',
    '',
    `Order reference: ${orderRef}`,
    '',
    'Your order:',
    describeItems(items),
    '',
    `Total paid: ${money(paidRand)} (shipping and delivery are free)`,
    '',
    'What happens next:',
    '- We make your personalised piece in 3 to 5 business days.',
    '- It is then delivered to you in 2 to 3 weeks.',
    '',
    'Every piece is made with the text you entered, so orders cannot be returned for a change of mind or a typo.',
    '',
    'If you have a question, reply to this email and quote your order reference.',
    '',
    'Today. Tomorrow. Forever',
    'Shop224',
  ].join('\n');
}
