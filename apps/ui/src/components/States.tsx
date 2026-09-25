// Loading, empty and error states. They look different from each other, every empty state says what to do next,
// every error says what failed in plain words and offers a retry, and no loader spins without words for long.

import { Component, useEffect, useState, type ReactNode } from 'react';
import { Button, Spin } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { UiError } from '../app/api.ts';
import { openExternal } from '../app/api.ts';
import { Art } from './Art.tsx';

export function Loading({ label = 'Loading', onRetry, inline = false }: { label?: string; onRetry?: () => void; inline?: boolean }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSlow(true), 12000); return () => clearTimeout(t); }, []);
  return (
    <div role="status" aria-live="polite" className={inline ? 'jl-row' : 'jl-state'} style={inline ? { padding: 12 } : { boxShadow: 'none', background: 'transparent' }}>
      <Spin size={inline ? 'small' : 'default'} />
      <span className="jl-muted">{slow ? 'This is taking longer than usual.' : `${label}…`}</span>
      {slow && onRetry && <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function SkeletonCards({ n = 3 }: { n?: number }) {
  return (
    <div role="status" aria-label="Loading jobs" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {Array.from({ length: n }, (_, i) => (
        <div className="jl-skel" key={i} aria-hidden="true">
          <div className="blk" style={{ width: 72, height: 72 }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="blk" style={{ width: '45%', height: 18 }} />
            <div className="blk" style={{ width: '30%', height: 14 }} />
            <div className="blk" style={{ width: '80%', height: 14, marginTop: 16 }} />
            <div className="blk" style={{ width: '70%', height: 14 }} />
          </div>
          <div className="blk" style={{ width: 164, height: 200 }} />
        </div>
      ))}
      <span className="jl-sr">Loading</span>
    </div>
  );
}

export function EmptyState({ art = 'box', title, text, action }: { art?: Parameters<typeof Art>[0]['kind']; title: string; text?: ReactNode; action?: ReactNode }) {
  return (
    <section className="jl-state" aria-label={title}>
      <Art kind={art} />
      <h2>{title}</h2>
      {text && <p>{text}</p>}
      {action}
    </section>
  );
}

export function ErrorState({ error, onRetry, title }: { error: UiError | null; onRetry?: () => void; title?: string }) {
  const offline = error?.code === 'unreachable' || error?.code === 'offline';
  return (
    <section className="jl-state error" role="alert">
      <Art kind={offline ? 'cloud' : 'plug'} />
      <h2>{title ?? (offline ? 'Not connected' : 'This could not load')}</h2>
      <p>{error?.message ?? 'Something went wrong. Try again.'}</p>
      <div className="jl-row">
        {onRetry && <Button type="primary" shape="round" icon={<ReloadOutlined />} onClick={onRetry}>Try again</Button>}
        {error?.link && <Button shape="round" onClick={() => openExternal(error.link!.url)}>{error.link.label}</Button>}
      </div>
    </section>
  );
}

/** An inline error line for panels and forms. */
export function InlineError({ error, onRetry }: { error: UiError | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div role="alert" className="jl-row jl-wrap" style={{ background: 'var(--jl-error-tint)', color: '#6E1016', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
      <span className="jl-grow">{error.message}</span>
      {error.link && <Button size="small" onClick={() => openExternal(error.link!.url)}>{error.link.label}</Button>}
      {onRetry && <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>Try again</Button>}
    </div>
  );
}

interface BoundaryState { failed: boolean }

/** Catches a crash inside one panel or screen and shows a plain message instead of a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string; resetKey?: string }, BoundaryState> {
  override state: BoundaryState = { failed: false };
  static getDerivedStateFromError(): BoundaryState { return { failed: true }; }
  override componentDidUpdate(prev: { resetKey?: string }): void {
    if (prev.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false });
  }
  override componentDidCatch(): void { /* no crash reporter: nothing leaves this computer */ }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="jl-state error" role="alert">
        <Art kind="plug" />
        <h2>{this.props.label ?? 'This part of jobleft stopped working'}</h2>
        <p>The rest of the app still works. Your data is safe.</p>
        <Button type="primary" shape="round" icon={<ReloadOutlined />} onClick={() => this.setState({ failed: false })}>Try again</Button>
      </section>
    );
  }
}
