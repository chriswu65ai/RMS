import { NavLink, Outlet } from 'react-router-dom';

const settingsNavItems = [
  { to: 'general', label: 'General', id: 'settings-nav-general' },
  { to: 'ai', label: 'AI', id: 'settings-nav-ai' },
  { to: 'attachments', label: 'Attachments', id: 'settings-nav-attachments' },
  { to: 'system-log', label: 'System Log', id: 'settings-nav-system-log' },
] as const;

const navLinkClass = ({ isActive }: { isActive: boolean }) => (
  [
    'block rounded-lg border px-3 py-2 text-sm font-medium transition',
    isActive
      ? 'border-slate-900 bg-slate-900 text-white'
      : 'border-transparent text-slate-700 hover:border-slate-200 hover:bg-slate-100',
  ].join(' ')
);

export function SettingsLayout() {
  return (
    <div className="grid h-full min-h-0 grid-cols-[240px_minmax(0,1fr)] overflow-hidden">
      <aside className="h-full border-r border-slate-200 bg-white p-4">
        <p className="mb-3 px-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Settings</p>
        <nav aria-label="Settings sections" className="space-y-1">
          {settingsNavItems.map((item) => (
            <NavLink
              key={item.id}
              className={navLinkClass}
              id={item.id}
              data-testid={item.id}
              to={item.to}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <section className="h-full min-h-0 overflow-y-auto bg-slate-50 p-6">
        <div className="mx-auto w-full max-w-6xl">
          <Outlet />
        </div>
      </section>
    </div>
  );
}
