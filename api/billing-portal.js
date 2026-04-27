// Vercel Serverless Function: /api/billing-portal
// 認証済みユーザーが「プラン管理」(解約・カード変更等)を押した時、
// Stripe Customer Portal の URL を返す。

import Stripe from 'stripe';
import { verifyToken } from '@clerk/backend';
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // ---- 認証 ----
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  let userId;
  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY
    });
    userId = payload.sub;
    if (!userId) throw new Error('no sub in token');
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'stripe_secret_missing' });
  }
  const dbUrl = process.env.DATABASE_URL
    || process.env.POSTGRES_URL
    || process.env.DATABASE_URL_UNPOOLED
    || process.env.POSTGRES_URL_NON_POOLING;
  if (!dbUrl) return res.status(500).json({ error: 'database_url_missing' });

  const sql = neon(dbUrl);
  let customerId;
  try {
    const rows = await sql`
      SELECT stripe_customer_id FROM user_plan
      WHERE clerk_user_id = ${userId} LIMIT 1
    `;
    customerId = rows.length ? rows[0].stripe_customer_id : null;
  } catch (e) {
    return res.status(500).json({ error: 'db_error' });
  }
  if (!customerId) {
    return res.status(404).json({ error: 'no_customer' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-11-20.acacia'
  });

  const origin = req.headers.origin
    || (req.headers['x-forwarded-host'] ? `https://${req.headers['x-forwarded-host']}` : null)
    || (req.headers.host ? `https://${req.headers.host}` : 'https://tochoku-maker.vercel.app');

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${origin}/app`,
      locale: 'ja'
    });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: 'stripe_error', detail: String(e?.message || e) });
  }
}
