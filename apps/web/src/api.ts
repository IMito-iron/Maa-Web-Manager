// Retained for the archived account UI; the shared application does not use it.
import { currentLocale, translate } from './i18n';
export function setCsrf(_value:string) {}
export async function api(url: string, method = 'GET', body?: unknown) {
  const r = await fetch('/api/' + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Maa-Request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || translate(currentLocale(), '请求失败 {status}', {status: r.status}));
  return data;
}

export function slugify(name: string): string {
  const s = String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s || ('preset-' + Math.random().toString(36).slice(2, 8));
}
