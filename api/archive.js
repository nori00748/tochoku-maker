// Vercel Serverless Function: /api/archive
// ライトプラン以上のユーザーが、生成済みの当直表を「月別」にアーカイブ保存・取得・削除する。
// テーブル: roster_archive (clerk_user_id, year_month, roster_json, updated_at)
//
// GET  ?ym=YYYY-MM  → 単月の roster を返す
// GET             → 全月のメタ一覧を返す ([{ ym, updated_at }, ...])
// POST {ym, roster}  → 単月を upsert
// DELETE ?ym=YYYY-MM → 単月を削除
//
// 起動時 (もしくはプラン昇格時) に CREATE TABLE IF NOT EXISTS を流す方針。
// (Neon の serverless はマイグレーション運用が手薄なので、初回 GET 時に念のためテーブル作成)

import { verifyToken } from '@clerk/backend';
import { neon } from '@neondatabase/serverless';

async function ensureTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS roster_archive (
      clerk_user_id TEXT NOT NULL,
      year_month    TEXT NOT NULL,
      roster_json   JSONB NOT NULL,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (clerk_user_id, year_month)
    )
  `;
}

async function getEffectivePlan(sql, userId) {
  try {
    const rows = await sql`
      SELECT plan, current_period_end FROM user_plan
      WHERE clerk_user_id = ${userId} LIMIT 1
    `;
    if (!rows.length) return 'free';
    const plan = rows[0].plan;
    const pe = rows[0].current_period_end;
    if (pe && new Date(pe) < new Date()) return 'free';
    return plan || 'free';
  } catch (e) {
    return 'free';
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  let userId;
  try {
    const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    userId = payload.sub;
    if (!userId) throw new Error('no sub');
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }

  const dbUrl = process.env.DATABASE_URL
    || process.env.POSTGRES_URL
    || process.env.DATABASE_URL_UNPOOLED
    || process.env.POSTGRES_URL_NON_POOLING;
  if (!dbUrl) return res.status(500).json({ error: 'database_url_missing' });
  const sql = neon(dbUrl);

  // プランチェック (ライト以上のみ)
  const plan = await getEffectivePlan(sql, userId);
  if (plan !== 'light' && plan !== 'pro') {
    return res.status(403).json({ error: 'plan_required', detail: 'archive requires light plan' });
  }

  try { await ensureTable(sql); } catch (e) {
    return res.status(500).json({ error: 'table_create_failed', detail: String(e?.message||e) });
  }

  // GET: 単月 or 一覧
  if (req.method === 'GET') {
    const ym = (req.query?.ym || '').toString();
    try {
      if (ym) {
        if (!/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ error: 'bad_ym' });
        const rows = await sql`
          SELECT roster_json, updated_at FROM roster_archive
          WHERE clerk_user_id = ${userId} AND year_month = ${ym}
          LIMIT 1
        `;
        if (!rows.length) return res.status(404).json({ error: 'not_found' });
        return res.status(200).json({ ym, roster: rows[0].roster_json, updatedAt: rows[0].updated_at });
      } else {
        const rows = await sql`
          SELECT year_month, updated_at FROM roster_archive
          WHERE clerk_user_id = ${userId}
          ORDER BY year_month DESC
        `;
        return res.status(200).json({ list: rows.map(r => ({ ym: r.year_month, updatedAt: r.updated_at })) });
      }
    } catch (e) {
      return res.status(500).json({ error: 'db_error', detail: String(e?.message||e) });
    }
  }

  // POST: 保存
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
    if (!body || !body.ym || !/^\d{4}-\d{2}$/.test(body.ym) || !body.roster) {
      return res.status(400).json({ error: 'bad_body' });
    }
    const rosterJson = JSON.stringify(body.roster);
    if (rosterJson.length > 1024 * 1024) return res.status(413).json({ error: 'roster_too_large' });
    try {
      // 配列を JSONB に格納するため、明示的に文字列化 + ::jsonb キャスト
      await sql`
        INSERT INTO roster_archive (clerk_user_id, year_month, roster_json, updated_at)
        VALUES (${userId}, ${body.ym}, ${rosterJson}::jsonb, NOW())
        ON CONFLICT (clerk_user_id, year_month) DO UPDATE
        SET roster_json = EXCLUDED.roster_json, updated_at = NOW()
      `;
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'db_error', detail: String(e?.message||e) });
    }
  }

  // DELETE: 単月削除
  if (req.method === 'DELETE') {
    const ym = (req.query?.ym || '').toString();
    if (!/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ error: 'bad_ym' });
    try {
      await sql`DELETE FROM roster_archive WHERE clerk_user_id = ${userId} AND year_month = ${ym}`;
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'db_error', detail: String(e?.message||e) });
    }
  }

  return res.status(405).json({ error: 'method_not_allowed' });
}
