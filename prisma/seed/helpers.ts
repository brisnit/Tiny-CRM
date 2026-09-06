import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";

const url = process.env.DATABASE_URL ?? "file:./dev.db";
const isPg = /^postgres(ql)?:\/\//.test(url);

export const db = new PrismaClient({
  adapter: isPg ? new PrismaPg({ connectionString: url }) : new PrismaBetterSqlite3({ url }),
});

/** All demo dates are relative to run time so the seed never looks stale. */
export const NOW = new Date();

export function daysAgo(days: number, hour = 10, minute = 0) {
  const d = new Date(NOW);
  d.setDate(d.getDate() - days);
  d.setHours(hour, minute, 0, 0);
  return d;
}

export function daysAhead(days: number, hour = 10, minute = 0) {
  return daysAgo(-days, hour, minute);
}

export function hoursAgo(hours: number) {
  return new Date(NOW.getTime() - hours * 3600_000);
}

/** Deterministic pseudo-random so re-seeding produces the same demo. */
let seedState = 1337;
export function rand() {
  seedState = (seedState * 1664525 + 1013904223) % 4294967296;
  return seedState / 4294967296;
}

export function pick<T>(items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

export function maybe(probability: number) {
  return rand() < probability;
}

export function randInt(min: number, max: number) {
  return min + Math.floor(rand() * (max - min + 1));
}

export const dollars = (amount: number) => Math.round(amount * 100);
