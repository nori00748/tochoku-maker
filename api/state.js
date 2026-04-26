// Vercel Serverless Function: /api/state
// 認証 (Clerk JWT) 済みのユーザーのみが、自分の state を read/write できる。
// GET  → 自分の保存データを返す { state, updatedAt }
// POST → body.state を保存(全置換)

import { verifyToken } from '@clerk/backend';
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  // ---- CORS / プリフライト対応(同一オリジン想定だが念のため) ----
  res.setHeader('Cache-Control', 'no-store');

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

  // Vercel + Neon 連携の環境変数は構成により名前が異なるため、いくつかの候補を順に見る
  const dbUrl = process.env.DATABASE_URL
    || process.env.POSTGRES_URL
    || process.env.DATABASE_URL_UNPOOLED
    || process.env.POSTGRES_URL_NON_POOLING;
  if (!dbUrl) {
    return res.status(500).json({ error: 'database_url_missing' });
  }
  const sql = neon(dbUrl);

  // ---- GET: 取得 ----
  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT state_json, updated_at
        FROM user_state
        WHERE clerk_user_id = ${userId}
        LIMIT 1
      `;
      if (!rows.length) return res.status(200).json({ state: null });
      return res.status(200).json({
        state: rows[0].state_json,
        updatedAt: rows[0].updated_at
      });
    } catch (e) {
      return res.status(500).json({ error: 'db_error', detail: String(e?.message || e) });
    }
  }

  // ---- POST: 保存 ----
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    if (!body || typeof body !== 'object' || !body.state || typeof body.state !== 'object') {
      return res.status(400).json({ error: 'bad_body' });
    }

    // 過大なペイロードを軽くガード (1MB)
    const approx = JSON.stringify(body.state).length;
    if (approx > 1024 * 1024) {
      return res.status(413).json({ error: 'state_too_large' });
    }

    try {
      await sql`
        INSERT INTO user_state (clerk_user_id, state_json, updated_at)
        VALUES (${userId}, ${body.state}, NOW())
        ON CONFLICT (clerk_user_id) DO UPDATE
        SET state_json = EXCLUDED.state_json,
            updated_at = NOW()
      `;
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'db_error', detail: String(e?.message || e) });
    }
  }

  return res.status(405).json({ error: 'method_not_allowed' });
}
