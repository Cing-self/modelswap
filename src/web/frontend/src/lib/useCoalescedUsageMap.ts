// Coalesced usageMap state — shared by UsagePage and the home UsageSummary.
//
// Individual provider fetches resolve at random moments; applying each result
// as its own state update makes cards pop in one-by-one and re-sort the grid
// on every arrival. Results arriving within one 250ms window are merged into
// a single state update instead: cards fill in small groups and the layout
// settles at most four times per second while a refresh streams in.
import { useState, useRef, useCallback, useEffect } from 'react';
import { UsageResult } from '../api/providers';

const COALESCE_MS = 250;

export function useCoalescedUsageMap() {
  const [usageMap, setUsageMap] = useState<Record<string, UsageResult>>({});
  const bufferRef = useRef<Record<string, UsageResult>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timerRef.current = null;
    const buffered = bufferRef.current;
    if (Object.keys(buffered).length === 0) return;
    bufferRef.current = {};
    setUsageMap(prev => ({ ...prev, ...buffered }));
  }, []);

  const enqueue = useCallback((id: string, result: UsageResult) => {
    bufferRef.current[id] = result;
    // The timer is anchored to the FIRST result of a burst: everything that
    // lands inside the window flushes together, later arrivals start a new
    // window, and a straggler-free stream can never be held back.
    if (timerRef.current == null) {
      timerRef.current = setTimeout(flush, COALESCE_MS);
    }
  }, [flush]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { usageMap, setUsageMap, enqueue };
}
