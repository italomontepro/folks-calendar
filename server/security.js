import { randomBytes, createHash, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(derive);
export const digest = value => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export function fail(status, message) { throw Object.assign(new Error(message), { status }); }
export function emailInput(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) fail(400, 'Informe um e-mail válido.');
  return value.trim().toLowerCase();
}
export function nameInput(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) fail(400, 'Informe um nome de até 100 caracteres.');
  return value.trim();
}
export function passwordInput(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256) fail(400, 'Use uma senha entre 12 e 256 caracteres.');
  return value;
}
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 });
  return `${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password, hash) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const [salt, encoded] = hash.split(':');
  const key = await scrypt(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 });
  const expected = Buffer.from(encoded, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}
export function roleInput(value) {
  if (!['admin', 'editor', 'viewer'].includes(value)) fail(400, 'Permissão inválida.');
  return value;
}
export function originsInput(value = []) {
  if (!Array.isArray(value) || value.length > 10) fail(400, 'Informe até 10 origens HTTPS.');
  return [...new Set(value.map(item => {
    let url;
    try { url = new URL(item); } catch { fail(400, 'Origem inválida. Use https://seu-crm.com.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail(400, 'Use apenas a origem HTTPS, sem caminho, parâmetros ou credenciais.');
    return url.origin;
  }))];
}
