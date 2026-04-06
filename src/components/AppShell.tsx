import { ReactNode } from 'react';

type Props = {
  headerRight?: ReactNode;
  topNav?: ReactNode;
  main: ReactNode;
};

export function AppShell({ headerRight, topNav, main }: Props) {
  return (
    <div className="app-shell-viewport flex max-w-full flex-col overflow-x-hidden bg-slate-50">
      <header className="h-14 shrink-0 border-b border-slate-200 bg-white px-4">
        <div className="flex h-full w-full items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="text-sm font-semibold tracking-wide">Research Management System</h1>
          </div>
          <div className="min-w-0 flex-1">{headerRight}</div>
        </div>
      </header>
      {topNav && <div className="shrink-0 border-b border-slate-200 bg-white px-4"><div className="w-full min-w-0">{topNav}</div></div>}
      <div className="min-h-0 flex-1 overflow-auto">
        <main className="h-full min-h-0">{main}</main>
      </div>
    </div>
  );
}
