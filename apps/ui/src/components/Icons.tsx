// jobleft's own line icons (24 px grid, 1.7 px stroke, round caps). Drawn for jobleft; not traced from any product.

import type { ReactNode, SVGProps } from 'react';

function Svg({ children, size = 22, ...rest }: SVGProps<SVGSVGElement> & { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export const IconJobs = (p: { size?: number }) => (
  <Svg {...p}><rect x="3" y="7" width="18" height="13" rx="2.5" /><path d="M9 7V5.6A1.6 1.6 0 0 1 10.6 4h2.8A1.6 1.6 0 0 1 15 5.6V7" /><path d="M3 12.5h18" /><path d="M11 12.5v1.5h2v-1.5" /></Svg>
);
export const IconTracker = (p: { size?: number }) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16M15 4v16" /><path d="M5.5 8h1.5M11.5 8h1.5M17.5 8h1M5.5 11.5h1.5M11.5 11.5h1.5" /></Svg>
);
export const IconDashboard = (p: { size?: number }) => (
  <Svg {...p}><path d="M3 20.5h18" /><path d="M6 17.5v-6M11 17.5V6M16 17.5v-9M20 17.5v-4" /></Svg>
);
export const IconResume = (p: { size?: number }) => (
  <Svg {...p}><path d="M6 3h8.5L19 7.5V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14 3v5h5" /><path d="M8.5 12.5h7M8.5 16h5" /></Svg>
);
export const IconProfile = (p: { size?: number }) => (
  <Svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 20.5a8 8 0 0 1 16 0" /></Svg>
);
export const IconNetwork = (p: { size?: number }) => (
  <Svg {...p}><circle cx="9" cy="8.5" r="3.4" /><path d="M2.8 20a6.3 6.3 0 0 1 12.4 0" /><circle cx="17.2" cy="9.5" r="2.5" /><path d="M16.2 14.3a5 5 0 0 1 5.3 5.2" /></Svg>
);
export const IconInterview = (p: { size?: number }) => (
  <Svg {...p}><path d="M4 4.5h10a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9l-3.5 3v-3H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2z" /><path d="M18 9h1a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-1v3l-3.5-3H11" /><path d="M7.6 7.4a1.5 1.5 0 1 1 2 1.4c-.4.2-.6.5-.6.9" /><path d="M9 11.2v.1" /></Svg>
);
export const IconAssistant = (p: { size?: number }) => (
  <Svg {...p}><path d="M11 3.5l1.7 4.8L17.5 10l-4.8 1.7L11 16.5l-1.7-4.8L4.5 10l4.8-1.7z" /><path d="M18 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" /></Svg>
);
export const IconBell = (p: { size?: number }) => (
  <Svg {...p}><path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></Svg>
);
export const IconSettings = (p: { size?: number }) => (
  <Svg {...p}><path d="M4 6.5h9M18 6.5h2M4 12h3M11 12h9M4 17.5h11M19 17.5h1" /><circle cx="15.5" cy="6.5" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="17" cy="17.5" r="2" /></Svg>
);
export const IconSparkle = (p: { size?: number }) => (
  <Svg {...p}><path d="M12 3l2 5.6 5.6 2-5.6 2L12 18.2l-2-5.6-5.6-2 5.6-2z" /></Svg>
);
