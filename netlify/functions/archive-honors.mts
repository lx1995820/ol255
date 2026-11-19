import type { Config } from '@netlify/functions';
import { archiveCompletedMonths } from '../../lib/honors.js';
import { ensureCurrentSeason } from '../../lib/seasons.js';

export default async () => {
  await archiveCompletedMonths();
  await ensureCurrentSeason();
};

// UTC 16:05 is 00:05 in Beijing. This archives completed 11th-to-10th cycles and creates the current season.
export const config: Config = { schedule: '5 16 * * *' };
