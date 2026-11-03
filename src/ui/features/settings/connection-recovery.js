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
  try {
    const result = await postJson('/api/diagnostics/reset', { target: 'repair', confirm: true }, { timeout: 25000 });
    if (typeof window.relaiDesktop?.restartConnection === 'function') {
      try {
        await window.relaiDesktop.restartConnection();
      } catch {
        // Keep the backend state repair outcome even if the desktop tunnel does not need a restart.
      }
    }
    requestDashboardRefresh();
    if (!result?.ok) {
      return {
        ok: false,
        error: result?.error || 'Could not repair the Rel.AI connection and runtime state.'
      };
    }
    return {
      ok: true,
      repair: result.repair || null,
      message: result.message || 'Connection and runtime state repaired.'
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error || 'State repair failed.') };
  }
}
