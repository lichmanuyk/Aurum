import { useTranslation } from "@/lib/i18n";

interface BusinessDateNoticeProps {
  isError: boolean;
  retry: () => void;
  className?: string;
}

/** Shared "waiting on/failed to get the server's business date" line (see
 * docs/tasks/business-date-timezone.md) — every page/modal that gates a
 * date-relative action (a form's "today" default, a "this year"/"5 years"
 * report range, a year/month picker's own current-period cap) on
 * `useBusinessDate()` renders this instead of duplicating the same
 * loading/error/retry JSX. Never rendered once the business date has
 * loaded successfully — callers are expected to only mount this while
 * `businessDate` is still `undefined`. */
export function BusinessDateNotice({ isError, retry, className }: BusinessDateNoticeProps) {
  const { t } = useTranslation();
  return isError ? (
    <p className={className ?? "text-xs text-danger"}>
      {t("businessDate.error")}{" "}
      <button type="button" className="underline" onClick={retry}>
        {t("businessDate.retry")}
      </button>
    </p>
  ) : (
    <p className={className ?? "text-xs text-text-muted"}>{t("businessDate.loading")}</p>
  );
}
