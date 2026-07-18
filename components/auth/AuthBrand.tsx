/**
 * Brand stamp shown at the top of every auth surface: a 30×30 transparent
 * piyaz mark paired with a lowercase `piyaz` wordmark. Slightly larger than
 * the sidebar variant (22×22) because the auth surface is a destination, not
 * a chrome accessory. When `href` is set the row is a plain anchor linking
 * out to the marketing site; otherwise it renders as a static row.
 *
 * @param props - Component props.
 * @param props.className - Layout classes appended to the flex row; defaults
 *   to the auth-form margin (`mb-8`).
 * @param props.href - External marketing URL. When set, wraps the row in an
 *   anchor; when omitted, the row is non-interactive.
 * @returns Brand row as an anchor when linked, otherwise a div.
 */
export function AuthBrand({
  className = "mb-8",
  href,
}: {
  className?: string;
  href?: string;
}) {
  const rowClassName = `flex items-center gap-2.5 ${className}`;
  const row = (
    <>
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
    </>
  );

  if (href) {
    return (
      <a href={href} className={rowClassName}>
        {row}
      </a>
    );
  }

  return <div className={rowClassName}>{row}</div>;
}
