import pg from "pg";
import { databaseUrl } from "./config.js";

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 5,
  idleTimeoutMillis: 30_000,
});

export { pool };

export async function query(text: string, params?: unknown[]) {
  return pool.query(text, params);
}

export async function getClient() {
  return pool.connect();
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}