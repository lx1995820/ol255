import { drizzle } from 'drizzle-orm/netlify-db';
import * as schema from './schema.js';

// 优先使用站外 Neon 免费库（COURT_DB_URL）：Netlify DB 按 GB-hour 烧积分，
// 迁出后其内置库永久休眠，Database compute 开销归零。未配置时回退到 Netlify DB。
// 注意必须用 drizzle(url, config) 形式——netlify-db 驱动内部走 Pool（WebSocket），
// 不要用 drizzle-orm/neon-http（serverless v1.x 已移除函数式调用，与之不兼容）。
export function getDb() {
  const external = process.env.COURT_DB_URL;
  if (external) return drizzle(external, { schema });
  return drizzle({ schema });
}
