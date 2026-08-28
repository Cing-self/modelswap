import { useSyncExternalStore } from 'react';
import { isModelCacheWarmupPending, subscribeModelCacheWarmup } from '../lib/modelCacheWarmup';

export function useModelCacheWarmupPending() {
  return useSyncExternalStore(
    subscribeModelCacheWarmup,
    isModelCacheWarmupPending,
    isModelCacheWarmupPending,
  );
}
