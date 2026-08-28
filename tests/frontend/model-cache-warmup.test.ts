import { describe, expect, it } from 'vitest';
import {
  __resetModelCacheWarmupForTests,
  isModelCacheWarmupPending,
  startModelCacheWarmup,
  subscribeModelCacheWarmup,
} from '../../src/web/frontend/src/lib/modelCacheWarmup';

describe('model cache warmup renderer lifecycle', () => {
  it('starts one request and exposes pending state until it settles', async () => {
    __resetModelCacheWarmupForTests();
    let requests = 0;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const states: boolean[] = [];
    const unsubscribe = subscribeModelCacheWarmup(() => states.push(isModelCacheWarmupPending()));

    const first = startModelCacheWarmup(async () => { requests++; await pending; });
    const second = startModelCacheWarmup(async () => { requests++; });
    expect(isModelCacheWarmupPending()).toBe(true);
    expect(requests).toBe(0);
    release();
    await Promise.all([first, second]);

    expect(requests).toBe(1);
    expect(isModelCacheWarmupPending()).toBe(false);
    expect(states).toEqual([true, false]);
    unsubscribe();
  });
});
