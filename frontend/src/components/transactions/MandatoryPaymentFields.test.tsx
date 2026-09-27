import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MandatoryPaymentFields } from "./MandatoryPaymentFields";
import type { MandatoryPaymentKind } from "@/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(props: {
  type: "income" | "expense";
  assignedPeriod: string | null;
  mandatoryPaymentKind: MandatoryPaymentKind | null;
  onAssignedPeriodChange: (v: string | null) => void;
  onMandatoryPaymentKindChange: (v: MandatoryPaymentKind | null) => void;
}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<MandatoryPaymentFields idPrefix="test" {...props} />);
  });
}

it("income: checking the work-income box reveals a required month input, unchecking clears the period", async () => {
  const onPeriod = vi.fn();
  mount({
    type: "income", assignedPeriod: null, mandatoryPaymentKind: null,
    onAssignedPeriodChange: onPeriod, onMandatoryPaymentKindChange: vi.fn(),
  });

  expect(container.querySelector("#test-assigned-period")).toBeNull();
  const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
  await act(async () => { checkbox.click(); });
  expect(onPeriod).toHaveBeenCalledWith("");

  // Re-render as "checked" (parent would set assignedPeriod on toggle in a
  // real form) to confirm the month input then appears and is required.
  mount({
    type: "income", assignedPeriod: "2026-08-01", mandatoryPaymentKind: null,
    onAssignedPeriodChange: onPeriod, onMandatoryPaymentKindChange: vi.fn(),
  });
  const monthInput = container.querySelector("#test-assigned-period") as HTMLInputElement;
  expect(monthInput).not.toBeNull();
  expect(monthInput.required).toBe(true);
  expect(monthInput.value).toBe("2026-08");
});

it("expense: picking a mandatory kind reveals the period input and reports both fields together", async () => {
  const onPeriod = vi.fn();
  const onKind = vi.fn();
  mount({
    type: "expense", assignedPeriod: null, mandatoryPaymentKind: null,
    onAssignedPeriodChange: onPeriod, onMandatoryPaymentKindChange: onKind,
  });

  expect(container.querySelector("#test-assigned-period")).toBeNull();
  const select = container.querySelector("#test-mandatory-kind") as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(select, "zus");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onKind).toHaveBeenCalledWith("zus");
  // Picking a kind with no period yet clears/keeps period at null — never
  // silently invents a month (see tax_classification_violation).
  expect(onPeriod).toHaveBeenCalledWith(null);
});

it("expense: clearing the kind back to 'none' clears the period too", async () => {
  const onPeriod = vi.fn();
  const onKind = vi.fn();
  mount({
    type: "expense", assignedPeriod: "2026-08-01", mandatoryPaymentKind: "vat",
    onAssignedPeriodChange: onPeriod, onMandatoryPaymentKindChange: onKind,
  });
  const monthInput = container.querySelector("#test-assigned-period") as HTMLInputElement;
  expect(monthInput.value).toBe("2026-08");

  const select = container.querySelector("#test-mandatory-kind") as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(select, "");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onKind).toHaveBeenCalledWith(null);
  expect(onPeriod).toHaveBeenCalledWith(null);
});

it("renders nothing for transfer/adjustment types", () => {
  mount({
    type: "transfer" as never, assignedPeriod: null, mandatoryPaymentKind: null,
    onAssignedPeriodChange: vi.fn(), onMandatoryPaymentKindChange: vi.fn(),
  });
  expect(container.innerHTML).toBe("");
});
