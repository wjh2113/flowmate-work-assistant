import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), 'admin-bootstrap.json');

function readFileConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function getAdminBootstrap() {
  const file = readFileConfig();
  const login = String(process.env.ADMIN_BOOTSTRAP_USER || file.login || 'jonny').trim().toLowerCase();
  const email = String(file.email || login).trim().toLowerCase();
  const id = String(file.id || 'bootstrap-admin').trim() || 'bootstrap-admin';
  const displayName = String(file.displayName || login).trim() || login;
  const passwordHash = String(process.env.ADMIN_BOOTSTRAP_PASSWORD_HASH || file.passwordHash || '').trim();
  const aliases = [...new Set([login, email, `${login}@local`].map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  return { id, login, email, displayName, passwordHash, aliases };
}

export function isBootstrapAdminIdentifier(identifier) {
  const value = String(identifier || '').trim().toLowerCase();
  if (!value) return false;
  const bootstrap = getAdminBootstrap();
  return value === bootstrap.id || bootstrap.aliases.includes(value);
}

export function isBootstrapAdminUser(user) {
  if (!user) return false;
  const bootstrap = getAdminBootstrap();
  return user.id === bootstrap.id || isBootstrapAdminIdentifier(user.email);
}
