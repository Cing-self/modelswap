import type { ReactNode } from 'react';

/** Only provider HTTP(S) URLs may be rendered as a user-clicked login link. */
export function getSafeAutoCreateLoginUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

interface AutoCreateLoginHandoffProps {
  platformLabel: string;
  browserFocused: boolean;
  loginUrl?: string;
  title: ReactNode;
  message: ReactNode;
  openLoginLabel: string;
  retryLabel: string;
  autoCreating: boolean;
  onRetry: () => void;
}

export function AutoCreateLoginHandoff({
  platformLabel,
  browserFocused,
  loginUrl,
  title,
  message,
  openLoginLabel,
  retryLabel,
  autoCreating,
  onRetry,
}: AutoCreateLoginHandoffProps) {
  const safeLoginUrl = getSafeAutoCreateLoginUrl(loginUrl);
  return (
    <div className="vault-auto-create-login" role="alert">
      <strong>{title}: {platformLabel}</strong>
      <p data-browser-focused={browserFocused ? 'true' : 'false'}>{message}</p>
      {safeLoginUrl && (
        <a className="btn-cancel vault-auto-create-login-link" href={safeLoginUrl} target="_blank" rel="noreferrer">
          {openLoginLabel}
        </a>
      )}
      <div className="vault-auto-create-login-actions">
        <button className="btn-save" onClick={onRetry} disabled={autoCreating} type="button">{retryLabel}</button>
      </div>
    </div>
  );
}
