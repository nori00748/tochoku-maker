// Vercel Serverless Function: /api/past-duty-counts
// 振り分け条件「先月・先々月考慮」のために、過去N月の当直回数を集計して返す。
// クエリ: ?months=1|2&base=YYYY-MM
//   base = 現在編集中の月。base 未指定の場合は今月。
//   months = 何ヶ月遡るか。
// 応答: { counts: { name: count, ... }, range: { from: 'YYYY-MM', to: 'YYYY-MM' } }
//
// 集計対象: roster_archive.roster_json[*].duty と nichoku を合計。
// オンコール/副直は集計対象外(名前の通り「当直回数」のみ)。

import { verifyToken } from '@clerk/backend';
import { neon } from '@neondatabase/serverless';

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

function prevYM(ym, n) {
  // ym 'YYYY-MM' から n ヶ月前を返す
  const [y, m] = ym.split('-').map(Number);
  const dt = new Date(y, m-1, 1);
  dt.setMonth(dt.getMonth() - n);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

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

  const plan = await getEffectivePlan(sql, userId);
  if (plan !== 'light' && plan !== 'pro') {
    // ライト未満は空集計を返してフロントが普通に動くように
    return res.status(200).json({ counts: {}, range: null });
  }

  const months = Math.max(1, Math.min(12, parseInt(req.query?.months || '1') || 1));
  const baseRaw = (req.query?.base || '').toString();
  const today = new Date();
  const base = /^\d{4}-\d{2}$/.test(baseRaw)
    ? baseRaw
    : `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;

  const targetYMs = [];
  for (let i = 1; i <= months; i++) targetYMs.push(prevYM(base, i));

  try {
    // 一括取得
    const rows = await sql`
      SELECT year_month, roster_json FROM roster_archive
      WHERE clerk_user_id = ${userId} AND year_month = ANY(${targetYMs})
    `;
    const counts = {};
    rows.forEach(row => {
      const arr = Array.isArray(row.roster_json) ? row.roster_json : [];
      arr.forEach(r => {
        if (r && r.duty)    counts[r.duty]    = (counts[r.duty]||0) + 1;
        if (r && r.nichoku) counts[r.nichoku] = (counts[r.nichoku]||0) + 1;
      });
    });
    return res.status(200).json({
      counts,
      range: { from: targetYMs[targetYMs.length-1], to: targetYMs[0], months }
    });
  } catch (e) {
    return res.status(500).json({ error: 'db_error', detail: String(e?.message||e) });
  }
}
