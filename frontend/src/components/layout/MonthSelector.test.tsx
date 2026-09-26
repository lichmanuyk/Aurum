import { afterEach, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { MonthSelector } from "./MonthSelector";

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function render(props: Parameters<typeof MonthSelector>[0]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root.render(<MonthSelector {...props} />));
}

it("hides the \"every month\" pill by default — a plain single-month picker (e.g. Budgets) never sees it", () => {
  render({ month: 5, onChange: () => {} });
  const buttons = container.querySelectorAll("button");
  expect(buttons.length).toBe(12);
});

it("shows the \"every month\" pill only when allowAll is set, and reports its own pressed state", () => {
  render({ month: null, onChange: () => {}, allowAll: true });
  const buttons = Array.from(container.querySelectorAll("button"));
  expect(buttons.length).toBe(13);
  expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
  expect(buttons[1].getAttribute("aria-pressed")).toBe("false");
});

it("only renders maxMonth month pills — a future month of the current year is never offered, not just disabled", () => {
  render({ month: null, onChange: () => {}, allowAll: true, maxMonth: 9 });
  const buttons = container.querySelectorAll("button");
  expect(buttons.length).toBe(1 + 9); // the "every month" pill plus exactly 9 months
});

it("calls onChange(null) from the \"every month\" pill and onChange(value) from a month pill", () => {
  const calls: Array<number | null> = [];
  render({ month: 5, onChange: (value) => calls.push(value), allowAll: true });
  const buttons = Array.from(container.querySelectorAll("button"));
  flushSync(() => buttons[0].dispatchEvent(new MouseEvent("click", { bubbles: true }))); // "every month"
  flushSync(() => buttons[3].dispatchEvent(new MouseEvent("click", { bubbles: true }))); // 3rd month pill = March
  expect(calls).toEqual([null, 3]);
});
