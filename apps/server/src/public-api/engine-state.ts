/**
 * Read-only view over the engine's published state.
 *
 * Only public fields are inspected (`paused`, `current`, `health`, `control.held`). The adapter
 * never calls `engine.queue()`, `submit()`, `stop()`, `probe()` or any other method: the Bot API must
 * not be able to influence dispatch or take a storage snapshot with side effects.
 */
import type { Engine } from '../engine';
import type { EngineState, EngineStatePort } from './contracts';
import { cfg } from '../config';

export class EngineStateAdapter implements EngineStatePort {
  constructor(private readonly engine: Engine) {}

  async read(): Promise<EngineState> {
    const health: Record<string, unknown> = (this.engine.health as Record<string, unknown>) ?? {};
    const current = this.engine.current;
    return {
      queuePaused: this.engine.paused === true,
      // Mirrors the queue's own "blocked" rule: any missing device/MAA capability blocks dispatch.
      queueBlocked: !health['adb'] || !health['android'] || !health['maa'],
      running: !!current,
      currentRunId: current?.id ?? null,
      controlHeld: this.engine.control.held === true,
      accountIdentityPolicy: cfg.accountPolicy,
    };
  }
}
