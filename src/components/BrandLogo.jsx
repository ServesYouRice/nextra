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
      {/* The mark carries the brand gradient on its own; the wordmark stays a
          single uniform stroke so "ex" reads the same as "tra". */}
      <svg
        className="brand-logo-word"
        viewBox="0 0 308 120"
        aria-hidden="true"
        focusable="false"
      >
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="13"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M53.8 74.9 A26 26 0 1 1 58.5 60 H6.5" />
          <path d="M84 34 L126 86" />
          <path d="M126 34 L84 86" />
          <path d="M164 14 V70 A16 16 0 0 0 180 86 M151 34 H179" />
          <path d="M207 34 V86 M207 50 A16 16 0 0 1 223 34" />
          <circle cx="275" cy="60" r="26" />
          <path d="M301 34 V86" />
        </g>
      </svg>
    </span>
  );
}
