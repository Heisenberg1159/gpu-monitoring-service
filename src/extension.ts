import * as vscode from 'vscode';
import { execSync } from 'child_process';

interface GpuInfo {
  index: number;
  name: string;
  temperature: number;
  gpuUtil: number;
  memUtil: number;
  memUsed: number;
  memTotal: number;
  powerDraw: number;
  powerLimit: number;
}

interface GpuProcess {
  pid: number;
  name: string;
  memUsed: number;
}

interface GpuData {
  gpus: GpuInfo[];
  processes: GpuProcess[];
  timestamp: number;
  error: string | null;
}

function parseGpuData(nvidiaSmiPath: string): GpuData {
  const timestamp = Date.now();
  try {
    const gpuRaw = execSync(
      `${nvidiaSmiPath} --query-gpu=index,name,temperature.gpu,utilization.gpu,` +
      `utilization.memory,memory.used,memory.total,power.draw,power.limit ` +
      `--format=csv,noheader,nounits`,
      { encoding: 'utf8', timeout: 5000 }
    );

    const gpus: GpuInfo[] = gpuRaw
      .trim()
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => {
        const p = line.split(',').map(s => s.trim());
        return {
          index:       parseInt(p[0], 10),
          name:        p[1],
          temperature: parseInt(p[2], 10),
          gpuUtil:     parseInt(p[3], 10),
          memUtil:     parseInt(p[4], 10),
          memUsed:     parseInt(p[5], 10),
          memTotal:    parseInt(p[6], 10),
          powerDraw:   parseFloat(p[7]) || 0,
          powerLimit:  parseFloat(p[8]) || 0,
        };
      });

    const procRaw = execSync(
      `${nvidiaSmiPath} --query-compute-apps=pid,process_name,used_gpu_memory ` +
      `--format=csv,noheader,nounits`,
      { encoding: 'utf8', timeout: 5000 }
    );

    const processes: GpuProcess[] = procRaw
      .trim()
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => {
        const p = line.split(',').map(s => s.trim());
        return {
          pid:     parseInt(p[0], 10),
          name:    p[1],
          memUsed: parseInt(p[2], 10),
        };
      });

    return { gpus, processes, timestamp, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { gpus: [], processes: [], timestamp, error: message };
  }
}

function getWebviewContent(): string {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GPU Monitor</title>
  <style>
    :root {
      --bg-card:   var(--vscode-editor-inactiveSelectionBackground);
      --border:    var(--vscode-panel-border);
      --text:      var(--vscode-foreground);
      --text-dim:  var(--vscode-descriptionForeground);
      --accent:    var(--vscode-activityBarBadge-background);
      --green:     var(--vscode-terminal-ansiGreen);
      --yellow:    var(--vscode-terminal-ansiYellow);
      --red:       var(--vscode-terminal-ansiRed);
      --cyan:      var(--vscode-terminal-ansiCyan);
      --font-mono: var(--vscode-editor-font-family);
      --font-size: var(--vscode-editor-font-size);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--vscode-sideBar-background);
      color: var(--text);
      font-family: var(--font-mono), 'Courier New', monospace;
      font-size: var(--font-size, 12px);
      padding: 8px;
      overflow-x: hidden;
    }
    #loading {
      color: var(--text-dim);
      text-align: center;
      padding: 20px 0;
      font-size: 0.9em;
    }
    .error-banner {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      color: var(--vscode-inputValidation-errorForeground, #f48771);
      padding: 8px 10px;
      border-radius: 3px;
      font-size: 0.82em;
      margin-bottom: 8px;
      word-break: break-all;
      line-height: 1.4;
    }
    .gpu-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 10px 12px;
      margin-bottom: 8px;
    }
    .gpu-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 9px;
      padding-bottom: 7px;
      border-bottom: 1px solid var(--border);
    }
    .gpu-name {
      color: var(--cyan);
      font-weight: bold;
      font-size: 1.02em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 80%;
    }
    .gpu-index-badge {
      background: var(--accent, #007acc);
      color: #fff;
      border-radius: 3px;
      padding: 1px 7px;
      font-size: 0.8em;
      flex-shrink: 0;
    }
    .stat-row {
      display: grid;
      grid-template-columns: 60px 1fr 46px;
      align-items: center;
      gap: 6px;
      margin: 3px 0;
    }
    .stat-label {
      color: var(--text-dim);
      font-size: 0.82em;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .stat-bar { letter-spacing: -1px; }
    .stat-value {
      text-align: right;
      font-size: 0.85em;
      color: var(--text-dim);
    }
    .bar-filled      { color: var(--green); }
    .bar-filled.warn { color: var(--yellow); }
    .bar-filled.hot  { color: var(--red); }
    .bar-empty       { color: var(--border, #333); }
    .footer-row {
      display: flex;
      justify-content: space-between;
      margin-top: 7px;
      padding-top: 6px;
      border-top: 1px solid var(--border);
      color: var(--text-dim);
      font-size: 0.8em;
      gap: 4px;
    }
    .footer-row span { white-space: nowrap; }
    .temp-ok   { color: var(--green); }
    .temp-warm { color: var(--yellow); }
    .temp-hot  { color: var(--red); }
    .section-header {
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-size: 0.78em;
      padding: 6px 0 4px 0;
      border-bottom: 1px solid var(--border);
      margin-bottom: 4px;
    }
    table { width: 100%; border-collapse: collapse; font-size: 0.83em; }
    th {
      color: var(--text-dim);
      text-align: left;
      padding: 3px 5px;
      font-weight: normal;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-size: 0.8em;
    }
    td { padding: 3px 5px; border-top: 1px solid var(--border); }
    tr:hover td { background: var(--vscode-list-hoverBackground); }
    .proc-pid  { color: var(--text-dim); }
    .proc-name {
      color: var(--cyan);
      max-width: 130px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .proc-mem  { color: var(--yellow); text-align: right; }
    .proc-section { margin-bottom: 8px; }
    .timestamp {
      color: var(--text-dim);
      font-size: 0.72em;
      text-align: right;
      padding-top: 2px;
      opacity: 0.7;
    }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div id="root">
    <div id="loading">Waiting for GPU data...</div>
    <div id="error-banner" class="error-banner hidden"></div>
    <div id="gpu-cards"></div>
    <div id="processes-section" class="proc-section hidden">
      <div class="section-header">Compute Processes</div>
      <table>
        <thead>
          <tr>
            <th>PID</th>
            <th>Process</th>
            <th style="text-align:right">VRAM</th>
          </tr>
        </thead>
        <tbody id="processes-body"></tbody>
      </table>
    </div>
    <div id="timestamp" class="timestamp hidden"></div>
  </div>

  <script>
    const BAR_WIDTH = 14;

    function renderBar(percent, warn, hot) {
      warn = warn === undefined ? 75 : warn;
      hot  = hot  === undefined ? 90 : hot;
      const pct     = Math.max(0, Math.min(100, percent || 0));
      const filled  = Math.round((pct / 100) * BAR_WIDTH);
      const empty   = BAR_WIDTH - filled;
      let cls = 'bar-filled';
      if (pct >= hot)  { cls = 'bar-filled hot'; }
      else if (pct >= warn) { cls = 'bar-filled warn'; }
      const f = filled > 0 ? '<span class="' + cls + '">' + '▓'.repeat(filled) + '</span>' : '';
      const e = empty  > 0 ? '<span class="bar-empty">'  + '░'.repeat(empty)  + '</span>' : '';
      return f + e;
    }

    function formatMem(mib) {
      if (!mib || isNaN(mib)) { return '0 MiB'; }
      return mib >= 1024 ? (mib / 1024).toFixed(1) + ' GiB' : mib + ' MiB';
    }

    function tempClass(c) {
      if (c >= 85) { return 'temp-hot'; }
      if (c >= 70) { return 'temp-warm'; }
      return 'temp-ok';
    }

    function escHtml(s) {
      return String(s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function renderGpuCard(g) {
      const memPct   = g.memTotal > 0 ? (g.memUsed / g.memTotal) * 100 : 0;
      const pwrPct   = g.powerLimit > 0 ? (g.powerDraw / g.powerLimit) * 100 : 0;
      const tClass   = tempClass(g.temperature);
      return [
        '<div class="gpu-card">',
        '  <div class="gpu-card-header">',
        '    <span class="gpu-name">' + escHtml(g.name) + '</span>',
        '    <span class="gpu-index-badge">GPU ' + g.index + '</span>',
        '  </div>',
        '  <div class="stat-row">',
        '    <span class="stat-label">GPU</span>',
        '    <span class="stat-bar">' + renderBar(g.gpuUtil) + '</span>',
        '    <span class="stat-value">' + g.gpuUtil + '%</span>',
        '  </div>',
        '  <div class="stat-row">',
        '    <span class="stat-label">VRAM</span>',
        '    <span class="stat-bar">' + renderBar(memPct) + '</span>',
        '    <span class="stat-value">' + Math.round(memPct) + '%</span>',
        '  </div>',
        '  <div class="stat-row">',
        '    <span class="stat-label">MEM BW</span>',
        '    <span class="stat-bar">' + renderBar(g.memUtil) + '</span>',
        '    <span class="stat-value">' + g.memUtil + '%</span>',
        '  </div>',
        '  <div class="stat-row">',
        '    <span class="stat-label">POWER</span>',
        '    <span class="stat-bar">' + renderBar(pwrPct, 70, 90) + '</span>',
        '    <span class="stat-value">' + Math.round(g.powerDraw) + 'W</span>',
        '  </div>',
        '  <div class="footer-row">',
        '    <span>' + formatMem(g.memUsed) + ' / ' + formatMem(g.memTotal) + '</span>',
        '    <span>TEMP <span class="' + tClass + '">' + g.temperature + '°C</span></span>',
        '    <span>TDP ' + Math.round(g.powerLimit) + 'W</span>',
        '  </div>',
        '</div>',
      ].join('\\n');
    }

    function renderProcRow(p) {
      return [
        '<tr>',
        '  <td class="proc-pid">' + p.pid + '</td>',
        '  <td class="proc-name" title="' + escHtml(p.name) + '">' + escHtml(p.name) + '</td>',
        '  <td class="proc-mem">' + formatMem(p.memUsed) + '</td>',
        '</tr>',
      ].join('');
    }

    window.addEventListener('message', function(event) {
      const msg = event.data;
      if (msg.type !== 'gpuData') { return; }
      const data = msg.payload;

      const loadingEl   = document.getElementById('loading');
      const errorEl     = document.getElementById('error-banner');
      const cardsEl     = document.getElementById('gpu-cards');
      const procSecEl   = document.getElementById('processes-section');
      const procBodyEl  = document.getElementById('processes-body');
      const tsEl        = document.getElementById('timestamp');

      if (loadingEl) { loadingEl.classList.add('hidden'); }

      if (data.error) {
        errorEl.textContent = '⚠ nvidia-smi error: ' + data.error;
        errorEl.classList.remove('hidden');
        cardsEl.innerHTML = '';
        procSecEl.classList.add('hidden');
        return;
      }

      errorEl.classList.add('hidden');
      cardsEl.innerHTML = data.gpus.map(renderGpuCard).join('');

      if (data.processes && data.processes.length > 0) {
        procBodyEl.innerHTML = data.processes.map(renderProcRow).join('');
        procSecEl.classList.remove('hidden');
      } else {
        procSecEl.classList.add('hidden');
      }

      tsEl.textContent = 'Updated ' + new Date(data.timestamp).toLocaleTimeString();
      tsEl.classList.remove('hidden');
    });
  </script>
</body>
</html>`;
}

class GpuMonitorViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'nvidiagpumonitor.panel';

  private _view?: vscode.WebviewView;
  private _intervalHandle?: ReturnType<typeof setInterval>;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getWebviewContent();

    this._startPolling();

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._startPolling();
      } else {
        this._stopPolling();
      }
    });

    webviewView.onDidDispose(() => {
      this._stopPolling();
    });
  }

  private _startPolling(): void {
    this._stopPolling();
    const config = vscode.workspace.getConfiguration('nvidiagpumonitor');
    const interval = config.get<number>('refreshInterval', 2000);
    const smiPath = config.get<string>('nvidiaSmiPath', 'nvidia-smi');

    this._sendData(smiPath);
    this._intervalHandle = setInterval(() => this._sendData(smiPath), interval);
  }

  private _stopPolling(): void {
    if (this._intervalHandle !== undefined) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = undefined;
    }
  }

  private _sendData(smiPath: string): void {
    if (!this._view?.visible) { return; }
    const data = parseGpuData(smiPath);
    this._view.webview.postMessage({ type: 'gpuData', payload: data });
  }

  public restartPolling(): void {
    this._startPolling();
  }

  public forceRefresh(): void {
    const config = vscode.workspace.getConfiguration('nvidiagpumonitor');
    const smiPath = config.get<string>('nvidiaSmiPath', 'nvidia-smi');
    this._sendData(smiPath);
  }

  public dispose(): void {
    this._stopPolling();
  }
}

let provider: GpuMonitorViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  provider = new GpuMonitorViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      GpuMonitorViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('nvidiagpumonitor.refresh', () => {
      provider?.forceRefresh();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('nvidiagpumonitor')) {
        provider?.restartPolling();
      }
    })
  );
}

export function deactivate(): void {
  provider?.dispose();
}
