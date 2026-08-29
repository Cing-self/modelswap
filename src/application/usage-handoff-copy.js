// Usage hand-offs are a transport contract, not display copy. The frontend
// owns localization; application results carry stable message/action keys and
// non-display target keys alongside the destination URL.
function target(key) {
  return { key: `usage.handoff.target.${key}` };
}

function createHandoff(noticeKey, targetKey, refreshPolicy, url, mode, actionTargetKey = targetKey) {
  return {
    source: 'console',
    refreshPolicy,
    handoff: {
      notice: { key: noticeKey, params: { target: target(targetKey) } },
      ...(url ? {
        action: {
          key: 'usage.handoff.action.open',
          params: { target: target(actionTargetKey) },
          url,
          ...(mode ? { mode } : {}),
        },
      } : {}),
    },
  };
}

function consoleUsageHandoff(targetKey, url) {
  return createHandoff('usage.handoff.notice.console', targetKey, 'never', url);
}

function browserRefreshHandoff(targetKey, url, mode) {
  return createHandoff('usage.handoff.notice.browserRefresh', targetKey, 'manual', url, mode);
}

function manualRefreshHandoff(targetKey, url, mode, actionTargetKey) {
  return createHandoff('usage.handoff.notice.manualRefresh', targetKey, 'manual', url, mode, actionTargetKey);
}

function pluginRefreshHandoff(targetKey, url, mode) {
  return createHandoff('usage.handoff.notice.pluginRefresh', targetKey, 'manual', url, mode);
}

function credentialRefreshHandoff(targetKey, url) {
  return createHandoff('usage.handoff.notice.credentialRefresh', targetKey, 'auto', url);
}

function unavailableConsoleHandoff(targetKey, url, mode) {
  return createHandoff('usage.handoff.notice.unavailableConsole', targetKey, 'manual', url, mode);
}

module.exports = {
  browserRefreshHandoff,
  consoleUsageHandoff,
  credentialRefreshHandoff,
  manualRefreshHandoff,
  pluginRefreshHandoff,
  unavailableConsoleHandoff,
};
