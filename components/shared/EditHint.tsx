/**
 * Hover-revealed affordance signaling double-click-to-edit on an inline field.
 * Render inside a display container that carries `group/edit` and `relative`.
 * @returns Absolutely positioned hint label.
 */
export function EditHint() {
  return (
    <span className="pointer-events-none absolute right-2 top-2 select-none rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] font-medium text-text-muted opacity-0 shadow-sm transition-opacity duration-150 group-hover/edit:opacity-100">
      Double-click to edit
    </span>
  );
}

export default EditHint;
