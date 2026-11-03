import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';
import { user } from '@/lib/db/schema.pg';
export const dailyAccounts = pgTable('personal_daily_accounts', {
  ownerId: uuid('owner_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull().default(0),
  encrypted: text('encrypted_data').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});
export const dailyDays = pgTable(
  'personal_daily_days',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    date: text('business_date').notNull(),
    encrypted: text('encrypted_data').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.ownerId, t.date] }) }),
);
export const dailySources = pgTable(
  'personal_daily_sources',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    id: uuid('id').notNull(),
    encrypted: text('encrypted_data').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.ownerId, t.id] }) }),
);
export const dailyEvents = pgTable(
  'personal_daily_events',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    commandId: uuid('command_id').notNull(),
    kind: text('kind').notNull(),
    encrypted: text('encrypted_data').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    ownerTime: index('personal_daily_events_owner_time').on(
      t.ownerId,
      t.createdAt,
    ),
  }),
);
export const dailyCommands = pgTable(
  'personal_daily_commands',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    id: uuid('id').notNull(),
    requestHash: text('request_hash').notNull(),
    state: text('state').notNull(),
    encrypted: text('encrypted_result'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.ownerId, t.id] }) }),
);
export const dailyFeedback = pgTable(
  'personal_daily_feedback',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    id: uuid('id').notNull(),
    date: text('business_date').notNull(),
    workId: uuid('work_id').notNull(),
    runId: uuid('run_id'),
    status: text('status').notNull().default('received'),
    input: text('encrypted_input').notNull(),
    result: text('encrypted_result'),
    error: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ownerId, t.id] }),
    ownerDate: index('personal_daily_feedback_owner_date').on(
      t.ownerId,
      t.date,
      t.createdAt,
    ),
  }),
);
