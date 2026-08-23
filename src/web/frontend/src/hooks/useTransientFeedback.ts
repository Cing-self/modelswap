import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Keeps short, action-local feedback next to the control that triggered it.
 * The key lets one hook serve repeated controls such as table rows.
 */
export function useTransientFeedback(duration = 1800) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showFeedback = useCallback((key: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setActiveKey(key);
    timerRef.current = setTimeout(() => {
      setActiveKey(null);
      timerRef.current = null;
    }, duration);
  }, [duration]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return {
    activeKey,
    isActive: (key: string) => activeKey === key,
    showFeedback,
  };
}
