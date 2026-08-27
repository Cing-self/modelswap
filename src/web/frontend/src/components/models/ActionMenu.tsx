import { useEffect, useRef } from 'react';
export function ActionMenu({ actions, onClose }: { actions: { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [onClose]);
  return (
    <div ref={ref} className="action-menu" role="menu" onClick={e => e.stopPropagation()}>
      {actions.map((a, i) => (
        <button
          key={i}
          className={`action-menu-item${a.danger ? ' action-menu-item--danger' : ''}`}
          onClick={a.onClick}
          disabled={a.disabled}
          role="menuitem"
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

/* --- Provider Form Modal --- */
