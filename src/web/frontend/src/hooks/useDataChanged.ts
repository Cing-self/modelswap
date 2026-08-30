import { useEffect, useRef } from 'react';

// 'extension' fires when the browser extension (re)connects — not a data
// section, but a signal for pages to retry extension-dependent queries.
// 'update-available' is published by the server-side update watcher when it
// observes a new release; pages re-check for updates silently.
export type DataSection = 'providers' | 'secrets' | 'agents' | 'config' | 'extension' | 'update-available';

type DataChangedDetail = { type: 'data-changed'; sections: DataSection[] };

export function useDataChanged(sections: DataSection[], onChanged: () => void | Promise<void>) {
  const handlerRef = useRef(onChanged);
  const sectionKey = [...sections].sort().join('|');

  useEffect(() => { handlerRef.current = onChanged; }, [onChanged]);

  useEffect(() => {
    const wanted = new Set(sectionKey.split('|').filter(Boolean));
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<DataChangedDetail>).detail;
      if (detail?.sections?.some(section => wanted.has(section))) {
        void handlerRef.current();
      }
    };
    window.addEventListener('okit:data-changed', listener);
    return () => window.removeEventListener('okit:data-changed', listener);
  }, [sectionKey]);
}
