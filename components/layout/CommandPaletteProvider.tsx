"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CommandPalette } from "@/components/shared/CommandPalette";
import type { SidebarProject } from "@/components/layout/Sidebar";

/** Shape exposed to consumers of {@link useCommandPalette}. */
interface CommandPaletteValue {
  /** Whether the palette is currently open. */
  open: boolean;
  /** Open the palette (idempotent). */
  openPalette: () => void;
  /** Close the palette (idempotent). */
  closePalette: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteValue | null>(null);

interface CommandPaletteProviderProps {
  /** Project list already loaded by AppShell (avoids a redundant fetch). */
  projects: SidebarProject[];
  /** Subtree that gets access to {@link useCommandPalette}. */
  children: ReactNode;
}

/**
 * Owns the global ⌘K / Ctrl+K command palette state and the single document
 * keydown listener that toggles the palette. Skips the shortcut when an
 * input, textarea, or contenteditable element is focused so the palette
 * never steals ⌘K from a text field. Mounted by AppShell so every
 * authenticated route can call {@link useCommandPalette}.
 *
 * @param props - Project list + subtree.
 * @returns Context provider rendering its children plus a single
 *   `<CommandPalette>` mount.
 */
export function CommandPaletteProvider({
  projects,
  children,
}: CommandPaletteProviderProps) {
  const [open, setOpen] = useState(false);
  const openPalette = useCallback(() => setOpen(true), []);
  const closePalette = useCallback(() => setOpen(false), []);

  /** Mirrors `open` so the keydown listener reads the current value
   *  without re-binding on every toggle. */
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // `e.code` is keyboard-layout independent — non-Latin layouts produce
      // a different `e.key` for the physical K.
      const isModK = (e.metaKey || e.ctrlKey) && e.code === "KeyK";
      if (!isModK) return;

      // Close-when-open must short-circuit the input-skip; the palette
      // input owns focus while open.
      if (openRef.current) {
        e.preventDefault();
        setOpen(false);
        return;
      }

      // Closed: skip when an editable element is focused.
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || active?.isContentEditable) {
        return;
      }
      e.preventDefault();
      setOpen(true);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <CommandPaletteContext value={{ open, openPalette, closePalette }}>
      {children}
      <CommandPalette open={open} onClose={closePalette} projects={projects} />
    </CommandPaletteContext>
  );
}

/**
 * Read the palette state from anywhere under {@link CommandPaletteProvider}.
 * Returns a no-op fallback when called outside the provider so unauth
 * routes (sign-in, sign-up) that don't mount AppShell don't crash if the
 * hook is referenced.
 *
 * @returns Open state + open/close callbacks.
 */
export function useCommandPalette(): CommandPaletteValue {
  const ctx = useContext(CommandPaletteContext);
  if (ctx) return ctx;
  return {
    open: false,
    openPalette: () => {},
    closePalette: () => {},
  };
}
