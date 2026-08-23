import { useState, useRef, useEffect, useId } from 'react';

interface CustomSelectProps {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  dropdownMode?: 'fixed' | 'local';
  disabled?: boolean;
}

export default function CustomSelect({ value, options, onChange, placeholder, className, dropdownMode = 'fixed', disabled = false }: CustomSelectProps) {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [dropStyle, setDropStyle] = useState<React.CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = `custom-select-${useId().replace(/:/g, '')}`;
  const active = options.find(o => o.value === value);

  function openDropdown(preferredIndex?: number) {
    const currentIndex = options.findIndex(option => option.value === value);
    setHighlightedIndex(preferredIndex ?? (currentIndex >= 0 ? currentIndex : 0));
    if (dropdownMode === 'local') {
      setDropStyle({
        position: 'absolute',
        top: 'calc(100% + 6px)',
        left: 0,
        width: '100%',
        zIndex: 30,
        maxHeight: Math.min(200, options.length * 34 + 4),
      });
      setOpen(true);
      return;
    }

    // Calculate position before opening
    const target = triggerRef.current || ref.current;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const dropdownHeight = Math.min(200, options.length * 34 + 4);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8));

    if (spaceBelow < dropdownHeight && rect.top > spaceBelow) {
      setDropStyle({
        position: 'fixed',
        bottom: window.innerHeight - rect.top + 2,
        left,
        width: rect.width,
        zIndex: 9999,
        maxHeight: Math.min(200, rect.top - 8),
      });
    } else {
      setDropStyle({
        position: 'fixed',
        top: rect.bottom + 2,
        left,
        width: rect.width,
        zIndex: 9999,
        maxHeight: Math.min(200, spaceBelow - 8),
      });
    }
    setOpen(true);
  }

  function select(val: string) {
    onChange(val);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function toggle() {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    openDropdown();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        const currentIndex = options.findIndex(option => option.value === value);
        const start = currentIndex >= 0 ? currentIndex : (event.key === 'ArrowDown' ? 0 : options.length - 1);
        openDropdown(start);
      } else if (options.length) {
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setHighlightedIndex(index => (index + delta + options.length) % options.length);
      }
      return;
    }
    if (open && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      const option = options[highlightedIndex];
      if (option) select(option.value);
      return;
    }
    if (open && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault();
      setHighlightedIndex(event.key === 'Home' ? 0 : options.length - 1);
    }
  }

  useEffect(() => {
    if (!open) return;
    function close() { setOpen(false); }
    document.addEventListener('mousedown', close);
    return () => {
      document.removeEventListener('mousedown', close);
    };
  }, [open]);

  return (
    <div ref={ref} className={`custom-select${open ? ' custom-select--open' : ''} ${className || ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="custom-select-trigger"
        onClick={toggle}
        onKeyDown={handleKeyDown}
        onBlur={event => {
          if (!ref.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
        }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && highlightedIndex >= 0 ? `${listboxId}-option-${highlightedIndex}` : undefined}
      >
        <span className={`custom-select-value${!active ? ' custom-select-value--placeholder' : ''}`}>
          {active?.label || placeholder || ''}
        </span>
        <svg className="custom-select-arrow" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2 4l3 3 3-3" /></svg>
      </button>
      {open && (
        <div
          id={listboxId}
          role="listbox"
          className={`custom-select-dropdown${className ? ` ${className}-dropdown` : ''}`}
          style={dropStyle}
          onMouseDown={e => e.stopPropagation()}
        >
          {options.map((opt, index) => (
            <button
              type="button"
              tabIndex={-1}
              key={opt.value}
              id={`${listboxId}-option-${index}`}
              role="option"
              aria-selected={opt.value === value}
              className={`custom-select-option${opt.value === value ? ' active' : ''}${index === highlightedIndex ? ' highlighted' : ''}`}
              onMouseEnter={() => setHighlightedIndex(index)}
              onClick={() => select(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
