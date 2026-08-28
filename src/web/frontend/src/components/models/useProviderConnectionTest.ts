import { Dispatch, SetStateAction, useCallback, useState } from 'react';
import { fetchModels, Provider, ProviderEndpoint, ProviderModel } from '../../api/providers';
import { api } from '../../api/client';
import { normalizeEndpoint } from './modelsCatalog';

type ConnectionResult = { success: boolean; message: string };
export type ConnectionState = 'idle' | 'testing' | 'success' | 'failure';

export function useProviderConnectionTest({
  provider,
  endpoints,
  vaultKey,
  setModels,
  onModelsChanged,
  t,
}: {
  provider: Provider | null;
  endpoints: ProviderEndpoint[];
  vaultKey: string;
  setModels: Dispatch<SetStateAction<ProviderModel[]>>;
  onModelsChanged: () => void;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionResults, setConnectionResults] = useState<ConnectionResult[] | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    provider?.authVerified === true ? 'success' : provider?.authVerified === false ? 'failure' : 'idle'
  );
  const [pulledModelCount, setPulledModelCount] = useState(0);

  const resetConnection = useCallback(() => {
    setConnectionState('idle');
    setConnectionResults(null);
    setPulledModelCount(0);
  }, []);

  const handleTestConnection = useCallback(async () => {
    const validEndpoints = endpoints.map(normalizeEndpoint).filter(endpoint => endpoint.baseUrl.trim());
    if (validEndpoints.length === 0 || !vaultKey.trim()) {
      setConnectionState('failure');
      setConnectionResults([{ success: false, message: t('models.testConnRequired') }]);
      return;
    }

    setTestingConnection(true);
    setConnectionState('testing');
    setConnectionResults([]);
    const results: ConnectionResult[] = [];
    try {
      for (const endpoint of validEndpoints) {
        try {
          const result = await api('/api/vault/test-key', {
            method: 'POST',
            body: JSON.stringify({
              baseUrl: endpoint.baseUrl,
              type: endpoint.type,
              protocol: endpoint.protocol,
              vaultKey: vaultKey.trim(),
            }),
          }) as ConnectionResult;
          results.push({ success: Boolean(result.success), message: result.message });
        } catch (error: any) {
          results.push({ success: false, message: error.message || t('models.testFailed') });
        }
        setConnectionResults([...results]);
      }

      const allOk = results.length === validEndpoints.length && results.every(result => result.success);
      let pulledCount = 0;
      if (allOk) {
        try {
          const modelResult = await fetchModels(provider?.id, {
            endpoints: validEndpoints,
            vaultKey: vaultKey.trim(),
            // Existing sites persist their validated connection and the exact
            // discovery snapshot through one backend use case. New custom
            // sites remain a preview until the form has an id to save.
            persistConfig: Boolean(provider?.id),
          });
          if (modelResult.success && modelResult.models?.length) {
            pulledCount = modelResult.models.length;
            setModels(modelResult.models.map(model => ({ ...model, id: model.id, name: model.name || model.id })));
            onModelsChanged();
          }
        } catch {
          // Discovery is best effort after a successful credential test.
        }
      }
      setPulledModelCount(pulledCount);
      setConnectionState(allOk ? 'success' : 'failure');
    } finally {
      setTestingConnection(false);
    }
  }, [endpoints, onModelsChanged, provider?.id, setModels, t, vaultKey]);

  return { testingConnection, connectionResults, connectionState, pulledModelCount, resetConnection, handleTestConnection };
}
