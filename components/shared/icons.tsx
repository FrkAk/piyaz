import type { SVGProps } from "react";

/** Common props for every icon — single `size` controls width and height; color follows `currentColor`. */
export interface IconProps
  extends Omit<SVGProps<SVGSVGElement>, "width" | "height"> {
  /** @param size - Pixel dimension applied to width and height. Defaults to 14. */
  size?: number;
}

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/**
 * Base stroke-icon wrapper. Renders an SVG sized via `size` and inherits color via `currentColor`.
 * @param props - SVG props plus an optional `size` override and child paths.
 * @returns A 16-unit viewBox SVG element with shared stroke defaults.
 */
function IconBase({
  size = 14,
  children,
  ...rest
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
      {...STROKE}
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Chevron pointing down — disclosure indicator. */
export function IconChevronDown(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 6l4 4 4-4" />
    </IconBase>
  );
}

/** Chevron pointing right — breadcrumb separator and disclosure. */
export function IconChevronRight(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M6 4l4 4-4 4" />
    </IconBase>
  );
}

/** Chevron pointing up. */
export function IconChevronUp(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 10l4-4 4 4" />
    </IconBase>
  );
}

/** Chevron pointing left. */
export function IconChevronLeft(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M10 4l-4 4 4 4" />
    </IconBase>
  );
}

/**
 * Panel / drawer toggle — rounded rectangle with a left-side divider. Used
 * for the collapsible app sidebar, the graph mini rail, and any other
 * drawer-style affordance. State-agnostic by design: a single glyph reads as
 * "toggle this panel" regardless of whether it's currently open or closed.
 */
export function IconPanelLeft(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6 3v10" />
    </IconBase>
  );
}

/** Right-side panel / drawer toggle — mirror of {@link IconPanelLeft}. */
export function IconPanelRight(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M10 3v10" />
    </IconBase>
  );
}

/** Hamburger menu — mobile navigation drawer trigger. */
export function IconMenu(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </IconBase>
  );
}

/** Magnifying glass — search and ⌘K trigger. */
export function IconSearch(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.5 10.5l3 3" />
    </IconBase>
  );
}

/** Inbox tray — sidebar nav. */
export function IconInbox(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M2 9.5L4 3.5h8l2 6" />
      <path d="M2 9.5h3.5l1 1.5h3l1-1.5H14v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-3z" />
    </IconBase>
  );
}

/** Agent / chat bubble — sidebar agent runs. */
export function IconAgent(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 7a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3v3a3 3 0 0 1-3 3H6.5L4 14.5V13a3 3 0 0 1-1-2.5V7z" />
      <path d="M6.5 8.5h.01M9.5 8.5h.01" />
    </IconBase>
  );
}

/** Single user silhouette — assignee, my tasks. */
export function IconUser(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M8 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" />
      <path d="M3 13.5a5 5 0 0 1 10 0" />
    </IconBase>
  );
}

/** Two-user silhouette — team / members. */
export function IconUsers(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5.5 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
      <path d="M10.5 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
      <path d="M2 13.5a3.5 3.5 0 0 1 7 0" />
      <path d="M9 13.5a3.5 3.5 0 0 1 5-3.2" />
    </IconBase>
  );
}

/** Plus / add. */
export function IconPlus(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M8 3v10M3 8h10" />
    </IconBase>
  );
}

/** Filter funnel. */
export function IconFilter(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M2 4h12l-4.5 5.5V13l-3 1.5v-5L2 4z" />
    </IconBase>
  );
}

/** Sort glyph — three stacked bars descending. */
export function IconSort(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 4h10" />
      <path d="M4 8h8" />
      <path d="M6 12h4" />
    </IconBase>
  );
}

/** Three horizontal lines — list view. */
export function IconList(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M2.5 4h11" />
      <path d="M2.5 8h11" />
      <path d="M2.5 12h11" />
    </IconBase>
  );
}

/** 4-node grid — graph view. */
export function IconGraph(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 4h2v2H4z" />
      <path d="M10 4h2v2h-2z" />
      <path d="M4 10h2v2H4z" />
      <path d="M10 10h2v2h-2z" />
      <path d="M5 6v4M11 6v4M6 5h4M6 11h4" />
    </IconBase>
  );
}

/** Chain link — relations. */
export function IconLink(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M6.5 9.5L9.5 6.5" />
      <path d="M9 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1" />
      <path d="M7 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1" />
    </IconBase>
  );
}

/** Sparkle — agent / AI affordance. */
export function IconSpark(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M8 1.5v4" />
      <path d="M8 10.5v4" />
      <path d="M1.5 8h4" />
      <path d="M10.5 8h4" />
      <path d="M3.5 3.5l2.5 2.5" />
      <path d="M10 10l2.5 2.5" />
      <path d="M3.5 12.5l2.5-2.5" />
      <path d="M10 6l2.5-2.5" />
    </IconBase>
  );
}

/** Gear — settings. */
export function IconSettings(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
      <path d="M13 8a5 5 0 0 0-.1-1l1.1-.85-1-1.7-1.3.5a5 5 0 0 0-1.7-1L9.7 2.5h-2L7.5 4a5 5 0 0 0-1.7 1l-1.3-.5-1 1.7L4.6 7a5 5 0 0 0 0 2l-1.1.85 1 1.7 1.3-.5a5 5 0 0 0 1.7 1l.3 1.5h2l.3-1.5a5 5 0 0 0 1.7-1l1.3.5 1-1.7-1.1-.85a5 5 0 0 0 .1-1z" />
    </IconBase>
  );
}

/** Crescent moon — dark theme. */
export function IconMoon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z" />
    </IconBase>
  );
}

/** Sun rays — light theme. */
export function IconSun(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
      <path d="M8 1.5v1.5" />
      <path d="M8 13v1.5" />
      <path d="M1.5 8h1.5" />
      <path d="M13 8h1.5" />
      <path d="M3 3l1 1" />
      <path d="M12 12l1 1" />
      <path d="M3 13l1-1" />
      <path d="M12 4l1-1" />
    </IconBase>
  );
}

/** Checkmark. */
export function IconCheck(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 8.5L6.5 12 13 5" />
    </IconBase>
  );
}

/** X / close. */
export function IconX(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 4l8 8" />
      <path d="M12 4l-8 8" />
    </IconBase>
  );
}

/** Three horizontal dots — overflow menu. */
export function IconMore(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3.5 8h.01" />
      <path d="M8 8h.01" />
      <path d="M12.5 8h.01" />
    </IconBase>
  );
}

/** Right arrow with line — go to / continue. */
export function IconArrowRight(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </IconBase>
  );
}

/** Single ⌘ command glyph — keyboard cue. */
export function IconCommand(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 11a2 2 0 1 1 2-2v4a2 2 0 1 1-2-2z" />
      <path d="M11 5a2 2 0 1 0-2 2h4a2 2 0 1 0-2-2z" />
    </IconBase>
  );
}

/** Document — files / spec. */
export function IconDoc(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3.5 2h6L13 5v9a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 14V2.5a.5.5 0 0 1 .5-.5z" />
      <path d="M9 2v3h4" />
      <path d="M5.5 8h5" />
      <path d="M5.5 10.5h5" />
      <path d="M5.5 13h3" />
    </IconBase>
  );
}

/** Branch / parent — graph hierarchy. */
export function IconBranch(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 3v10" />
      <path d="M11 5v3a3 3 0 0 1-3 3H5" />
      <circle cx="5" cy="3" r="1.5" />
      <circle cx="5" cy="13" r="1.5" />
      <circle cx="11" cy="5" r="1.5" />
    </IconBase>
  );
}

/** Cube / bundle — context bundle. */
export function IconBundle(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 5l5-2 5 2v6l-5 2-5-2V5z" />
      <path d="M8 8v5" />
      <path d="M3 5l5 3 5-3" />
    </IconBase>
  );
}

/** Padlock. */
export function IconLock(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 7h8v6.5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5V7z" />
      <path d="M5.5 7V5a2.5 2.5 0 1 1 5 0v2" />
    </IconBase>
  );
}

/** Flag — priority / milestone. */
export function IconFlag(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3.5 14V2.5" />
      <path d="M3.5 3h7l-1 2.5 1 2.5h-7" />
    </IconBase>
  );
}

/** Tag — category. */
export function IconTag(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M2.5 8.5l6-6h4v4l-6 6a1 1 0 0 1-1.4 0L2.5 9.9a1 1 0 0 1 0-1.4z" />
      <path d="M10.5 5.5h.01" />
    </IconBase>
  );
}

/** Clock face — duration / last active. */
export function IconClock(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3.5l2 1.5" />
    </IconBase>
  );
}

/** Trash / delete. */
export function IconTrash(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 4h10" />
      <path d="M5 4V2.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5V4" />
      <path d="M4 4l.5 9.5a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1L12 4" />
      <path d="M7 7v5M9 7v5" />
    </IconBase>
  );
}

/** Pencil — inline edit affordance. */
export function IconPencil(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M2.5 13.5v-2L10 4l2 2-7.5 7.5h-2z" />
      <path d="M9 5l2 2" />
    </IconBase>
  );
}

/** Log out / sign out — door + arrow. */
export function IconLogOut(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M6 3H3.5a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5H6" />
      <path d="M9 5l3 3-3 3" />
      <path d="M12 8H6.5" />
    </IconBase>
  );
}

/** Notification bell. */
export function IconBell(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M8 2.5v.5" />
      <path d="M3.5 12V7.5a4.5 4.5 0 0 1 9 0V12" />
      <path d="M2.5 12h11" />
      <path d="M6.5 13.5a1.5 1.5 0 0 0 3 0" />
    </IconBase>
  );
}

/** Undo — left-pointing arrow that curves down, the universal undo glyph. */
export function IconUndo(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 5L2.5 7.5L5 10" />
      <path d="M2.5 7.5h6.5a3.5 3.5 0 0 1 3.5 3.5v1" />
    </IconBase>
  );
}
