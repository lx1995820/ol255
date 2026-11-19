import { sql } from 'drizzle-orm';
import { bigint, check, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const games = pgTable('games', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  date: date('date', { mode: 'string' }).notNull(),
  roundNumber: integer('round_number'),
  nickname: text('nickname').notNull(),
  pts: integer('pts').notNull(),
  reb: integer('reb').notNull(),
  ast: integer('ast').notNull(),
  stl: integer('stl').notNull(),
  blk: integer('blk').notNull(),
  result: text('result').notNull(),
}, table => [
  index('games_date_idx').on(table.date),
  check('games_round_number_check', sql`${table.roundNumber} BETWEEN 1 AND 10000`),
  uniqueIndex('games_date_round_nickname_idx').on(table.date, table.roundNumber, table.nickname),
]);

export const playerComments = pgTable('player_comments', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  nickname: text('nickname').notNull(),
  author: text('author').notNull().default('游客'),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('player_comments_nickname_id_idx').on(table.nickname, table.id),
  check('player_comments_nickname_check', sql`char_length(btrim(${table.nickname})) BETWEEN 1 AND 80`),
  check('player_comments_author_check', sql`char_length(btrim(${table.author})) BETWEEN 1 AND 24`),
  check('player_comments_content_check', sql`char_length(btrim(${table.content})) BETWEEN 1 AND 300`),
]);

export const playerRatings = pgTable('player_ratings', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  nickname: text('nickname').notNull(),
  month: text('month').notNull(),
  deviceHash: text('device_hash').notNull(),
  score: integer('score').notNull(),
  content: text('content').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('player_ratings_player_month_device_idx').on(table.nickname, table.month, table.deviceHash),
  index('player_ratings_nickname_month_idx').on(table.nickname, table.month),
  check('player_ratings_nickname_check', sql`char_length(btrim(${table.nickname})) BETWEEN 1 AND 80`),
  check('player_ratings_month_check', sql`${table.month} ~ '^\\d{4}-(0[1-9]|1[0-2])$'`),
  check('player_ratings_score_check', sql`${table.score} BETWEEN 1 AND 10`),
  check('player_ratings_content_check', sql`char_length(${table.content}) <= 120`),
]);

export const seasons = pgTable('seasons', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  name: text('name').notNull(),
  startsOn: date('starts_on', { mode: 'string' }).notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const monthlyHonors = pgTable('monthly_honors', {
  month: text('month').primaryKey(),
  awards: jsonb('awards').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Each short tournament is saved atomically, independently of daily games.
export const tournaments = pgTable('tournaments', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  name: text('name').notNull(),
  date: date('date', { mode: 'string' }).notNull(),
  status: text('status').notNull().default('ongoing'),
  podium: jsonb('podium').$type<string[][]>().notNull(),
  mvp: text('mvp').notNull().default(''),
  records: jsonb('records').$type<Array<{roundNumber: number; nickname: string; pts: number; reb: number; ast: number; stl: number; blk: number; result: string}>>().notNull(),
  bracket: jsonb('bracket').$type<{rounds: Array<{name: string; matches: Array<{a: string; b: string; aScore: number; bScore: number; winner: string}>}>}>().notNull().default({ rounds: [] }),
  revision: integer('revision').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('tournaments_date_idx').on(table.date)]);
