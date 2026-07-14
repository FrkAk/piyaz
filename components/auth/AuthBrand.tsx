/**
 * Brand stamp shown at the top of every auth form: a 30×30 transparent piyaz
 * mark paired with a lowercase `piyaz` wordmark. Slightly larger than the
 * sidebar variant (22×22) because the auth surface is a destination, not
 * a chrome accessory.
 *
 * @param props - Optional layout classes appended to the flex row;
 *   defaults to the auth-form margin (`mb-8`).
 * @returns Inline-flex brand row.
 */
export function AuthBrand({ className = "mb-8" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- brand mark is a 30px static asset; next/image optimization is overkill and unconfigured on the Cloudflare build */}
      <img
        src="/piyaz-mark.png"
        alt=""
        aria-hidden="true"
        width={30}
        height={30}
        className="h-[30px] w-[30px] object-contain"
      />
      <span
        className="text-[16px] font-semibold text-text-primary"
        style={{ letterSpacing: "-0.005em" }}
      >
        piyaz
      </span>
    </div>
  );
}
