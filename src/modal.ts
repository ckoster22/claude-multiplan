// Domain-agnostic modal primitive (no prototype/Tauri knowledge). Built programmatically so it
// pins no contract.test.ts selectors. Reusable seam: a second modal (SVG overlay + gallery) can be
// stacked on top of the prototype-preview modal opened by this one.
//
// Guarantees: z-index stacking above the app's other overlays; Esc / backdrop-click dismiss ONLY
// the topmost modal; a refcounted wheel capture so the reading pane behind cannot scroll while any
// modal is open; and a focus-trap over the modal CHROME (the X button + any focusable content).
//
// HONEST LIMITATION: a DOM-level trap cannot contain focus once it enters an embedded iframe (the
// frame's internal focusables are opaque to the parent). The preview iframe is therefore kept out
// of the tab order (tabindex="-1") and this primitive guarantees only Esc/backdrop/X dismissal — it
// does not claim to trap Tab inside a same-origin iframe.

export interface ModalOptions {
  label: string;
  content: HTMLElement;
  onClose?: () => void;
  className?: string;
}

export interface ModalHandle {
  close(): void;
  readonly backdrop: HTMLElement;
  readonly card: HTMLElement;
}

// Base above `.conv-modal` (z-index:50) and `.toast` (z-index:60); +STEP per stack depth so a
// second open renders above the first.
const BASE_Z = 200;
const STEP_Z = 10;

interface StackEntry {
  handle: ModalHandle;
  onClose: (() => void) | undefined;
  opener: Element | null;
  onKeydown: (e: KeyboardEvent) => void;
}

const stack: StackEntry[] = [];

// Refcounted wheel capture: while any modal is open a single document-level wheel listener swallows
// scroll so it never reaches the reading pane behind the fixed backdrop. `body` is already
// `overflow:hidden`, so locking it is a no-op — the real scrollers are `#reader-scroll`/`.plan-list`,
// and the fixed `inset:0` backdrop over them plus this capture is what actually stops the scroll.
let wheelLockDepth = 0;
function swallowWheel(e: WheelEvent): void {
  const topCard = stack.length > 0 ? stack[stack.length - 1].handle.card : null;
  // Let the modal card (and its scrollable content) scroll normally; block everything else.
  if (topCard && e.target instanceof Node && topCard.contains(e.target)) return;
  e.preventDefault();
}
function acquireWheelLock(): void {
  if (wheelLockDepth === 0) {
    document.addEventListener("wheel", swallowWheel, { passive: false });
  }
  wheelLockDepth += 1;
}
function releaseWheelLock(): void {
  wheelLockDepth = Math.max(0, wheelLockDepth - 1);
  if (wheelLockDepth === 0) {
    document.removeEventListener("wheel", swallowWheel);
  }
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true",
  );
}

export function modalStackDepth(): number {
  return stack.length;
}

export function openModal(opts: ModalOptions): ModalHandle {
  const depth = stack.length;
  const opener = document.activeElement;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop" + (opts.className ? ` ${opts.className}` : "");
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", opts.label);
  backdrop.style.zIndex = String(BASE_Z + depth * STEP_Z);

  const card = document.createElement("div");
  card.className = "modal-card";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "modal-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";

  card.append(closeBtn, opts.content);
  backdrop.append(card);

  let closed = false;
  const handle: ModalHandle = {
    backdrop,
    card,
    close(): void {
      if (closed) return;
      closed = true;
      const idx = stack.findIndex((e) => e.handle === handle);
      if (idx !== -1) stack.splice(idx, 1);
      document.removeEventListener("keydown", entry.onKeydown, true);
      backdrop.remove();
      releaseWheelLock();
      if (opener instanceof HTMLElement) opener.focus();
      opts.onClose?.();
    },
  };

  const onKeydown = (e: KeyboardEvent): void => {
    // Only the TOPMOST modal responds — Esc dismisses just it; Tab is trapped within its chrome.
    if (stack.length === 0 || stack[stack.length - 1].handle !== handle) return;
    if (e.key === "Escape") {
      e.preventDefault();
      handle.close();
      return;
    }
    if (e.key === "Tab") {
      const items = focusables(card);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !card.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !card.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const entry: StackEntry = { handle, onClose: opts.onClose, opener, onKeydown };
  stack.push(entry);

  backdrop.addEventListener("mousedown", (e) => {
    // Backdrop-click dismisses; clicks inside the card do not. mousedown (not click) so a drag that
    // starts inside the card and releases on the backdrop cannot close it.
    if (e.target === backdrop) handle.close();
  });
  closeBtn.addEventListener("click", () => handle.close());
  document.addEventListener("keydown", onKeydown, true);

  document.body.append(backdrop);
  acquireWheelLock();
  closeBtn.focus();

  return handle;
}
