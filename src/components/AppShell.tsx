import { Menu } from 'lucide-react';
import { ReactNode } from 'react';

type Props = {
  headerRight?: ReactNode;
  sidebar: ReactNode;
  fileList: ReactNode;
  main: ReactNode;
  mobileSidebarOpen: boolean;
  setMobileSidebarOpen: (open: boolean) => void;
};

export function AppShell({ headerRight, sidebar, fileList, main, mobileSidebarOpen, setMobileSidebarOpen }: Props) {
  return (
    <div className="h-screen bg-slate-50">
      <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-4">
        <div className="flex items-center gap-2">
          <button className="rounded-md p-2 hover:bg-slate-100 md:hidden" onClick={() => setMobileSidebarOpen(true)}>
            <Menu size={18} />
          </button>
          <h1 className="text-sm font-semibold tracking-wide">Prompt Manager</h1>
        </div>
        {headerRight}
      </header>
      <div className="grid h-[calc(100vh-56px)] grid-cols-1 md:grid-cols-[260px_320px_1fr]">
        <aside className="hidden border-r border-slate-200 bg-white md:block">{sidebar}</aside>
        <section className="hidden border-r border-slate-200 bg-panel md:block">{fileList}</section>
        <main className="min-h-0">{main}</main>
      </div>

      {mobileSidebarOpen && (
        <div className="fixed inset-0 z-20 md:hidden">
          <div className="absolute inset-0 bg-slate-900/30" onClick={() => setMobileSidebarOpen(false)} />
          <div className="absolute left-0 top-0 h-full w-72 bg-white shadow-xl">{sidebar}</div>
        </div>
      )}
    </div>
  );
}
