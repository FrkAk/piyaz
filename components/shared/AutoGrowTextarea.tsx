"use client";

import { useEffect, useRef } from "react";
import type {
  InputEvent as ReactInputEvent,
  TextareaHTMLAttributes,
} from "react";

type AutoGrowTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

const DEFAULT_MAX_HEIGHT_PX = 256;

/**
 * Textarea that auto-resizes to fit its content. Works with controlled (`value`) and uncontrolled (`defaultValue`) usage.
 * @param props - Standard textarea HTML attributes.
 * @returns A textarea element sized to its content.
 */
export function AutoGrowTextarea({ onInput, ...rest }: AutoGrowTextareaProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const maxHeightRef = useRef<number | null>(null);

  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    if (maxHeightRef.current === null) {
      const cssMax = parseFloat(getComputedStyle(el).maxHeight);
      maxHeightRef.current = Number.isFinite(cssMax)
        ? cssMax
        : DEFAULT_MAX_HEIGHT_PX;
    }
    const cap = maxHeightRef.current;
    const target = Math.min(el.scrollHeight, cap);
    el.style.height = `${target}px`;
    el.style.overflowY = el.scrollHeight > target ? "auto" : "hidden";
  };

  useEffect(() => {
    resize();
  }, []);

  const handleInput = (e: ReactInputEvent<HTMLTextAreaElement>) => {
    resize();
    onInput?.(e);
  };

  return <textarea ref={ref} onInput={handleInput} {...rest} />;
}

export default AutoGrowTextarea;
