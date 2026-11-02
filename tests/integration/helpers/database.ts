import { existsSync } from 'node:fs';

import { Client } from 'pg';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

export function serverUrl(): string {
  const url = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL_DIRECT or DATABASE_URL to run integration tests');
  return url;
}

export function databaseUrl(name: string): string {
  const url = new URL(serverUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

export async function withClient<T>(url: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

export async function createDatabase(name: string): Promise<string> {
  await withClient(serverUrl(), (client) => client.query(`CREATE DATABASE "${name}"`));
  return databaseUrl(name);
}

export async function dropDatabase(name: string): Promise<void> {
  await withClient(serverUrl(), (client) =>
    client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
  );
}
