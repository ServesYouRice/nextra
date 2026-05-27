export default function BrandLogo({ className = '' }) {
  return (
    <span className={`brand-logo ${className}`.trim()} aria-label="Nextra">
      <img
        className="brand-logo-mark-image"
        src="/brand/nextra-mark.png"
        alt=""
        aria-hidden="true"
        draggable="false"
      />
      <span className="brand-logo-copy" aria-hidden="true">
        <span className="brand-logo-word">
          <span className="brand-e-mark">
            <span />
            <span />
            <span />
          </span>
          <svg
            className="brand-x-mark"
            viewBox="0 0 56 52"
            aria-hidden="true"
            focusable="false"
          >
            <path className="brand-x-accent" d="M8 7L24 22.5" />
            <path className="brand-x-accent" d="M8 45L24 29.5" />
            <path className="brand-x-light" d="M32 22.5L48 7" />
            <path className="brand-x-light" d="M32 29.5L48 45" />
          </svg>
          <img
            className="brand-logo-tra-image"
            src="/brand/nextra-tra.png"
            alt=""
            draggable="false"
          />
        </span>
      </span>
    </span>
  );
}
