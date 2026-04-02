import { Menu } from 'lucide-react';
import { ReactNode } from 'react';

type Props = {
  headerRight?: ReactNode;
  topNav?: ReactNode;
  main: ReactNode;
  mobileSidebarOpen: boolean;
  setMobileSidebarOpen: (open: boolean) => void;
};

export function AppShell({ headerRight, topNav, main, mobileSidebarOpen, setMobileSidebarOpen }: Props) {
  return (
    <div className="flex h-screen flex-col bg-slate-50">
      <header className="h-14 shrink-0 border-b border-slate-200 bg-white px-4">
        <div className="mx-auto flex h-full w-full max-w-6xl items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button className="rounded-md p-2 hover:bg-slate-100 md:hidden" onClick={() => setMobileSidebarOpen(true)}>
              <Menu size={18} />
            </button>
            <h1 className="text-sm font-semibold tracking-wide">Research Management System</h1>
          </div>
          <div className="min-w-0 flex-1">{headerRight}</div>
        </div>
      </header>
      {topNav && <div className="shrink-0 border-b border-slate-200 bg-white px-4"><div className="mx-auto w-full max-w-6xl">{topNav}</div></div>}
      <div className="flex-1 min-h-0">
        <main className="min-h-0 h-full">{main}</main>
      </div>

      {mobileSidebarOpen && (
        <div className="fixed inset-0 z-20 md:hidden">
          <div className="absolute inset-0 bg-slate-900/30" onClick={() => setMobileSidebarOpen(false)} />
          <div className="absolute left-0 top-0 h-full w-72 bg-white p-4 shadow-xl">{topNav}</div>
        </div>
      )}
    </div>
  );
}
