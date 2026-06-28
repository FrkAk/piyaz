import { IconPencil } from "@/components/shared/icons";

interface EditButtonProps {
  /** Enters edit mode. */
  onClick: () => void;
  /** Accessible name, e.g. "Edit description". Becomes `aria-label` and `title`. */
  label: string;
  /** Positioning utilities supplied by the call site. */
  className?: string;
}

/**
 * Pencil affordance that enters inline-edit mode on touch devices, where
 * double-click is unreliable. Hidden on hover-capable (desktop) devices, which
 * use double-click instead.
 * @param props - Button configuration.
 * @returns A touch-only pencil edit button.
 */
export function EditButton({
  onClick,
  label,
  className = "",
}: EditButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`hidden h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-accent-light active:bg-surface-hover active:text-accent-light focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 pointer-coarse:inline-flex ${className}`}
    >
      <IconPencil size={15} />
    </button>
  );
}

export default EditButton;
