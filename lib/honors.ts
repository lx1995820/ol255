import { desc } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { games, monthlyHonors } from '../db/schema.js';
import { awardsFor, chinaDate, cycleKey } from './statistics.js';

// Once recorded, monthly winners stay fixed even when old games are edited.
export async function archiveCompletedMonths(records?: (typeof games.$inferSelect)[]) {
  const db = getDb();
  const rows = records ?? await db.select().from(games);
  const archived = await db.select().from(monthlyHonors).orderBy(desc(monthlyHonors.month));
  const completed = new Set(archived.map(row => row.month));
  const current = cycleKey(chinaDate());
  const pending = [...new Set(rows.map(row => cycleKey(row.date)))].filter(month => month < current && !completed.has(month));
  if (pending.length) {
    await db.insert(monthlyHonors).values(pending.map(month => ({ month, awards: awardsFor(rows.filter(row => cycleKey(row.date) === month)) }))).onConflictDoNothing();
    return db.select().from(monthlyHonors).orderBy(desc(monthlyHonors.month));
  }
  return archived;
}
