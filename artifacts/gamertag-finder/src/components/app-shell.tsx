import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Menu, X } from "lucide-react";
import { Brand, LogoMark } from "@/components/logo";
import { ConnectXboxButton, ConnectXboxDialog } from "@/components/xbox-connect";
import { cn } from "@/lib/utils";

interface NavItem { label: string; href: string; match?: (path: string) => boolean }
interface NavGroup { label: string; items: NavItem[] }

// New platform checkers are added here as they are integrated.
const PLATFORMS: NavGroup[] = [
  {
    label: "Xbox",
    items: [
      { label: "Checker", href: "/xbox" },
      { label: "Sniper", href: "/xbox/sniper" },
      { label: "Hits", href: "/hits" },
    ],
  },
  {
    label: "Discord",
    items: [
      { label: "Checker", href: "/discord" },
      { label: "Hits", href: "/discord/hits" },
    ],
  },
];

const WORKSPACE: NavItem[] = [
  { label: "Home", href: "/" },
  { label: "Analytics", href: "/analytics" },
  { label: "Live activity", href: "/activity" },
  { label: "System status", href: "/status" },
  { label: "Diagnostics", href: "/diagnostics" },
  { label: "Settings", href: "/settings" },
];

function NavLink({ item, path, nested }: { item: NavItem; path: string; nested?: boolean }) {
  const active = item.match ? item.match(path) : path === item.href;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex items-center rounded-lg px-4 py-2 text-sm transition-colors",
        nested && "pl-7",
        active
          ? "bg-secondary text-foreground before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-primary"
          : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
      )}
    >
      {item.label}
    </Link>
  );
}

function SidebarBody({ path }: { path: string }) {
  return (
    <div className="flex h-full flex-col">
      <div className="px-5 pb-6 pt-6">
        <Brand />
      </div>

      <nav className="flex-1 space-y-7 overflow-y-auto px-3 pb-4" aria-label="Primary">
        <div>
          <p className="eyebrow px-4 pb-2">Platforms</p>
          <div className="space-y-0.5">
            {PLATFORMS.map((group) => (
              <div key={group.label}>
                <p className="px-4 pb-1 pt-1.5 text-sm font-medium text-foreground">{group.label}</p>
                <div className="space-y-0.5">
                  {group.items.map((item) => <NavLink key={item.href} item={item} path={path} nested />)}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <p className="eyebrow px-4 pb-2">Workspace</p>
          <div className="space-y-0.5">
            {WORKSPACE.map((item) => <NavLink key={item.href} item={item} path={path} />)}
          </div>
        </div>
      </nav>

      <div className="border-t border-border p-4">
        <ConnectXboxButton />
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [path] = useLocation();
  const [open, setOpen] = useState(false);

  // Close the mobile drawer on navigation and on Escape.
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[264px_minmax(0,1fr)]">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh border-r border-border bg-sidebar lg:block">
        <SidebarBody path={path} />
      </aside>

      {/* Mobile top bar */}
      <div className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-background/90 px-4 backdrop-blur lg:hidden">
        <div className="flex items-center gap-2.5">
          <LogoMark className="h-8 w-8" />
          <div className="leading-none">
            <span className="block text-[13px] font-bold tracking-[0.1em]">UNIVERSAL CHECKER</span>
            <span className="mt-1 block font-mono text-[10px] tracking-[0.18em] text-muted-foreground">BY SJAF</span>
          </div>
        </div>
        <button
          type="button"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/70"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-[280px] max-w-[85vw] border-r border-border bg-sidebar shadow-2xl">
            <SidebarBody path={path} />
          </aside>
        </div>
      )}

      <main className="min-w-0 px-4 py-6 sm:px-8 lg:px-10 lg:py-9">
        <div className="mx-auto max-w-[1200px]">{children}</div>
      </main>

      <ConnectXboxDialog />
    </div>
  );
}
