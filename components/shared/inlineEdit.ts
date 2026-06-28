/** User-facing affordance label shared by the hover chip and the trigger tooltip. */
export const EDIT_HINT_LABEL = "Double-click to edit";

/**
 * Resolve a viewport point to a DOM node + offset across browsers.
 * @param doc - Document to query.
 * @param x - Pointer X in viewport coordinates.
 * @param y - Pointer Y in viewport coordinates.
 * @returns The node and offset under the point, or null.
 */
function nodeOffsetFromPoint(
  doc: Document,
  x: number,
  y: number,
): { node: Node; offset: number } | null {
  if (typeof doc.caretPositionFromPoint === "function") {
    const pos = doc.caretPositionFromPoint(x, y);
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
  }
  const legacy = (
    doc as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    }
  ).caretRangeFromPoint;
  if (typeof legacy === "function") {
    const range = legacy.call(doc, x, y);
    return range
      ? { node: range.startContainer, offset: range.startOffset }
      : null;
  }
  return null;
}

/**
 * Sum text length preceding a node/offset within a root element.
 * @param root - Element whose text content is measured.
 * @param node - Target text node.
 * @param offset - Offset within the target node.
 * @returns Absolute character offset from the start of `root`.
 */
function absoluteTextOffset(
  root: HTMLElement,
  node: Node,
  offset: number,
): number {
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  );
  let total = 0;
  let current = walker.nextNode();
  while (current) {
    if (current === node) return total + offset;
    total += current.textContent?.length ?? 0;
    current = walker.nextNode();
  }
  return total;
}

/**
 * Character offset within a display element for a viewport point. Only
 * meaningful when the element's rendered text mirrors the editable value
 * (plain-text fields), not rendered markdown.
 * @param root - Display element under the pointer.
 * @param clientX - Pointer X in viewport coordinates.
 * @param clientY - Pointer Y in viewport coordinates.
 * @returns Zero-based offset, or null when the point resolves outside `root`.
 */
export function caretOffsetFromPoint(
  root: HTMLElement,
  clientX: number,
  clientY: number,
): number | null {
  const hit = nodeOffsetFromPoint(root.ownerDocument, clientX, clientY);
  if (!hit || !root.contains(hit.node)) return null;
  return absoluteTextOffset(root, hit.node, hit.offset);
}

/**
 * Place the caret of a text control at an offset, or at the end when null.
 * @param el - Input or textarea to position.
 * @param offset - Target offset, clamped to the value length; null places the caret at the end.
 */
export function placeCaret(
  el: HTMLInputElement | HTMLTextAreaElement,
  offset: number | null,
): void {
  const pos =
    offset == null
      ? el.value.length
      : Math.min(Math.max(offset, 0), el.value.length);
  el.setSelectionRange(pos, pos);
}
