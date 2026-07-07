import type { CSSProperties } from "react";

/**
 * Build an inline style from skeleton CSS custom properties
 * (`--skeleton-delay`, `--skeleton-radius`, `--skeleton-base`) so loading
 * placeholders speak the shared `skeleton-bar` / `rise-in` vocabulary.
 *
 * @param vars - Custom-property map applied to a skeleton element.
 * @returns The map typed as a React inline style.
 */
export function skeletonVars(
  vars: Record<`--skeleton-${string}`, string>,
): CSSProperties {
  return vars as CSSProperties;
}
