import { cn } from "@/lib/utils";

interface PillOption<T extends string> {
  value: T;
  label: string;
}

interface PillSelectorProps<T extends string> {
  options: Array<PillOption<T>>;
  value: T;
  onChange: (value: T) => void;
  // Options a caller can't switch to right now — e.g. a business-date-
  // relative period (see docs/tasks/business-date-timezone.md) before the
  // server's business date has loaded, where switching to it would either
  // run with no bound at all or (worse) a guessed one. Rendered visibly
  // disabled (not hidden — the option still exists, just not clickable
  // yet) rather than silently doing nothing on click.
  disabledValues?: readonly T[];
}

export function PillSelector<T extends string>({ options, value, onChange, disabledValues }: PillSelectorProps<T>) {
  return (
    <div className="inline-flex gap-1 rounded-lg border border-border bg-surface-1 p-1">
      {options.map((option) => {
        const active = option.value === value;
        const disabled = disabledValues?.includes(option.value) ?? false;
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              disabled
                ? "cursor-not-allowed text-text-muted opacity-50"
                : active
                  ? "bg-surface-2 text-text-primary"
                  : "text-text-muted hover:text-text-primary"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
