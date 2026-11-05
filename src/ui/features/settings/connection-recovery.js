import { postJson, requestDashboardRefresh } from '../../api.js';

function connectionRestartResult(status = {}) {
  const tunnelStatus = String(status?.tunnelStatus || '');
  if (status?.serverRunning === false) {
    return {
      ok: false,
      status,
      error: 'Rel.AI could not restart the local connection. Restart Rel.AI, then try again.'
    };
  }
  if (tunnelStatus === 'failed' || tunnelStatus === 'stopped') {
    return {
      ok: false,
      status,
      error: 'The local connection restarted, but the Secure MCP Tunnel is still unavailable. Review the Tunnel ID and runtime API key in Connection settings.'
    };
  }
  return { ok: true, status };
}

export async function restartConnection() {
  if (typeof window.relaiDesktop?.restartConnection !== 'function') {
    return { ok: false, error: 'Retrying the connection is available in the installed Rel.AI desktop app.' };
  }
  try {
    const status = await window.relaiDesktop.restartConnection();
    requestDashboardRefresh();
    return connectionRestartResult(status);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error || 'Connection retry failed.') };
  }
}

export async function repairConnectionAndState() {
  let result;
  try {
    result = await postJson('/api/diagnostics/reset', { target: 'repair', confirm: true }, { timeout: 4000 });
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error || 'State repair failed.') };
  }
  let desktopStatus = null;
  if (typeof window.relaiDesktop?.restartConnection === 'function') {
    try {
      desktopStatus = await window.relaiDesktop.restartConnection();
    } catch (error) {
      if (!result?.ok) {
        return { ok: false, error: error instanceof Error ? error.message : String(error || 'State repair failed.') };
      }
    }
  }
  requestDashboardRefresh();
  if (result?.ok) {
    return {
      ok: true,
      repair: result.repair || null,
      status: desktopStatus,
      message: result.message || 'Connection and runtime state repaired.'
    };
  }
  if (desktopStatus && desktopStatus.serverRunning !== false) {
    return {
      ok: true,
      repair: null,
      status: desktopStatus,
      message: 'Connection and runtime state repaired and restarted.'
    };
  }
  return {
    ok: false,
    error: result?.error || 'Could not repair the Rel.AI connection and runtime state.'
  };
}
