import { UsageWorkspaceView } from './UsageWorkspaceView';
import { useUsagePageState } from './useUsagePageState';

export default function UsagePage() {
  return <UsageWorkspaceView {...useUsagePageState()} />;
}
