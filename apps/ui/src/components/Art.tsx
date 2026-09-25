// jobleft's logo and line illustrations for empty and error states. Drawn for jobleft (simple geometric shapes);
// not traced from any other product.

export function LogoMark({ size = 36, title = 'jobleft' }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title}>
      <rect width="64" height="64" rx="16" fill="#0B0B0B" />
      <circle cx="39" cy="14.5" r="4.5" fill="#00F0A0" />
      <path d="M39 25v15a11 11 0 0 1-11 11h-9" fill="none" stroke="#00F0A0" strokeWidth="7" strokeLinecap="round" />
      <path d="M26 44l-7 7 7 7" fill="none" stroke="#00F0A0" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark({ size = 22 }: { size?: number }) {
  return <span style={{ fontFamily: 'var(--jl-display)', fontWeight: 700, fontSize: size, letterSpacing: '-0.01em' }}>job<span style={{ color: '#047A52' }}>left</span></span>;
}

type ArtKind = 'search' | 'heart' | 'send' | 'link' | 'box' | 'plug' | 'cloud' | 'bell' | 'people' | 'doc' | 'chat' | 'board' | 'hidden';

const MINT = '#00F0A0';

export function Art({ kind, size = 96 }: { kind: ArtKind; size?: number }) {
  const common = { fill: 'none', stroke: '#111', strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  let body;
  switch (kind) {
    case 'search':
      body = (<>
        <rect x="14" y="30" width="46" height="30" rx="6" fill="#F3F4F5" stroke="none" />
        <rect x="20" y="22" width="46" height="30" rx="6" {...common} fill="#fff" />
        <path d="M28 32h20M28 40h12" {...common} />
        <circle cx="66" cy="58" r="12" {...common} fill={MINT} fillOpacity="0.35" />
        <path d="M75 67l9 9" {...common} strokeWidth={3} />
      </>);
      break;
    case 'heart':
      body = (<>
        <rect x="16" y="20" width="64" height="54" rx="10" fill="#F3F4F5" stroke="none" />
        <path d="M48 66s-16-9.5-16-21a8.5 8.5 0 0 1 16-4 8.5 8.5 0 0 1 16 4c0 11.5-16 21-16 21z" {...common} fill={MINT} fillOpacity="0.45" />
      </>);
      break;
    case 'send':
      body = (<>
        <circle cx="48" cy="48" r="32" fill="#F3F4F5" stroke="none" />
        <path d="M22 46l50-20-16 48-10-18z" {...common} fill={MINT} fillOpacity="0.4" />
        <path d="M46 56l26-30" {...common} />
      </>);
      break;
    case 'link':
      body = (<>
        <rect x="18" y="22" width="60" height="52" rx="10" fill="#F3F4F5" stroke="none" />
        <path d="M44 52l8-8" {...common} />
        <path d="M40 46l-6 6a7 7 0 0 0 10 10l6-6" {...common} />
        <path d="M56 50l6-6a7 7 0 0 0-10-10l-6 6" fill="none" stroke={MINT} strokeWidth={3} strokeLinecap="round" />
      </>);
      break;
    case 'plug':
      body = (<>
        <circle cx="48" cy="48" r="32" fill="#FDECEE" stroke="none" />
        <path d="M30 40h14v16H30zM44 44h6M44 52h6M30 48h-8" {...common} />
        <path d="M66 40H56v16h10M56 48h-4M66 48h8" {...common} />
      </>);
      break;
    case 'cloud':
      body = (<>
        <path d="M30 64h38a12 12 0 0 0 0-24 18 18 0 0 0-34-4 14 14 0 0 0-4 28z" {...common} fill="#F3F4F5" />
        <path d="M26 28l44 44" {...common} />
      </>);
      break;
    case 'bell':
      body = (<>
        <circle cx="48" cy="48" r="32" fill="#F3F4F5" stroke="none" />
        <path d="M34 58V46a14 14 0 1 1 28 0v12l4 5H30z" {...common} fill={MINT} fillOpacity="0.35" />
        <path d="M44 67a4 4 0 0 0 8 0" {...common} />
      </>);
      break;
    case 'people':
      body = (<>
        <circle cx="48" cy="48" r="32" fill="#F3F4F5" stroke="none" />
        <circle cx="40" cy="42" r="7" {...common} />
        <path d="M27 64a13 13 0 0 1 26 0" {...common} />
        <circle cx="60" cy="44" r="5.5" {...common} fill={MINT} fillOpacity="0.5" />
        <path d="M56 55a10 10 0 0 1 14 9" {...common} />
      </>);
      break;
    case 'doc':
      body = (<>
        <rect x="26" y="16" width="44" height="60" rx="6" {...common} fill="#fff" />
        <path d="M34 30h28M34 38h28M34 46h18" {...common} />
        <circle cx="66" cy="66" r="11" {...common} fill={MINT} />
        <path d="M66 71v-10M61.5 65.5L66 61l4.5 4.5" {...common} />
      </>);
      break;
    case 'chat':
      body = (<>
        <path d="M20 26h38a6 6 0 0 1 6 6v18a6 6 0 0 1-6 6H36l-10 8v-8h-6a6 6 0 0 1-6-6V32a6 6 0 0 1 6-6z" {...common} fill="#F3F4F5" />
        <path d="M58 44h12a6 6 0 0 1 6 6v12a6 6 0 0 1-6 6h-2v6l-8-6H52" {...common} fill={MINT} fillOpacity="0.35" />
      </>);
      break;
    case 'board':
      body = (<>
        <rect x="16" y="22" width="64" height="52" rx="8" fill="#F3F4F5" stroke="none" />
        <rect x="22" y="30" width="14" height="10" rx="2" {...common} fill="#fff" />
        <rect x="41" y="30" width="14" height="18" rx="2" {...common} fill={MINT} fillOpacity="0.4" />
        <rect x="60" y="30" width="14" height="10" rx="2" {...common} fill="#fff" />
      </>);
      break;
    case 'hidden':
      body = (<>
        <circle cx="48" cy="48" r="32" fill="#F3F4F5" stroke="none" />
        <path d="M24 48s9-14 24-14 24 14 24 14-9 14-24 14-24-14-24-14z" {...common} />
        <circle cx="48" cy="48" r="6" {...common} fill={MINT} />
        <path d="M28 70l40-44" {...common} />
      </>);
      break;
    default:
      body = (<>
        <rect x="22" y="34" width="52" height="36" rx="6" {...common} fill="#F3F4F5" />
        <path d="M22 44h52M40 54h16" {...common} />
      </>);
  }
  return <svg width={size} height={size} viewBox="0 0 96 96" aria-hidden="true" focusable="false">{body}</svg>;
}
