import React from "react";

// Four-tile brand mark (same artwork as assets/branding/logo/mark.svg).
// Orange tiles stay fixed; the neutral tiles follow currentColor so the mark works in every theme.
export default function BrandMark({ size = 24, className, title = "Local AI Studio" }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={title}>
      <path fill="#ff6a3d" d="M24.12 0H44.39A3.86 3.86 0 0 1 48.25 3.86V24.12A24.12 24.12 0 0 1 24.12 48.25H3.86A3.86 3.86 0 0 1 0 44.39V24.12A24.12 24.12 0 0 1 24.12 0ZM75.88 51.75H96.14A3.86 3.86 0 0 1 100 55.61V75.88A24.12 24.12 0 0 1 75.88 100H55.61A3.86 3.86 0 0 1 51.75 96.14V75.88A24.12 24.12 0 0 1 75.88 51.75Z" />
      <path fill="currentColor" d="M55.61 0H75.88A24.12 24.12 0 0 1 100 24.12V44.39A3.86 3.86 0 0 1 96.14 48.25H75.88A24.12 24.12 0 0 1 51.75 24.12V3.86A3.86 3.86 0 0 1 55.61 0ZM3.86 51.75H24.12A24.12 24.12 0 0 1 48.25 75.88V96.14A3.86 3.86 0 0 1 44.39 100H24.12A24.12 24.12 0 0 1 0 75.88V55.61A3.86 3.86 0 0 1 3.86 51.75Z" />
    </svg>
  );
}
