import { desc, eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { seasons } from '../db/schema.js';
import { chinaDate, cycleStart } from './statistics.js';

export async function ensureCurrentSeason() {
  const db = getDb();
  const startsOn = cycleStart(chinaDate());
  const latest = await db.select().from(seasons).orderBy(desc(seasons.startsOn)).limit(1);
  if (latest[0]?.startsOn === startsOn) return latest[0];
  const [season] = await db.insert(seasons).values({ name: `${startsOn.slice(0, 4)}年${Number(startsOn.slice(5, 7))}月赛季`, startsOn }).onConflictDoNothing({ target: seasons.startsOn }).returning();
  return season ?? (await db.select().from(seasons).where(eq(seasons.startsOn, startsOn)).limit(1))[0];
}
