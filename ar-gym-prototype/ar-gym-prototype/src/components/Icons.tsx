/**
 * Simple line icons (inline SVG, no icon library). Icons are always shown
 * next to a text label, never alone.
 */
import type { ReactNode } from 'react';

function Svg({ children, size = 22, fill = 'none' }: { children: ReactNode; size?: number; fill?: string }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

type P = { size?: number };

export const IconThumbUp = (p: P) => (
  <Svg {...p}>
    <path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3zm0 0 4-8a2.5 2.5 0 0 1 2.5 2.5V9h5.2a2 2 0 0 1 2 2.4l-1.3 7a2 2 0 0 1-2 1.6H7" />
  </Svg>
);
export const IconThumbDown = (p: P) => (
  <Svg {...p}>
    <path d="M17 13V4h3a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-3zm0 0-4 8a2.5 2.5 0 0 1-2.5-2.5V15H5.3a2 2 0 0 1-2-2.4l1.3-7A2 2 0 0 1 6.6 4H17" />
  </Svg>
);
export const IconHeart = (p: P) => (
  <Svg {...p}>
    <path d="M12 20s-7-4.4-9.2-8.8A5 5 0 0 1 12 6.5a5 5 0 0 1 9.2 4.7C19 15.6 12 20 12 20z" />
  </Svg>
);
export const IconText = (p: P) => (
  <Svg {...p}>
    <path d="M4 5h16v11H9l-5 4z" />
    <path d="M8 9h8M8 12.5h5" />
  </Svg>
);
export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const IconPlay = (p: P) => (
  <Svg {...p}>
    <path d="M7 4.5v15l12-7.5z" />
  </Svg>
);
export const IconPause = (p: P) => (
  <Svg {...p}>
    <path d="M8 5v14M16 5v14" />
  </Svg>
);
export const IconRewind = (p: P) => (
  <Svg {...p}>
    <path d="M4 12a8 8 0 1 0 2.5-5.8" />
    <path d="M4 4v5h5" />
  </Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
);
export const IconWarning = (p: P) => (
  <Svg {...p}>
    <path d="M12 4 2.5 20h19z" />
    <path d="M12 10v4.5M12 17.3v.2" />
  </Svg>
);
export const IconVerified = (p: P) => (
  <Svg {...p}>
    <path d="M12 3l2.3 1.8 2.9-.1.9 2.8 2.4 1.7-1 2.8 1 2.8-2.4 1.7-.9 2.8-2.9-.1L12 21l-2.3-1.8-2.9.1-.9-2.8-2.4-1.7 1-2.8-1-2.8 2.4-1.7.9-2.8 2.9.1z" />
    <path d="M8.5 12.2l2.4 2.4 4.6-4.8" />
  </Svg>
);
export const IconArrow = (p: P) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);
export const IconBack = (p: P) => (
  <Svg {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Svg>
);
export const IconClock = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);
export const IconChevron = (p: P) => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);
export const IconMic = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
  </Svg>
);
export const IconStop = (p: P) => (
  <Svg {...p}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
  </Svg>
);
export const IconSound = (p: P) => (
  <Svg {...p}>
    <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
  </Svg>
);
export const IconCamera = (p: P) => (
  <Svg {...p}>
    <path d="M4 8h3l1.5-2h7L17 8h3v11H4z" />
    <circle cx="12" cy="13.2" r="3" />
  </Svg>
);
export const IconPhoneTurn = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="12" width="14" height="8" rx="1.8" />
    <path d="M13 3.5a7 7 0 0 1 7 7M20 6.5v4h-4" />
  </Svg>
);
export const IconPin = (p: P) => (
  <Svg {...p}>
    <path d="M12 21s6.5-5.6 6.5-10.5a6.5 6.5 0 0 0-13 0C5.5 15.4 12 21 12 21z" />
    <circle cx="12" cy="10.5" r="2.3" />
  </Svg>
);

/** The bread icon: the mark of the Breadcrumbs button and of the Loaf badge (a trusted contributor). */
export function IconLoaf({ size = 22 }: { size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 14c0-4 3.8-6.5 8.5-6.5s8.5 2.5 8.5 6.5v2.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" fill="#f2c178" />
      <path d="M8.5 10v3.5M12 9.5v4M15.5 10v3.5" stroke="#a8743a" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}
