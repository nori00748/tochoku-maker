// Vercel Serverless Function: /api/checkout-session
// 認証済みユーザーが「ライトプラン申し込み」を押した時、
// Stripe Checkout Session を作成して、その URL を返す。
// フロント側はその URL に遷移するだけで決済画面に飛ぶ。

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

  let userId, userEmail;
  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY
    });
    userId = payload.sub;
    if (!userId) throw new Error('no sub in token');
    // メールはセッション内に持つことが多いので簡略化のため、なくても可
    userEmail = payload.email || null;
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }

  // ---- 環境変数チェック ----
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'stripe_secret_missing' });
  }
  if (!process.env.STRIPE_PRICE_LIGHT) {
    return res.status(500).json({ error: 'stripe_price_missing' });
  }

  // ---- 既存の Stripe Customer ID を DB から取得(あれば再利用) ----
  const dbUrl = process.env.DATABASE_URL
    || process.env.POSTGRES_URL
    || process.env.DATABASE_URL_UNPOOLED
    || process.env.POSTGRES_URL_NON_POOLING;
  let existingCustomerId = null;
  if (dbUrl) {
    try {
      const sql = neon(dbUrl);
      const rows = await sql`
        SELECT stripe_customer_id FROM user_plan
        WHERE clerk_user_id = ${userId} LIMIT 1
      `;
      if (rows.length && rows[0].stripe_customer_id) {
        existingCustomerId = rows[0].stripe_customer_id;
      }
    } catch (e) {
      // DBエラーでも Checkout は作成できるので続行
    }
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-11-20.acacia'
  });

  // 戻り先URL: アプリの絶対URLを構築
  const origin = req.headers.origin
    || (req.headers['x-forwarded-host'] ? `https://${req.headers['x-forwarded-host']}` : null)
    || (req.headers.host ? `https://${req.headers.host}` : 'https://tochoku-maker.vercel.app');

  try {
    const sessionParams = {
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_LIGHT, quantity: 1 }],
      success_url: `${origin}/app?checkout=success`,
      cancel_url: `${origin}/app?checkout=cancel`,
      // Webhook で plan 反映するときに使う紐付け情報
      client_reference_id: userId,
      metadata: { clerk_user_id: userId },
      subscription_data: {
        metadata: { clerk_user_id: userId },
        // 30日間無料トライアル: トライアル期間中は課金なし、解約すれば一切請求発生せず
        trial_period_days: 30
      },
      // 同一ユーザーが過去に作成済みなら同じ Customer を使う
      ...(existingCustomerId ? { customer: existingCustomerId } : (userEmail ? { customer_email: userEmail } : {})),
      // 日本市場向け
      locale: 'ja',
      allow_promotion_codes: true
    };

    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.status(200).json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: 'stripe_error', detail: String(e?.message || e) });
  }
}
