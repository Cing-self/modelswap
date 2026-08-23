// Smart usage polling hook — shared by UsagePage and UsageSummary.
//
// Behavior:
//   1. On mount, fetches all supported providers immediately.
//   2. Sets up a silent interval that re-fetches every 5 minutes (no loading
//      spinner — just updates the data in place).
//   3. If any provider has a window resetting within 30 minutes, that provider
//      gets bumped to a 1-minute poll cycle for fresher data near the boundary.
//
// The hook takes a callback that performs the actual fetch for a single
// provider (so each consumer can manage its own state). It returns the current
// usageMap and helper functions.

import { useEffect, useRef, useCallback } from 'react';
import { getUsage, UsageResult } from '../api/providers';

const BASE_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes
const FAST_INTERVAL_MS = 60 * 1000;       // 1 minute
const RESET_IMMINENT_MS = 30 * 60 * 1000; // 30 minutes

export interface UsagePollingOptions {
  supportedIds: string[];
  onResult: (providerId: string, result: UsageResult) => void;
  onFetchStart?: (providerId: string) => void;
  onFetchEnd?: (providerId: string) => void;
  // If true, the silent refresh sets "fetching" state (shows spinner).
  // Default false = truly silent.
  silent?: boolean;
  // Provider ids to NEVER fetch automatically (mount fetch + interval).
  // Used for queries that drive the browser via the extension — those must
  // only run from an explicit user action.
  skipIds?: string[];
}

function hasImminentReset(result: UsageResult | undefined): boolean {
  if (!result?.windows) return false;
  const now = Date.now();
  return result.windows.some(w => {
    if (!w.resetAt) return false;
    const ms = new Date(w.resetAt).getTime() - now;
    return ms > 0 && ms <= RESET_IMMINENT_MS;
  });
}

export function useUsagePolling(opts: UsagePollingOptions) {
  const { supportedIds, onResult, onFetchStart, onFetchEnd, silent = true, skipIds } = opts;
  // Keep latest results in a ref so the interval callback can read current data
  // to decide fast-vs-slow polling without re-subscribing.
  const resultsRef = useRef<Record<string, UsageResult>>({});
  const mountedRef = useRef(true);
  const skipSetRef = useRef<Set<string>>(new Set());
  skipSetRef.current = new Set(skipIds || []);

  const fetchOne = useCallback(async (id: string) => {
    if (!mountedRef.current) return;
    if (!silent && onFetchStart) onFetchStart(id);
    try {
      const res = await getUsage(id);
      if (!mountedRef.current) return;
      resultsRef.current[id] = res;
      onResult(id, res);
    } catch (err: any) {
      if (!mountedRef.current) return;
      const errorResult: UsageResult = { supported: true, error: err.message };
      resultsRef.current[id] = errorResult;
      onResult(id, errorResult);
    } finally {
      if (!silent && onFetchEnd) onFetchEnd(id);
    }
  }, [onResult, onFetchStart, onFetchEnd, silent]);

  const fetchAll = useCallback(() => {
    supportedIds.forEach(id => {
      if (skipSetRef.current.has(id)) return;
      fetchOne(id);
    });
  }, [supportedIds, fetchOne]);

  // Initial fetch when supportedIds first becomes non-empty.
  const didInitialFetch = useRef(false);
  useEffect(() => {
    if (supportedIds.length > 0 && !didInitialFetch.current) {
      didInitialFetch.current = true;
      fetchAll();
    }
  }, [supportedIds, fetchAll]);

  // Polling interval: dynamically picks fast or slow based on whether any
  // provider has an imminent reset.
  useEffect(() => {
    if (supportedIds.length === 0) return;

    const tick = () => {
      if (!mountedRef.current) return;
      const anyImminent = supportedIds.some(id => hasImminentReset(resultsRef.current[id]));
      fetchAll();
      // Reschedule with appropriate interval.
      const nextDelay = anyImminent ? FAST_INTERVAL_MS : BASE_INTERVAL_MS;
      timerId = window.setTimeout(tick, nextDelay);
    };

    let timerId = window.setTimeout(tick, BASE_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      window.clearTimeout(timerId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supportedIds]);

  return { fetchOne, fetchAll };
}
