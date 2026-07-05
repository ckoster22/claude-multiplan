import { describe, it, expect, afterEach, vi } from "vitest";
import { openModal, modalStackDepth } from "./modal";

// jsdom. Note: real iframe focus is browser-only — jsdom cannot exercise focus crossing into an
// embedded iframe, so the focus-trap tests below drive only the modal CHROME (button/link), which is
// exactly the honest guarantee the primitive makes.

function content(text = "body"): HTMLElement {
  const el = document.createElement("div");
  el.textContent = text;
  return el;
}

afterEach(() => {
  // Close any modals a test left open so stack/wheel-lock refcounts don't leak between tests.
  let guard = 0;
  while (modalStackDepth() > 0 && guard++ < 50) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  }
  document.body.innerHTML = "";
});

describe("openModal — a11y + structure", () => {
  it("gives the backdrop role=dialog, aria-modal, and the supplied aria-label", () => {
    const h = openModal({ label: "My preview", content: content() });
    expect(h.backdrop.getAttribute("role")).toBe("dialog");
    expect(h.backdrop.getAttribute("aria-modal")).toBe("true");
    expect(h.backdrop.getAttribute("aria-label")).toBe("My preview");
    // The supplied content lives inside the card.
    expect(h.card.contains(h.backdrop.querySelector(".modal-card > div"))).toBe(true);
  });

  it("applies the optional className to the backdrop", () => {
    const h = openModal({ label: "x", content: content(), className: "proto-preview" });
    expect(h.backdrop.classList.contains("proto-preview")).toBe(true);
  });
});

describe("openModal — close() teardown", () => {
  it("removes the backdrop from the DOM, drops stack depth, and fires onClose exactly once", () => {
    const onClose = vi.fn();
    const h = openModal({ label: "x", content: content(), onClose });
    expect(document.body.contains(h.backdrop)).toBe(true);
    expect(modalStackDepth()).toBe(1);

    h.close();
    expect(document.body.contains(h.backdrop)).toBe(false);
    expect(modalStackDepth()).toBe(0);
    expect(onClose).toHaveBeenCalledTimes(1);

    // Idempotent: a second close() does not re-fire onClose.
    h.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("openModal — Esc closes the topmost only", () => {
  it("Esc dismisses the open modal", () => {
    const h = openModal({ label: "x", content: content() });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(modalStackDepth()).toBe(0);
    expect(document.body.contains(h.backdrop)).toBe(false);
  });
});

describe("openModal — backdrop vs card click", () => {
  it("a mousedown on the backdrop closes; a mousedown inside the card does not", () => {
    const h = openModal({ label: "x", content: content() });

    h.card.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(modalStackDepth()).toBe(1);

    h.backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(modalStackDepth()).toBe(0);
  });
});

describe("openModal — scroll-lock refcount", () => {
  it("stays wheel-locked until the LAST modal closes (open 2 / close 1 → still locked)", () => {
    const reader = document.createElement("div");
    document.body.append(reader);

    const h1 = openModal({ label: "a", content: content() });
    const h2 = openModal({ label: "b", content: content() });

    // A wheel event outside the top card is prevented (swallowed) while locked.
    const e1 = new WheelEvent("wheel", { cancelable: true, bubbles: true });
    reader.dispatchEvent(e1);
    expect(e1.defaultPrevented).toBe(true);

    h2.close();
    // One modal still open → still locked.
    const e2 = new WheelEvent("wheel", { cancelable: true, bubbles: true });
    reader.dispatchEvent(e2);
    expect(e2.defaultPrevented).toBe(true);

    h1.close();
    // All closed → the wheel listener is gone, nothing prevents the event.
    const e3 = new WheelEvent("wheel", { cancelable: true, bubbles: true });
    reader.dispatchEvent(e3);
    expect(e3.defaultPrevented).toBe(false);
  });
});

describe("openModal — stacking", () => {
  it("renders a second modal at a higher z-index, and Esc drops depth 2 → 1 (topmost only)", () => {
    const h1 = openModal({ label: "a", content: content() });
    const h2 = openModal({ label: "b", content: content() });
    expect(modalStackDepth()).toBe(2);

    const z1 = Number(h1.backdrop.style.zIndex);
    const z2 = Number(h2.backdrop.style.zIndex);
    expect(z2).toBeGreaterThan(z1);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    // Only the topmost closed.
    expect(modalStackDepth()).toBe(1);
    expect(document.body.contains(h2.backdrop)).toBe(false);
    expect(document.body.contains(h1.backdrop)).toBe(true);
  });
});

describe("openModal — focus-trap on chrome", () => {
  it("focuses the X button initially and wraps Tab from last focusable back to first", () => {
    // Give the card a second focusable (a link) so first !== last.
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = "link";
    const h = openModal({ label: "x", content: link });

    const closeBtn = h.card.querySelector<HTMLElement>(".modal-close")!;
    expect(document.activeElement).toBe(closeBtn);

    // Move focus to the last focusable, then Tab forward → wraps to first (the X button).
    link.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(closeBtn);
  });
});
