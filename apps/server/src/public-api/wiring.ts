/**
 * Composition root for the Bot API: builds the read-only adapter stack from the existing Store and
 * Engine, loads the token set once at startup (fail closed), and returns the application service.
 * Keeping this separate from `main.ts` makes the dependency wiring visible in one place.
 */
import fs from 'node:fs/promises';
import type { Engine } from '../engine';
import type { Store } from '../store';
import { EngineStateAdapter } from './engine-state';
import { botApiOptions } from './options';
import { PrismaDailyStatusRepository } from './repository';
import { PublicApiService } from './service';
import { loadBotTokens } from './tokens';

export async function createPublicApiService(
  store: Store,
  engine: Engine,
  env: Record<string, string | undefined> = process.env,
): Promise<PublicApiService> {
  const options = botApiOptions(env);
  const tokens = await loadBotTokens(
    { BOT_DAILY_API_TOKEN: env['BOT_DAILY_API_TOKEN'], BOT_DAILY_API_TOKEN_FILE: env['BOT_DAILY_API_TOKEN_FILE'] },
    (file) => fs.readFile(file, 'utf8'),
    (line) => console.error(line),
  );
  if (tokens.configured) {
    // Never log token values, digests or file paths.
    console.error(`[bot-daily-api] enabled (tokens=${tokens.digests.length}, source=${tokens.source})`);
  } else {
    console.error('[bot-daily-api] disabled: no token configured');
  }
  return new PublicApiService({
    repository: new PrismaDailyStatusRepository(store.db, store, () => new Date()),
    engine: new EngineStateAdapter(engine),
    tokens,
    options,
    now: () => new Date(),
    uptimeSeconds: () => process.uptime(),
    logger: (line) => console.error(line),
  });
}
