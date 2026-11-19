import type { Config } from '@netlify/functions';
import { verifyRequestOrigin } from '@netlify/identity';
import { and, desc, eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb } from '../../db/index.js';
import { games, playerRatings, tournaments } from '../../db/schema.js';

const currentMonth = () => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find(part => part.type === 'year')?.value}-${parts.find(part => part.type === 'month')?.value}`;
};
const respond = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const validDevice = (value: string) => /^[a-f0-9]{64}$/.test(value);
const deviceHash = (value: string) => createHash('sha256').update(value).digest('hex');

export default async (request: Request) => {
  const url = new URL(request.url);
  const db = getDb();
  const month = currentMonth();
  try {
    if (request.method === 'GET') {
      const nickname = url.searchParams.get('nickname');
      if (!nickname) {
        const summaries = await db.select({ nickname: playerRatings.nickname, month: playerRatings.month,
          total: sql<number>`sum(${playerRatings.score})::int`, count: sql<number>`count(*)::int`,
          participants: sql<number>`count(distinct ${playerRatings.deviceHash})::int`,
        }).from(playerRatings).groupBy(playerRatings.nickname, playerRatings.month);
        const cumulative = await db.select({ nickname: playerRatings.nickname,
          total: sql<number>`sum(${playerRatings.score})::int`, count: sql<number>`count(*)::int`,
          participants: sql<number>`count(distinct ${playerRatings.deviceHash})::int`,
        }).from(playerRatings).groupBy(playerRatings.nickname);
        return respond({ summaries, cumulative, month });
      }
      if (nickname.trim() !== nickname || nickname.length > 80) return respond({ error: '选手名称无效' }, 400);
      const device = request.headers.get('x-rating-device') ?? '';
      const records = await db.select({ score: playerRatings.score, content: playerRatings.content, month: playerRatings.month, updatedAt: playerRatings.updatedAt })
        .from(playerRatings).where(eq(playerRatings.nickname, nickname)).orderBy(desc(playerRatings.updatedAt)).limit(100);
      const mine = validDevice(device) ? await db.select({ score: playerRatings.score, content: playerRatings.content })
        .from(playerRatings).where(and(eq(playerRatings.nickname, nickname), eq(playerRatings.month, month), eq(playerRatings.deviceHash, deviceHash(device)))).limit(1) : [];
      return respond({ records, mine: mine[0] ?? null, month });
    }
    if (request.method !== 'POST') return respond({ error: '不支持此请求方法' }, 405);
    try { verifyRequestOrigin(request); } catch { return respond({ error: '请在本站提交评分' }, 403); }
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return respond({ error: '评分格式无效' }, 415);
    if (Number(request.headers.get('content-length') ?? 0) > 4096) return respond({ error: '评分请求过大' }, 413);
    const raw = await request.text();
    if (raw.length > 4096) return respond({ error: '评分请求过大' }, 413);
    let input: Record<string, unknown>;
    try { input = JSON.parse(raw); } catch { return respond({ error: '评分格式无效' }, 400); }
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['nickname', 'score', 'content', 'device'].includes(key))
      || typeof input.nickname !== 'string' || typeof input.device !== 'string' || !validDevice(input.device)
      || typeof input.score !== 'number' || !Number.isInteger(input.score) || input.score < 1 || input.score > 10
      || typeof input.content !== 'string' || input.content.trim().length > 120) return respond({ error: '评分或评语无效' }, 400);
    const nickname = input.nickname.trim();
    if (!nickname || nickname.length > 80) return respond({ error: '选手名称无效' }, 400);
    const exists = await db.select({ id: games.id }).from(games).where(eq(games.nickname, nickname)).limit(1);
    if (!exists.length) {
      const events = await db.select({ records: tournaments.records, podium: tournaments.podium, mvp: tournaments.mvp }).from(tournaments);
      if (!events.some(event => event.mvp === nickname || event.podium.some(team => team.includes(nickname)) || event.records.some(record => record.nickname === nickname))) return respond({ error: '选手不存在' }, 404);
    }
    const values = { nickname, month, deviceHash: deviceHash(input.device), score: input.score, content: input.content.trim(), updatedAt: new Date() };
    await db.insert(playerRatings).values(values).onConflictDoUpdate({
      target: [playerRatings.nickname, playerRatings.month, playerRatings.deviceHash],
      set: { score: values.score, content: values.content, updatedAt: values.updatedAt },
    });
    return respond({ success: true, month });
  } catch { return respond({ error: '评分服务暂时不可用，请稍后重试' }, 503); }
};

export const config: Config = { path: '/api/ratings', method: ['GET', 'POST'], rateLimit: { windowLimit: 100, windowSize: 60, aggregateBy: 'ip' } };
