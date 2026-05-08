'use client';

import { useId, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useModalChrome } from '@/hooks/useModalChrome';

interface ModalProps {
  /** @param open - Whether the modal is visible. */
  open: boolean;
  /** @param onClose - Called on backdrop click, Escape, or close button. */
  onClose: () => void;
  /** @param title - Text for the header title (also used as aria-labelledby target). */
  title: string;
  /** @param children - Body content rendered inside the padded panel. */
  children: React.ReactNode;
  /** @param maxWidth - Responsive max-width tier. Defaults to 'md'. */
  maxWidth?: 'sm' | 'md' | 'lg';
}

const MAX_WIDTH_CLASS: Record<NonNullable<ModalProps['maxWidth']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
};

/**
 * Base modal primitive — backdrop, centered panel, escape + click-outside + close button.
 * @param props - Modal configuration.
 * @returns Portal-less floating dialog with motion entrance and focus restore.
 */
export function Modal({ open, onClose, title, children, maxWidth = 'md' }: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  useModalChrome(open, onClose, panelRef);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="backdrop"
          className="fixed inset-0 z-[60] flex items-center justify-center bg-base/70 backdrop-blur-sm px-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <motion.div
            key="panel"
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.25, 0.46, 0.45, 0.94] }}
            className={`relative flex max-h-[calc(100vh-2rem)] w-full flex-col ${MAX_WIDTH_CLASS[maxWidth]} rounded-[10px] border border-border bg-surface shadow-[var(--shadow-float)]`}
          >
            <header className="flex flex-shrink-0 items-center justify-between border-b border-border px-5 py-3">
              <h2 id={titleId} className="text-sm font-semibold text-text-primary">
                {title}
              </h2>
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="cursor-pointer rounded-md p-1 text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
                  <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
                </svg>
              </motion.button>
            </header>
            <div className="overflow-y-auto p-5">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default Modal;
