import { EDIT_HINT_LABEL } from "@/components/shared/inlineEdit";

/**
 * Hover-revealed affordance signaling double-click-to-edit on an inline field.
 * Render inside a display container that carries `group/edit` and `relative`.
 * Anchored just above the container's top-right so it never overlaps body text.
 * @returns Absolutely positioned hint label.
 */
export function EditHint() {
  return (
    <span className="pointer-events-none absolute bottom-full right-1 mb-1 select-none rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] font-medium text-text-muted opacity-0 shadow-sm transition-opacity duration-150 group-hover/edit:opacity-100">
      {EDIT_HINT_LABEL}
    </span>
  );
}

export default EditHint;
