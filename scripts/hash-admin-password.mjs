/**
 * Generate a scrypt password hash in the same format as server/pg-store.mjs.
 * Pipe the new password on stdin; only the salt:hash is printed.
 *
 *   node scripts/hash-admin-password.mjs
 *   # then put the printed hash into server/admin-bootstrap.json
 *   # or ADMIN_BOOTSTRAP_PASSWORD_HASH and restart the server.
 */
import { randomBytes, scryptSync } from 'node:crypto';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
if (!password) {
  console.error('Pipe the new password on stdin. Output is salt:hash only.');
  process.exit(1);
}
const salt = randomBytes(16).toString('hex');
const hash = scryptSync(password, salt, 64).toString('hex');
process.stdout.write(`${salt}:${hash}\n`);
