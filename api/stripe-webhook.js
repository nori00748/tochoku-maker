// Vercel Serverless Function: /api/stripe-webhook
// Stripe からのイベント通知を受信して user_plan テーブルを更新。
// 監視するイベント:
//   - checkout.session.completed       … 決済完了 → plan を 'light' に
//   - customer.subscription.updated    … 期限更新・プラン変更
//   - customer.subscription.deleted    … 解約 → plan を 'free' に

import Stripe from 'stripe';
import { neon } from '@neondatabase/serverless';

// Vercel に rawBody を取得してもらうための設定
export const config = {
  api: { bodyParser: false }
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end('Method Not Allowed');
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).end('stripe_secret_missing');
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).end('stripe_webhook_secret_missing');
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-11-20.acacia'
  });

  // 署名検証(rawBodyを使う)
  let event;
  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed', err?.message);
    return res.status(400).end(`Webhook Error: ${err?.message || 'invalid signature'}`);
  }

  const dbUrl = process.env.DATABASE_URL
    || process.env.POSTGRES_URL
    || process.env.DATABASE_URL_UNPOOLED
    || process.env.POSTGRES_URL_NON_POOLING;
  if (!dbUrl) {
    console.error('DATABASE_URL missing');
    return res.status(500).end('database_url_missing');
  }
  const sql = neon(dbUrl);

  // ユーザーIDの取得ヘルパー
  const getUserIdFromSession = async (session) => {
    return session.client_reference_id
      || session.metadata?.clerk_user_id
      || null;
  };
  const getUserIdFromSubscription = async (sub) => {
    if (sub.metadata?.clerk_user_id) return sub.metadata.clerk_user_id;
    // metadataなしの場合は customer から逆引き
    if (sub.customer) {
      const rows = await sql`
        SELECT clerk_user_id FROM user_plan
        WHERE stripe_customer_id = ${sub.customer} LIMIT 1
      `;
      if (rows.length) return rows[0].clerk_user_id;
    }
    return null;
  };

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = await getUserIdFromSession(session);
        if (!userId) break;
        const customerId = session.customer || null;
        const subscriptionId = session.subscription || null;
        // サブスクリプション詳細を取って current_period_end を取得
        let periodEnd = null;
        if (subscriptionId) {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          if (sub.current_period_end) {
            periodEnd = new Date(sub.current_period_end * 1000).toISOString();
          }
        }
        await sql`
          INSERT INTO user_plan (clerk_user_id, plan, stripe_customer_id, stripe_subscription_id, current_period_end, updated_at)
          VALUES (${userId}, 'light', ${customerId}, ${subscriptionId}, ${periodEnd}, NOW())
          ON CONFLICT (clerk_user_id) DO UPDATE SET
            plan = 'light',
            stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, user_plan.stripe_customer_id),
            stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, user_plan.stripe_subscription_id),
            current_period_end = COALESCE(EXCLUDED.current_period_end, user_plan.current_period_end),
            updated_at = NOW()
        `;
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const userId = await getUserIdFromSubscription(sub);
        if (!userId) break;
        // ステータスが active/trialing なら light、それ以外は free
        const isActive = ['active', 'trialing'].includes(sub.status);
        const newPlan = isActive ? 'light' : 'free';
        const periodEnd = sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : null;
        await sql`
          INSERT INTO user_plan (clerk_user_id, plan, stripe_customer_id, stripe_subscription_id, current_period_end, updated_at)
          VALUES (${userId}, ${newPlan}, ${sub.customer}, ${sub.id}, ${periodEnd}, NOW())
          ON CONFLICT (clerk_user_id) DO UPDATE SET
            plan = ${newPlan},
            stripe_customer_id = ${sub.customer},
            stripe_subscription_id = ${sub.id},
            current_period_end = ${periodEnd},
            updated_at = NOW()
        `;
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const userId = await getUserIdFromSubscription(sub);
        if (!userId) break;
        await sql`
          UPDATE user_plan
          SET plan = 'free',
              stripe_subscription_id = NULL,
              current_period_end = NULL,
              updated_at = NOW()
          WHERE clerk_user_id = ${userId}
        `;
        break;
      }

      default:
        // 他のイベントは現時点では無視
        break;
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('Webhook handler error', e);
    return res.status(500).end(`handler_error: ${String(e?.message || e)}`);
  }
}
