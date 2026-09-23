import { useRef, type ReactNode } from "react";
import { Plus, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { CATEGORIES, MODES, type CategoryId, type Field, type ModeDef, type Params, type TemplateDef } from "@/lib/modes";
import { cn } from "@/lib/utils";

const inputCls =
  "w-full rounded-lg border border-border bg-[hsl(var(--well))] px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:border-primary/60 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";
const smallBtn =
  "inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-muted-foreground/40 hover:text-foreground disabled:opacity-50";

// ── mode picker ──────────────────────────────────────────────────────────────

export function ModePicker({
  mode, onSelect, disabled,
}: { mode: string; onSelect: (id: string) => void; disabled?: boolean }) {
  const active: CategoryId = (MODES.find((m) => m.id === mode)?.category) ?? "basic";
  return (
    <div>
      <div role="tablist" aria-label="Mode category" className="flex gap-1 rounded-lg border border-border bg-[hsl(var(--well))] p-1">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={active === c.id}
            disabled={disabled}
            onClick={() => {
              if (active !== c.id) onSelect(MODES.find((m) => m.category === c.id)!.id);
            }}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-[13px] transition-colors disabled:cursor-not-allowed",
              active === c.id ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div role="radiogroup" aria-label="Mode" className="mt-3 flex flex-wrap gap-2">
        {MODES.filter((m) => m.category === active).map((m) => {
          const on = m.id === mode;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => onSelect(m.id)}
              className={cn(
                "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                on ? "border-primary bg-primary/[0.06]" : "border-border bg-[hsl(var(--well))] hover:border-muted-foreground/40",
              )}
            >
              <span className={cn("block text-sm font-medium", on && "text-primary")}>{m.label}</span>
              <span className="block text-[11px] text-muted-foreground">{m.summary}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── field renderers ──────────────────────────────────────────────────────────

const asString = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v) : "");
const toNumberOrBlank = (raw: string): number | "" => (raw.trim() === "" ? "" : Number(raw));

function Shell({ label, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={cn("min-w-0", wide && "sm:col-span-2")}>
      <p className="mb-1.5 text-[13px] font-medium">{label}</p>
      {children}
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function RulesEditor({
  value, onChange, disabled,
}: { value: unknown; onChange: (v: unknown[]) => void; disabled?: boolean }) {
  const rules = (Array.isArray(value) ? value : []) as { position?: number | ""; op?: string; char?: string }[];
  const update = (i: number, patch: object) => onChange(rules.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rules.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Position</span>
          <input
            type="number" min={1} max={15} aria-label="Position" disabled={disabled}
            value={asString(r.position)} className={cn(inputCls, "w-16")}
            onChange={(e) => update(i, { position: toNumberOrBlank(e.target.value) })}
          />
          <select
            aria-label="Rule" disabled={disabled} value={r.op ?? "="} className={cn(inputCls, "w-28")}
            onChange={(e) => update(i, { op: e.target.value })}
          >
            <option value="=">is</option>
            <option value="!=">is not</option>
          </select>
          <input
            aria-label="Character" maxLength={1} disabled={disabled} value={asString(r.char)}
            className={cn(inputCls, "w-14 text-center font-mono uppercase")}
            onChange={(e) => update(i, { char: e.target.value })}
          />
          <button type="button" aria-label="Remove rule" disabled={disabled} className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground" onClick={() => onChange(rules.filter((_, k) => k !== i))}>
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
      {rules.length < 30 && (
        <button type="button" disabled={disabled} className={smallBtn} onClick={() => onChange([...rules, { position: rules.length + 1, op: "=", char: "" }])}>
          <Plus className="h-3.5 w-3.5" /> Add rule
        </button>
      )}
    </div>
  );
}

function CountsEditor({
  value, onChange, disabled,
}: { value: unknown; onChange: (v: unknown[]) => void; disabled?: boolean }) {
  const rows = (Array.isArray(value) ? value : []) as { char?: string; count?: number | "" }[];
  const update = (i: number, patch: object) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Character</span>
          <input
            aria-label="Character" maxLength={1} disabled={disabled} value={asString(r.char)}
            className={cn(inputCls, "w-14 text-center font-mono uppercase")}
            onChange={(e) => update(i, { char: e.target.value })}
          />
          <span className="text-xs text-muted-foreground">exactly</span>
          <input
            type="number" min={0} max={15} aria-label="How many times" disabled={disabled}
            value={asString(r.count)} className={cn(inputCls, "w-16")}
            onChange={(e) => update(i, { count: toNumberOrBlank(e.target.value) })}
          />
          <span className="text-xs text-muted-foreground">times</span>
          <button type="button" aria-label="Remove count" disabled={disabled} className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground" onClick={() => onChange(rows.filter((_, k) => k !== i))}>
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
      {rows.length < 30 && (
        <button type="button" disabled={disabled} className={smallBtn} onClick={() => onChange([...rows, { char: "", count: 1 }])}>
          <Plus className="h-3.5 w-3.5" /> Add count
        </button>
      )}
    </div>
  );
}

function LinesField({
  field, value, onChange, disabled,
}: { field: Extract<Field, { kind: "lines" }>; value: unknown; onChange: (v: string[]) => void; disabled?: boolean }) {
  const lines = Array.isArray(value) ? (value as string[]) : [];
  const fileRef = useRef<HTMLInputElement>(null);
  const filled = lines.filter((l) => l.trim() !== "").length;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 1_000_000) {
      toast.error("That file is too large (1 MB maximum).");
      return;
    }
    try {
      onChange((await file.text()).split(/\r?\n/));
    } catch {
      toast.error("Could not read that file.");
    }
  };

  return (
    <div>
      <textarea
        aria-label={field.label} rows={8} disabled={disabled} spellCheck={false}
        value={lines.join("\n")} placeholder={"One gamertag per line"}
        onChange={(e) => onChange(e.target.value.split("\n"))}
        className={cn(inputCls, "font-mono")}
      />
      <div className="mt-2 flex items-center gap-2">
        {field.upload && (
          <>
            <input ref={fileRef} type="file" accept=".txt,text/plain" className="hidden" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
            <button type="button" disabled={disabled} className={smallBtn} onClick={() => fileRef.current?.click()}>
              <Upload className="h-3.5 w-3.5" /> Upload .txt
            </button>
          </>
        )}
        {lines.length > 0 && (
          <button type="button" disabled={disabled} className={smallBtn} onClick={() => onChange([])}>Clear</button>
        )}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{filled.toLocaleString()} {filled === 1 ? "line" : "lines"}</span>
      </div>
    </div>
  );
}

function FieldControl({
  field, params, set, disabled,
}: { field: Field; params: Params; set: (patch: Params) => void; disabled?: boolean }) {
  const v = params[field.key];
  switch (field.kind) {
    case "range": {
      const min = params["minLength"];
      const max = params["maxLength"];
      return (
        <div className="flex items-center gap-2">
          <input
            type="number" min={3} max={15} aria-label="Minimum length" disabled={disabled}
            value={asString(min)} className={cn(inputCls, "w-20")}
            onChange={(e) => {
              const n = toNumberOrBlank(e.target.value);
              // Keep the maximum from falling below the minimum while typing.
              set(n !== "" && typeof max === "number" && max < n ? { minLength: n, maxLength: n } : { minLength: n });
            }}
          />
          <span className="text-xs text-muted-foreground">to</span>
          <input
            type="number" min={3} max={15} aria-label="Maximum length" disabled={disabled}
            value={asString(max)} className={cn(inputCls, "w-20")}
            onChange={(e) => set({ maxLength: toNumberOrBlank(e.target.value) })}
          />
          <span className="text-xs text-muted-foreground">characters</span>
        </div>
      );
    }
    case "int":
      return (
        <input
          type="number" min={field.min} max={field.max} disabled={disabled} aria-label={field.label}
          value={asString(v)} className={cn(inputCls, "w-28")}
          onChange={(e) => set({ [field.key]: toNumberOrBlank(e.target.value) })}
        />
      );
    case "text":
      return (
        <input
          disabled={disabled} aria-label={field.label} maxLength={field.maxLength} spellCheck={false}
          autoCapitalize="off" autoComplete="off" placeholder={field.placeholder}
          value={asString(v)} className={cn(inputCls, field.mono && "font-mono")}
          onChange={(e) => set({ [field.key]: e.target.value })}
        />
      );
    case "chars":
      return (
        <input
          disabled={disabled} aria-label={field.label} spellCheck={false} autoCapitalize="off" autoComplete="off"
          placeholder={field.placeholder} value={asString(v)} className={cn(inputCls, "font-mono")}
          onChange={(e) => set({ [field.key]: e.target.value })}
        />
      );
    case "select":
      return (
        <select
          disabled={disabled} aria-label={field.label} value={asString(v) || field.options[0]!.value}
          className={inputCls} onChange={(e) => set({ [field.key]: e.target.value })}
        >
          {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    case "toggle":
      return <Switch checked={v === true} disabled={disabled} aria-label={field.label} onCheckedChange={(c) => set({ [field.key]: c })} />;
    case "textarea":
      return (
        <textarea
          disabled={disabled} aria-label={field.label} rows={field.rows ?? 3} spellCheck={false}
          placeholder={field.placeholder} value={asString(v)} className={cn(inputCls, "font-mono")}
          onChange={(e) => set({ [field.key]: e.target.value })}
        />
      );
    case "lines":
      return <LinesField field={field} value={v} disabled={disabled} onChange={(next) => set({ [field.key]: next })} />;
    case "rules":
      return <RulesEditor value={v} disabled={disabled} onChange={(next) => set({ [field.key]: next })} />;
    case "counts":
      return <CountsEditor value={v} disabled={disabled} onChange={(next) => set({ [field.key]: next })} />;
  }
}

const isWide = (f: Field): boolean =>
  f.kind === "textarea" || f.kind === "lines" || f.kind === "rules" || f.kind === "counts" || f.kind === "range";

/** Settings for the selected mode only. Nothing else is shown. */
export function ModeForm({
  mode, params, onChange, disabled,
}: { mode: ModeDef; params: Params; onChange: (patch: Params) => void; disabled?: boolean }) {
  const fields = mode.fields.filter((f) => !f.when || f.when(params));
  if (fields.length === 0 && !mode.note) return null;
  return (
    <div className="mt-4 rounded-lg border border-border bg-[hsl(var(--well))] p-4">
      {mode.note && <p className="mb-4 text-[13px] leading-relaxed text-muted-foreground">{mode.note}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((f) =>
          f.kind === "toggle" ? (
            <div key={f.key} className="flex items-start justify-between gap-4 sm:col-span-2">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">{f.label}</p>
                {f.hint && <p className="mt-0.5 text-xs text-muted-foreground">{f.hint}</p>}
              </div>
              <FieldControl field={f} params={params} set={onChange} disabled={disabled} />
            </div>
          ) : (
            <Shell key={f.key} label={f.label} hint={f.hint} wide={isWide(f)}>
              <FieldControl field={f} params={params} set={onChange} disabled={disabled} />
            </Shell>
          ),
        )}
      </div>
    </div>
  );
}

// ── templates ────────────────────────────────────────────────────────────────

export function TemplatesPanel({
  builtin, saved, onApply, onSave, onDelete, saveLabel, disabled,
}: {
  builtin: TemplateDef[];
  saved: TemplateDef[];
  onApply: (t: TemplateDef) => void;
  onSave: (name: string) => void;
  onDelete: (id: string) => void;
  saveLabel: string;
  disabled?: boolean;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const card = (t: TemplateDef, removable: boolean) => (
    <div key={t.id} className="flex items-center gap-1 rounded-lg border border-border bg-card transition-colors hover:border-muted-foreground/40">
      <button type="button" disabled={disabled} onClick={() => onApply(t)} className="min-w-0 flex-1 px-3 py-2 text-left disabled:opacity-60">
        <span className="block truncate text-sm font-medium">{t.label}</span>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">{t.hint}</span>
      </button>
      {removable && (
        <button type="button" aria-label={`Delete template ${t.label}`} className="mr-1 rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground" onClick={() => onDelete(t.id)}>
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );

  return (
    <div className="mt-4 space-y-5 rounded-lg border border-border bg-[hsl(var(--well))] p-4">
      <div>
        <p className="mb-2 text-[13px] font-medium">Starting points</p>
        <div className="grid gap-2 sm:grid-cols-2">{builtin.map((t) => card(t, false))}</div>
      </div>
      <div>
        <p className="mb-2 text-[13px] font-medium">Your templates</p>
        {saved.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing saved yet.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">{saved.map((t) => card(t, true))}</div>
        )}
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const name = nameRef.current?.value.trim() ?? "";
            if (name === "") return;
            onSave(name);
            if (nameRef.current) nameRef.current.value = "";
          }}
        >
          <input ref={nameRef} maxLength={40} aria-label="Template name" placeholder="Template name" className={cn(inputCls, "max-w-56")} />
          <button type="submit" className={smallBtn}>Save current: {saveLabel}</button>
        </form>
      </div>
    </div>
  );
}
