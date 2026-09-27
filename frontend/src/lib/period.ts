/** Converts a stored assigned_period ("YYYY-MM-01") into the value an
 * <input type="month"> expects ("YYYY-MM"), and back. See
 * docs/tasks/income-tax-separation.md — the day is always fixed at 1 and
 * carries no information of its own. */
export function periodToMonthInput(period: string | null | undefined): string {
  return period ? period.slice(0, 7) : "";
}

export function monthInputToPeriod(value: string): string | null {
  return value ? `${value}-01` : null;
}
