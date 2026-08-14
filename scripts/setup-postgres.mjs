import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;

const adminUrl = String(process.env.PG_ADMIN_URL || 'postgres://postgres@127.0.0.1:5432/postgres').trim();
const dbName = String(process.env.FLOWMATE_DB_NAME || 'flowmate').trim() || 'flowmate';
const dbUser = String(process.env.FLOWMATE_DB_USER || 'flowmate').trim() || 'flowmate';
const password = String(process.env.FLOWMATE_DB_PASSWORD || '').trim() || randomBytes(12).toString('base64url');

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function adminClientConfig(url) {
  const config = { connectionString: url };
  try {
    const parsed = new URL(url);
    if (parsed.password === '') config.password = '';
  } catch {}
  return config;
}

async function roleExists(client, name) {
  const { rows } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
  return rows.length > 0;
}

async function databaseExists(client, name) {
  const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  return rows.length > 0;
}

async function main() {
  const admin = new Client(adminClientConfig(adminUrl));
  await admin.connect();
  try {
    if (!(await roleExists(admin, dbUser))) {
      await admin.query(`CREATE ROLE ${quoteIdent(dbUser)} LOGIN PASSWORD ${quoteLiteral(password)}`);
      console.log(`Created role ${dbUser}`);
    } else {
      await admin.query(`ALTER ROLE ${quoteIdent(dbUser)} WITH LOGIN PASSWORD ${quoteLiteral(password)}`);
      console.log(`Updated password for existing role ${dbUser}`);
    }

    if (!(await databaseExists(admin, dbName))) {
      await admin.query(`CREATE DATABASE ${quoteIdent(dbName)} OWNER ${quoteIdent(dbUser)}`);
      console.log(`Created database ${dbName}`);
    } else {
      console.log(`Database ${dbName} already exists`);
      await admin.query(`ALTER DATABASE ${quoteIdent(dbName)} OWNER TO ${quoteIdent(dbUser)}`);
    }
  } finally {
    await admin.end();
  }

  const encodedPass = encodeURIComponent(password);
  let databaseUrl;
  try {
    const parsed = new URL(adminUrl);
    const hostPort = parsed.host || '127.0.0.1:5432';
    const search = parsed.search || '';
    databaseUrl = `postgres://${encodeURIComponent(dbUser)}:${encodedPass}@${hostPort}/${dbName}${search}`;
  } catch {
    const hostMatch = adminUrl.match(/@([^/?]+)/);
    const hostPort = hostMatch ? hostMatch[1] : '127.0.0.1:5432';
    databaseUrl = `postgres://${encodeURIComponent(dbUser)}:${encodedPass}@${hostPort}/${dbName}`;
  }

  console.log('\nAdd these lines to your .env:\n');
  console.log(`DATABASE_URL=${databaseUrl}`);
  if (!process.env.FLOWMATE_DB_PASSWORD) {
    console.log(`FLOWMATE_DB_PASSWORD=${password}`);
  }
  console.log('\nNext: npm run migrate:sqlite-to-pg');
}

main().catch((error) => {
  console.error('PostgreSQL setup failed:', error.message || error);
  console.error('Hint: set PG_ADMIN_URL=postgres://postgres:YOUR_PASSWORD@127.0.0.1:5432/postgres');
  process.exit(1);
});
