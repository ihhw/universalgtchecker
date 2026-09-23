import { BASE } from "@/lib/api";
import { cn } from "@/lib/utils";

const LOGO_SRC = `${BASE}/logo-small.png`;

/** The Universal Checker logo (sleeping cat over "UNI"). */
export function LogoMark({ className }: { className?: string }) {
  return (
    <img
      src={LOGO_SRC}
      alt=""
      width={148}
      height={96}
      decoding="async"
      className={cn("h-9 w-auto shrink-0 select-none", className)}
    />
  );
}

/** Logo + wordmark. Deliberately not a link: the sidebar has no duplicate home entry. */
export function Brand({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <LogoMark />
      <div className="min-w-0 leading-none">
        <p className="truncate text-[13px] font-bold tracking-[0.1em] text-foreground">UNIVERSAL CHECKER</p>
        <p className="mt-1.5 font-mono text-[10px] tracking-[0.18em] text-muted-foreground">BY SJAF</p>
      </div>
    </div>
  );
}
