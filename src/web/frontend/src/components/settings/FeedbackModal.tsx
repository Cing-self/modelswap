import React, { useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, Loader2, MessageSquareWarning, Sparkles, X } from 'lucide-react';
import { useI18n } from '../../i18n';
import { useApp } from '../Layout/AppContext';

// The docs worker creates the GitHub issue server-side, so users never need
// a GitHub account; the prefill URL is only the offline fallback.
const FEEDBACK_ENDPOINT = 'https://docs.modelswap.app/api/feedback';
const FEEDBACK_ISSUE_URL = 'https://github.com/Cing-self/modelswap/issues/new';

type Props = {
  open: boolean;
  onClose: () => void;
  buildDiagnostics: () => Promise<string>;
};

export default function FeedbackModal({ open, onClose, buildDiagnostics }: Props) {
  const { showToast } = useApp() as any;
  const { t } = useI18n();
  const [kind, setKind] = useState<'bug' | 'feature'>('bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [attach, setAttach] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [issueUrl, setIssueUrl] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Every open is a fresh start: blank form, no leftover text or status.
  useEffect(() => {
    if (open) {
      setKind('bug');
      setTitle('');
      setDescription('');
      setAttach(true);
      setIssueUrl(null);
      setSubmitError(null);
      setSubmitting(false);
    }
  }, [open]);

  if (!open) return null;

  async function composeDraft() {
    const lines = [
      `[${kind === 'bug' ? t('settings.feedbackKindBug') : t('settings.feedbackKindFeature')}] ${title.trim()}`,
      '',
      description.trim(),
    ];
    if (kind === 'bug' && attach) {
      lines.push('', '---', `${t('settings.diagnostics')}:`, await buildDiagnostics());
    }
    return { title: lines[0], body: lines.slice(1).join('\n') };
  }

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const draft = await composeDraft();
      const response = await fetch(FEEDBACK_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, title: title.trim(), body: draft.body }),
      });
      const data = response.ok ? await response.json().catch(() => null) : null;
      if (!response.ok || !data?.url) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }
      setIssueUrl(data.url);
      showToast(t('settings.feedbackSuccessToast'), 'success');
    } catch (error: any) {
      setSubmitError(error?.message || t('settings.feedbackFailTitle'));
    } finally {
      setSubmitting(false);
    }
  }

  function fallbackUrl() {
    const draftTitle = `[${kind === 'bug' ? t('settings.feedbackKindBug') : t('settings.feedbackKindFeature')}] ${title.trim()}`;
    return `${FEEDBACK_ISSUE_URL}?title=${encodeURIComponent(draftTitle)}`;
  }

  const canSubmit = title.trim().length > 0 && description.trim().length > 0 && !submitting;

  return (
    <div className="auth-overlay" style={{ display: '' }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="confirm-panel feedback-modal" role="dialog" aria-modal="true" aria-labelledby="feedback-modal-title" aria-describedby="feedback-modal-desc">
        <header className="lan-modal-header">
          <span className="lan-modal-header-icon"><MessageSquareWarning size={18} /></span>
          <div>
            <h3 id="feedback-modal-title">{t('settings.feedbackModalTitle')}</h3>
            <p id="feedback-modal-desc">{t('settings.feedbackModalDesc')}</p>
          </div>
          <button className="lan-modal-close" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
            <X size={17} />
          </button>
        </header>

        {issueUrl ? (
          <div className="lan-modal-body feedback-modal-success">
            <div className="feedback-success-card">
              <span className="feedback-success-icon"><CheckCircle2 size={20} /></span>
              <div className="feedback-success-copy">
                <strong>{t('settings.feedbackSuccessTitle')}</strong>
                <p>{t('settings.feedbackSuccessDesc')}</p>
              </div>
            </div>
            <div className="feedback-success-footer">
              <button type="button" className="lan-primary-action" onClick={() => setIssueUrl(null)}>
                {t('settings.feedbackDone')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="lan-modal-body feedback-modal-body">
              <div className="feedback-kind-grid" role="group" aria-label={t('settings.feedbackKind')}>
                <button
                  type="button"
                  className={`feedback-kind${kind === 'bug' ? ' active' : ''}`}
                  onClick={() => setKind('bug')}
                  aria-pressed={kind === 'bug'}
                >
                  <span className="feedback-kind-icon"><CircleAlert size={17} /></span>
                  <span className="feedback-kind-copy">
                    <strong>{t('settings.feedbackKindBug')}</strong>
                    <small>{t('settings.feedbackKindBugDesc')}</small>
                  </span>
                  <CheckCircle2 className="feedback-kind-check" size={15} />
                </button>
                <button
                  type="button"
                  className={`feedback-kind${kind === 'feature' ? ' active' : ''}`}
                  onClick={() => setKind('feature')}
                  aria-pressed={kind === 'feature'}
                >
                  <span className="feedback-kind-icon"><Sparkles size={17} /></span>
                  <span className="feedback-kind-copy">
                    <strong>{t('settings.feedbackKindFeature')}</strong>
                    <small>{t('settings.feedbackKindFeatureDesc')}</small>
                  </span>
                  <CheckCircle2 className="feedback-kind-check" size={15} />
                </button>
              </div>

              <div className="feedback-field">
                <label className="feedback-field-label" htmlFor="feedback-title">{t('settings.feedbackTitleLabel')}</label>
                <input
                  id="feedback-title"
                  type="text"
                  className="settings-input"
                  placeholder={t('settings.feedbackTitlePlaceholder')}
                  value={title}
                  maxLength={140}
                  onChange={e => setTitle(e.target.value)}
                />
              </div>

              <div className="feedback-field">
                <label className="feedback-field-label" htmlFor="feedback-desc">{t('settings.feedbackDescLabel')}</label>
                <textarea
                  id="feedback-desc"
                  className="settings-input feedback-modal-textarea"
                  placeholder={t('settings.feedbackDescPlaceholder')}
                  value={description}
                  rows={6}
                  onChange={e => setDescription(e.target.value)}
                />
              </div>

              {/* Diagnostics contextualize bug reports only — feature
                  requests carry no environment data. */}
              {kind === 'bug' && (
                <label className="feedback-attach">
                  <input type="checkbox" checked={attach} onChange={e => setAttach(e.target.checked)} />
                  <span>{t('settings.feedbackAttach')}</span>
                </label>
              )}
            </div>
            {submitError && (
              <div className="feedback-submit-error" role="alert">
                <CircleAlert size={14} />
                <span>{t('settings.feedbackFailTitle')}</span>
                <a href={fallbackUrl()} target="_blank" rel="noreferrer">{t('settings.feedbackFallback')}</a>
              </div>
            )}
            <div className="feedback-modal-actions">
              <span className="feedback-modal-hint">
                {kind === 'bug' ? t('settings.feedbackPrivacyHint') : t('settings.feedbackPrivacyHintPlain')}
              </span>
              <button className="lan-primary-action" onClick={submit} disabled={!canSubmit}>
                {submitting ? <Loader2 className="spin" size={14} /> : null}
                {submitting ? t('settings.feedbackSubmitting') : t('settings.feedbackSubmit')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
