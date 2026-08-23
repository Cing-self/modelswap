import { useState, useEffect, useMemo, useRef } from 'react';
import { api } from '../../api/client';
import { setVault } from '../../api/vault';
import { useI18n } from '../../i18n';
import CustomSelect from './CustomSelect';
import { normalizeGroupName } from '../../data/vault-groups';
import { sortGroupEntries } from '../../lib/groupOrdering';

interface TestEndpoint {
  baseUrl: string;
  type: string;
  protocol?: string;
}

interface VaultPickerModalProps {
  selected?: string;
  onSelect: (key: string) => void;
  onClose: () => void;
  testEndpoint?: TestEndpoint;
}

export default function VaultPickerModal({ selected, onSelect, onClose, testEndpoint }: VaultPickerModalProps) {
  const { t } = useI18n();
  const [secrets, setSecrets] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newGroup, setNewGroup] = useState('');
  const [newGroupCustom, setNewGroupCustom] = useState('');
  const [newValue, setNewValue] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  function reload() {
    api('/api/vault').then((data: any) => {
      setSecrets((data.secrets || []).map((secret: any) => ({
        ...secret,
        group: normalizeGroupName(secret.group),
      })));
    }).catch(() => {});
  }

  useEffect(() => { reload(); }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') || []);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const groups = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const s of secrets) {
      const g = s.group || t('common.ungrouped');
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(s);
    }
    return sortGroupEntries(Array.from(map.entries()), t('common.ungrouped'));
  }, [secrets, t]);

  const groupNames = useMemo(() => groups.map(([g]) => g).filter(g => g !== t('common.ungrouped')), [groups, t]);

  const filtered = useMemo(() => {
    const source = activeGroup ? (groups.find(([g]) => g === activeGroup)?.[1] || []) : secrets;
    if (!search.trim()) return source;
    const q = search.toLowerCase();
    return source.filter(s =>
      s.key.toLowerCase().includes(q) ||
      (s.desc || '').toLowerCase().includes(q) ||
      (s.group || '').toLowerCase().includes(q)
    );
  }, [secrets, groups, activeGroup, search]);

  async function handleCreate() {
    if (!newKey.trim() || !newValue.trim()) return;
    setCreating(true);
    try {
      const group = newGroup === '__custom__' ? newGroupCustom.trim() : newGroup.trim();
      await setVault({
        key: newKey.trim(),
        value: newValue.trim(),
        desc: newDesc.trim() || undefined,
        group: group || undefined,
      });
      await new Promise(r => setTimeout(r, 100));
      reload();
      onSelect(newKey.trim());
      resetCreate();
    } catch {}
    setCreating(false);
  }

  async function handleTest() {
    if (!newValue.trim() || !testEndpoint) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api('/api/vault/test-key', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: testEndpoint.baseUrl, type: testEndpoint.type, protocol: testEndpoint.protocol, keyValue: newValue.trim() }),
      }) as any;
      setTestResult({ success: res.success, message: res.message });
    } catch (err: any) {
      setTestResult({ success: false, message: err.message || String(err) || 'Test failed' });
    }
    setTesting(false);
  }

  function resetCreate() {
    setShowCreate(false);
    setNewKey('');
    setNewDesc('');
    setNewGroup('');
    setNewGroupCustom('');
    setNewValue('');
    setShowValue(false);
    setTestResult(null);
  }

  return (
    <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panelRef} className={`vault-picker${showCreate ? ' vault-picker--creating' : ''}`} role="dialog" aria-modal="true" aria-labelledby="vault-picker-title">
        <div className="vault-picker-header">
          <h2 id="vault-picker-title">{t('vaultPicker.title')}</h2>
          <button type="button" className="vault-picker-close" onClick={onClose} aria-label={t('common.close')}>×</button>
        </div>
        <div className="vault-picker-body">
          <aside className="vault-picker-sidebar">
            <button
              type="button"
              className={`vault-picker-group${!activeGroup ? ' active' : ''}`}
              onClick={() => setActiveGroup(null)}
              aria-pressed={!activeGroup}
            >
              <span>{t('common.all')}</span>
              <span className="vault-picker-group-count">{secrets.length}</span>
            </button>
            {groups.map(([g, items]) => (
              <button
                type="button"
                key={g}
                className={`vault-picker-group${activeGroup === g ? ' active' : ''}`}
                onClick={() => setActiveGroup(g)}
                aria-pressed={activeGroup === g}
              >
                <span>{g}</span>
                <span className="vault-picker-group-count">{items.length}</span>
              </button>
            ))}
          </aside>
          <div className="vault-picker-main">
            <div className="vault-picker-search">
              <div className="vault-picker-search-field">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                <input
                  className="vault-picker-search-input"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={t('vaultPicker.search')}
                  autoFocus
                />
              </div>
              {!showCreate && (
                <button className="vault-picker-create-btn vault-picker-create-btn--toolbar" onClick={() => setShowCreate(true)}>
                  {t('vaultPicker.newKey')}
                </button>
              )}
            </div>
            <div className="vault-picker-list">
              {filtered.length === 0 && !showCreate && (
                <div className="vault-picker-empty">{t('vaultPicker.noMatch')}</div>
              )}
              {filtered.map(s => (
                <button
                  type="button"
                  key={s.key}
                  className={`vault-picker-item${selected === s.key ? ' active' : ''}`}
                  onClick={() => onSelect(s.key)}
                  aria-pressed={selected === s.key}
                >
                  <div className="vault-picker-item-top">
                    <span className="vault-picker-item-key">{s.key}</span>
                    {s.group && <span className="vault-picker-item-group">{s.group}</span>}
                  </div>
                  {s.desc && <span className="vault-picker-item-desc" title={s.desc}>{s.desc}</span>}
                </button>
              ))}
            </div>
            {showCreate && (
              <div className="vault-picker-create-form">
                <label className="vault-picker-create-field vault-picker-create-field--span">
                  <span className="vault-picker-create-label">{t('vaultPicker.keyLabel')}</span>
                  <input
                    className="vault-input vault-picker-create-input"
                    placeholder={t('vaultPicker.keyPlaceholder')}
                    value={newKey}
                    onChange={e => setNewKey(e.target.value)}
                    autoFocus
                  />
                </label>
                <div className="vault-picker-create-row">
                  <label className="vault-picker-create-field vault-picker-create-field--span">
                    <span className="vault-picker-create-label">{t('common.selectGroup')}</span>
                    <CustomSelect
                      className="vault-picker-create-select"
                      value={newGroup}
                      onChange={v => setNewGroup(v)}
                      placeholder={t('common.selectGroup')}
                      dropdownMode="local"
                      options={[
                        { value: '__custom__', label: t('vault.newGroup') },
                        ...groupNames.map(g => ({ value: g, label: g })),
                      ]}
                    />
                  </label>
                </div>
                <label className="vault-picker-create-field vault-picker-create-field--span">
                  <span className="vault-picker-create-label">{t('vault.descriptionLabel')}</span>
                  <input
                    className="vault-input vault-picker-create-input"
                    placeholder={t('vault.descriptionPlaceholder')}
                    value={newDesc}
                    maxLength={120}
                    onChange={e => setNewDesc(e.target.value)}
                  />
                </label>
                {newGroup === '__custom__' && (
                  <label className="vault-picker-create-field vault-picker-create-field--span">
                    <span className="vault-picker-create-label">{t('common.enterGroup')}</span>
                    <input
                      className="vault-input vault-picker-create-input"
                      placeholder={t('common.enterGroup')}
                      value={newGroupCustom}
                      onChange={e => setNewGroupCustom(e.target.value)}
                    />
                  </label>
                )}
                <label className="vault-picker-create-field vault-picker-create-field--span">
                  <span className="vault-picker-create-label">{t('vaultPicker.valueLabel')}</span>
                  <div className="vault-picker-create-value">
                    <input
                      className="vault-input vault-picker-create-input"
                      type={showValue ? 'text' : 'password'}
                      placeholder={t('vaultPicker.valuePlaceholder')}
                      value={newValue}
                      onChange={e => { setNewValue(e.target.value); setTestResult(null); }}
                    />
                    <button type="button" className="vault-picker-create-vis" onClick={() => setShowValue(!showValue)}>
                      {showValue ? t('common.hide') : t('common.show')}
                    </button>
                  </div>
                </label>
                {testEndpoint && newValue.trim() && (
                  <div className="vault-picker-test-row">
                    <button
                      type="button"
                      className="vault-picker-test-btn"
                      disabled={testing}
                      onClick={handleTest}
                    >
                      {testing ? t('common.testing') : t('common.test')}
                    </button>
                    {testResult && (
                      <span className={`vault-picker-test-result${testResult.success ? ' success' : ' fail'}`}>
                        {testResult.message}
                      </span>
                    )}
                  </div>
                )}
                <div className="vault-picker-create-actions">
                  <button className="btn-cancel" onClick={resetCreate}>{t('common.cancel')}</button>
                  <button className="btn-save" onClick={handleCreate} disabled={creating || !newKey.trim() || !newValue.trim()}>
                    {creating ? '...' : t('vaultPicker.createSelect')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
