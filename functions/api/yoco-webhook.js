// POST /api/yoco-webhook
// Yoco calls this when a payment succeeds. We verify the signature, then email
// the order to the shop owner. Only this email means the order is PAID.

import { json, PRODUCTS, METALS, describeItems, orderTotal, money, sendEmail } from '../_lib/shared.js';

const enc = new TextEncoder();

function b64ToBytes(b64) {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function bytesToB64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Standard Webhooks style check: HMAC-SHA256 over "id.timestamp.body" with the whsec_ secret. */
export async function verifySignature(rawBody, headers, secretsCsv) {
  const id = headers.get('webhook-id');
  const ts = headers.get('webhook-timestamp');
  const sigHeader = headers.get('webhook-signature');
  if (!id || !ts || !sigHeader || !secretsCsv) return false;

  const provided = sigHeader.split(' ')
    .map((p) => p.split(','))
    .filter((p) => p[0] === 'v1' && p[1])
    .map((p) => p[1]);
  if (!provided.length) return false;

  for (const secret of secretsCsv.split(',').map((s) => s.trim()).filter(Boolean)) {
    let keyBytes;
    try { keyBytes = b64ToBytes(secret.replace(/^whsec_/, '')); } catch { continue; }
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const expected = bytesToB64(await crypto.subtle.sign('HMAC', key, enc.encode(`${id}.${ts}.${rawBody}`)));
    if (provided.some((p) => safeEqual(p, expected))) return true;
  }
  return false;
}

function readItems(meta) {
  try {
    const items = JSON.parse(meta.items);
    if (!Array.isArray(items)) return null;
    for (const i of items) {
      if (!PRODUCTS[i.id] || !METALS[i.metal] || !Number.isInteger(i.qty)) return null;
    }
    return items;
  } catch { return null; }
}

export async function onRequestPost({ request, env }) {
  const raw = await request.text();

  if (!(await verifySignature(raw, request.headers, env.YOCO_WEBHOOK_SECRET))) {
    return json({ error: 'Invalid signature.' }, 401);
  }

  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: 'Invalid body.' }, 400); }

  // We only act on successful payments. Everything else is acknowledged and ignored.
  if (!event || event.type !== 'payment.succeeded') return json({ ok: true, ignored: true });

  const p = event.payload || {};
  const meta = p.metadata || {};
  const amountCents = Number(p.amount);
  const mode = p.mode ? String(p.mode).toUpperCase() : '';
  const modeTag = mode && mode !== 'LIVE' ? ` [${mode}]` : '';

  // Payments that did not come from this website (no order reference)
  if (!meta.orderRef) {
    if (!meta.checkoutId) return json({ ok: true, ignored: true });
    const r = await sendEmail(env, {
      subject: `PAID${modeTag} payment received, details missing (checkout ${meta.checkoutId})`,
      text: [
        'A payment succeeded on Yoco, but the order details did not come through with it.',
        `Yoco checkout id: ${meta.checkoutId}`,
        `Amount: ${Number.isFinite(amountCents) ? money(amountCents / 100) : 'unknown'}`,
        '',
        'Find the "Payment started" email with this checkout id to see what the customer ordered.',
      ].join('\n'),
    });
    return r.ok ? json({ ok: true }) : json({ error: 'Email failed.' }, 500);
  }

  const items = readItems(meta);
  const expected = Number(meta.expectedAmount);
  const lines = [];
  lines.push(`PAYMENT RECEIVED${modeTag}. Order ${meta.orderRef} is paid and can go into production.`);
  lines.push('');
  lines.push(`Order reference: ${meta.orderRef}`);
  if (meta.checkoutId) lines.push(`Yoco checkout id: ${meta.checkoutId}`);
  lines.push('');
  lines.push(`Name: ${meta.customerName || ''}`);
  lines.push(`Email: ${meta.customerEmail || ''}`);
  lines.push(`Cellphone: ${meta.customerPhone || ''}`);
  lines.push('Delivery address:');
  lines.push(meta.deliveryAddress || '');
  lines.push('');
  lines.push('Items:');
  lines.push(items ? describeItems(items) : `(could not read items) ${meta.items || ''}`);
  lines.push('');
  const paid = Number.isFinite(amountCents) ? money(amountCents / 100) : 'unknown';
  lines.push(`Amount paid: ${paid}`);
  if (items) lines.push(`Order total: ${money(orderTotal(items))}`);
  if (Number.isFinite(amountCents) && Number.isFinite(expected) && amountCents !== expected) {
    lines.push('');
    lines.push(`WARNING: the amount paid (${paid}) does not match the amount expected (${money(expected / 100)}). Check this payment in Yoco before sending the order.`);
  }

  const r = await sendEmail(env, {
    subject: `PAID${modeTag} ${meta.orderRef} ${paid}`,
    replyTo: meta.customerEmail || undefined,
    text: lines.join('\n'),
  });
  // A non-2xx makes Yoco retry later, so a paid order is never lost to a brief email outage
  return r.ok ? json({ ok: true }) : json({ error: 'Email failed.' }, 500);
}

export async function onRequest() {
  return json({ error: 'Method not allowed.' }, 405);
}
