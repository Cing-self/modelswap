import { useState, useEffect } from 'react';
import { importProviderCode } from '../../api/providers';
import { useApp } from '../Layout/AppContext';
import { useI18n } from '../../i18n';

interface Props {
  code: string;
  onClose: () => void;
  onImported?: () => void;
}

export default function ProviderImportModal({ code, onClose, onImported }: Props) {
  const { showToast } = useApp();
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleImport() {
    setLoading(true);
    try {
      const result = await importProviderCode(code, password || undefined);
      showToast(
        result.created
          ? t('models.importCreated', { name: result.provider.name })
          : t('models.importUpdated', { name: result.provider.name }),
        'success',
      );
      onImported?.();
      onClose();
    } catch (err: any) {
      showToast(err.message || t('models.importFailed'), 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-overlay" style={{ display: '' }}>
      <div className="preset-panel" style={{ maxWidth: 480 }}>
        <div className="progress-header">
          <span className="progress-title">{t('models.importTitle')}</span>
          <button className="progress-close" onClick={onClose} aria-label={t('common.close')}>&times;</button>
        </div>
        <div className="preset-body">
          <p style={{ fontSize: 13, color: 'var(--ink-muted)', marginBottom: 16 }}>
            {t('models.importDescription')}
          </p>
          <div className="settings-field" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <label style={{ minWidth: 'auto', fontSize: 13, fontWeight: 600 }}>{t('models.importPassword')}</label>
            <input
              type="password"
              className="settings-input"
              style={{ width: '100%' }}
              placeholder={t('models.importPasswordPlaceholder')}
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button className="btn-outline" onClick={onClose} style={{ flex: 1 }}>{t('common.cancel')}</button>
            <button className="btn-primary" onClick={handleImport} disabled={loading} style={{ flex: 1 }}>
              {loading ? t('models.importing') : t('common.import')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
