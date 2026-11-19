import type { Config } from '@netlify/functions';
import { and, desc, eq, lt } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { playerComments } from '../../db/schema.js';

export default async (request: Request) => {
  const url = new URL(request.url);
  const nickname = url.searchParams.get('nickname')?.trim() ?? '';
  const cursor = url.searchParams.get('before');
  const before = cursor === null ? null : Number(cursor);
  const respond = (data: unknown, status = 200) => Response.json(data, {
    status, headers: { 'Cache-Control': 'no-store' },
  });
  if (!nickname || nickname.length > 80 || (cursor !== null && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(before) || before! < 1))) {
    return respond({ error: '选手绰号或评论游标无效' }, 400);
  }
  try {
    const records = await getDb().select().from(playerComments)
      .where(and(eq(playerComments.nickname, nickname), before === null ? undefined : lt(playerComments.id, before)))
      .orderBy(desc(playerComments.id)).limit(101);
    const comments = records.slice(0, 100);
    return respond({ comments, nextCursor: records.length > 100 ? comments[comments.length - 1].id : null });
  } catch {
    return respond({ error: '评论暂时无法读取，请稍后重试' }, 503);
  }
};

export const config: Config = { path: '/api/comments', method: 'GET' };
