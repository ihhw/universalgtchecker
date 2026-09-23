import { cn } from "@/lib/utils";

/**
 * Universal Checker mark: a unified U + C monogram. Geometric, symbol-only —
 * no wordmark is baked into the artwork (see `Brand` for the text lockup).
 * Rendered as inline SVG so it's crisp at any size and themeable via
 * currentColor-free gradients matched to the white/beige palette.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label="Universal Checker"
      className={cn("h-9 w-9 shrink-0 select-none", className)}
    >
      <defs>
        <linearGradient id="uc-u" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3A332B" />
          <stop offset="1" stopColor="#221E19" />
        </linearGradient>
        <linearGradient id="uc-c" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#AC9880" />
          <stop offset="1" stopColor="#8C7A63" />
        </linearGradient>
      </defs>

      {/* U: two rounded bars joined by a wide rounded turn, dark charcoal. */}
      <path
        d="M13 11 L13 35 A11 11 0 0 0 35 35 L35 11"
        fill="none"
        stroke="url(#uc-u)"
        strokeWidth="7.2"
        strokeLinecap="round"
      />

      {/* C: a taupe ring open to the right, its arc passing through the U's right leg. */}
      <path
        d="M51 21.5 A15 15 0 1 0 51 42.5"
        fill="none"
        stroke="url(#uc-c)"
        strokeWidth="7.2"
        strokeLinecap="round"
      />
    </svg>
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
