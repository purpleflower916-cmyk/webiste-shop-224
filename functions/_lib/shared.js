// Shared helpers for the Shop224 payment functions (Cloudflare Pages Functions).
// Prices live HERE, on the server, so a customer can never change what they pay.

export const PRODUCTS = {
  initial:        { name: 'Initial Necklace', price: 359, maxText: 3 },
  bracelet:       { name: 'Letter Bracelet',  price: 369, maxText: 7 },
  letternecklace: { name: 'Letter Necklace',  price: 369, maxText: 7 },
  studs:          { name: 'Stud Earrings',    price: 379, maxText: 2 },
};
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
  let totalRand = 0;
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
    items.push({ id: raw.id, metal: raw.metal, text, qty });
    totalRand += p.price * qty;
  }
  return { customer, items, totalRand };
}

export function money(rand) {
  return 'R' + String(rand).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function describeItems(items) {
  return items.map((i, n) => {
    const p = PRODUCTS[i.id];
    return `${n + 1}. ${p.name} | ${METALS[i.metal]} | Personalisation text: "${i.text}" | Qty: ${i.qty} | ${money(p.price * i.qty)}`;
  }).join('\n');
}

export function orderTotal(items) {
  return items.reduce((t, i) => t + PRODUCTS[i.id].price * i.qty, 0);
}

/** Send a plain-text email through Resend. Never throws: returns { ok, status }. */
export async function sendEmail(env, { subject, text, replyTo }) {
  if (!env.RESEND_API_KEY || !env.ORDER_TO_EMAIL) return { ok: false, status: 0, reason: 'email not configured' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.ORDER_FROM_EMAIL || 'Shop224 Orders <onboarding@resend.dev>',
        to: [env.ORDER_TO_EMAIL],
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
