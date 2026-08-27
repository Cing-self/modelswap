import { ModelsWorkspaceView } from './ModelsWorkspaceView';
import { useModelsPageState } from './useModelsPageState';

export default function ModelsPage() {
  return <ModelsWorkspaceView {...useModelsPageState()} />;
}
