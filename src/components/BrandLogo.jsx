export default function BrandLogo({ className = '' }) {
  return (
    <span className={`brand-logo ${className}`.trim()} role="img" aria-label="Nextra">
      {/* The mark carries the "N" and the brand gradient, so the wordmark art
          only spells the trailing "extra". */}
      <span className="brand-logo-mark" />
      <img
        className="brand-logo-word"
        src="/brand/nextra-wordmark.png"
        alt=""
        draggable="false"
      />
    </span>
  );
}
