import { Search } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  children?: ReactNode;
  trailingContent?: ReactNode;
};

export function ExpandableSearch({
  value,
  onChange,
  placeholder = 'Search',
  ariaLabel = 'Search',
  children,
  trailingContent,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!expanded) return;
    const onPointerDownOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!rootRef.current?.contains(target)) setExpanded(false);
    };
    document.addEventListener('mousedown', onPointerDownOutside);
    document.addEventListener('touchstart', onPointerDownOutside);
    return () => {
      document.removeEventListener('mousedown', onPointerDownOutside);
      document.removeEventListener('touchstart', onPointerDownOutside);
    };
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    inputRef.current?.focus();
  }, [expanded]);

  return (
    <div
      className="relative ml-auto flex h-11 w-full max-w-xl items-center justify-end"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setExpanded(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <input
        ref={inputRef}
        className={`input expandable-search-input absolute right-0 h-11 pr-11 ${expanded ? 'w-[min(24rem,calc(100vw-5.25rem))] pl-4 opacity-100' : 'w-11 pl-0 opacity-0 pointer-events-none'}`}
        value={value}
        onBlur={(event) => {
          const nextTarget = event.relatedTarget;
          if (!(nextTarget instanceof Node) || !rootRef.current?.contains(nextTarget)) setExpanded(false);
        }}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
      />

      <button
        ref={buttonRef}
        type="button"
        className={`expandable-search-trigger absolute right-0 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg border border-slate-200 text-slate-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 ${expanded ? 'bg-transparent' : 'bg-white hover:bg-slate-100'}`}
        aria-label={expanded ? 'Focus search input' : 'Open search'}
        onClick={() => {
          if (!expanded) {
            setExpanded(true);
            return;
          }
          inputRef.current?.focus();
        }}
      >
        <Search size={18} />
      </button>

      {expanded && trailingContent ? <div className="mr-12 text-xs text-slate-500">{trailingContent}</div> : null}
      {expanded && value.trim() && children ? <div className="absolute left-0 right-0 top-12 z-20 max-h-80 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-lg">{children}</div> : null}
    </div>
  );
}
