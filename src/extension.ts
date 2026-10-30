import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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
  uuid: string;
}

interface GpuProcess {
  gpuIndex: number;
  pid: number;
  name: string;
  memUsed: number;
}

interface GpuData {
  gpus: GpuInfo[];
  processes: GpuProcess[];
  error: string | null;
}

function csvLines(raw: string): string[][] {
  return raw
    .trim()
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => line.split(',').map(s => s.trim()));
}

// Runs nvidia-smi asynchronously so the extension host is never blocked while it initialises NVML.
async function queryGpuData(nvidiaSmiPath: string): Promise<GpuData> {
  const opts = { encoding: 'utf8' as const, timeout: 5000 };
  try {
    const [gpuRes, procRes] = await Promise.all([
      execFileAsync(nvidiaSmiPath, [
        '--query-gpu=index,name,temperature.gpu,utilization.gpu,utilization.memory,' +
        'memory.used,memory.total,power.draw,power.limit,uuid',
        '--format=csv,noheader,nounits',
      ], opts),
      execFileAsync(nvidiaSmiPath, [
        '--query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory',
        '--format=csv,noheader,nounits',
      ], opts),
    ]);

    const gpus: GpuInfo[] = csvLines(gpuRes.stdout).map(p => ({
      index:       parseInt(p[0], 10),
      name:        p[1],
      temperature: parseInt(p[2], 10),
      gpuUtil:     parseInt(p[3], 10),
      memUtil:     parseInt(p[4], 10),
      memUsed:     parseInt(p[5], 10),
      memTotal:    parseInt(p[6], 10),
      powerDraw:   parseFloat(p[7]) || 0,
      powerLimit:  parseFloat(p[8]) || 0,
      uuid:        p[9] ?? '',
    }));

    const indexByUuid = new Map(gpus.map(g => [g.uuid, g.index]));
    // process_name may itself contain commas, so take everything between pid and memory
    const processes: GpuProcess[] = csvLines(procRes.stdout).map(p => ({
      gpuIndex: indexByUuid.get(p[0]) ?? -1,
      pid:      parseInt(p[1], 10),
      name:     p.slice(2, -1).join(','),
      memUsed:  parseInt(p[p.length - 1], 10),
    }));

    return { gpus, processes, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { gpus: [], processes: [], error: message };
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
    /* Only VS Code theme tokens, so the view follows whatever theme is active. */
    :root {
      --fg:     var(--vscode-foreground);
      --dim:    var(--vscode-descriptionForeground);
      --hover:  var(--vscode-list-hoverBackground);
      --border: var(--vscode-tree-tableColumnsBorder, var(--vscode-panel-border, rgba(128,128,128,.2)));
      --track:  var(--vscode-scrollbarSlider-background, rgba(128,128,128,.25));
      --fill:   var(--vscode-progressBar-background, #0078d4);
      --warn:   var(--vscode-editorWarning-foreground, #cca700);
      --hot:    var(--vscode-editorError-foreground, #f14c4c);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      /* no background: inherit the sidebar / panel colour the view is docked in */
      color: var(--fg);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      padding: 4px 12px 10px;
      overflow-x: hidden;
      user-select: none;
    }
    .hidden { display: none !important; }
    .num, .val { font-variant-numeric: tabular-nums; }
    .dim { color: var(--dim); }

    #loading { color: var(--dim); padding: 8px 0; }
    #error {
      border: 1px solid var(--vscode-inputValidation-errorBorder, var(--hot));
      background: var(--vscode-inputValidation-errorBackground);
      padding: 4px 8px;
      margin: 4px 0;
      word-break: break-all;
      line-height: 1.4;
      user-select: text;
    }

    #summary {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      column-gap: 16px;
      line-height: 22px;
    }
    #summary .totals { color: var(--dim); }

    /* ---------- meters ---------- */
    .m { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .m .lbl { color: var(--dim); min-width: 2.8em; }
    .bar { position: relative; flex: 1; min-width: 24px; height: 4px; }
    /* scrollbar-slider colour is a bit strong as a track in most themes, so soften it */
    .bar::before { content: ''; position: absolute; inset: 0; background: var(--track); opacity: .55; }
    .bar > i { position: relative; display: block; height: 100%; width: 0; background: var(--fill); transition: width .3s ease-out; }
    .bar > i.warn { background: var(--warn); }
    .bar > i.hot  { background: var(--hot); }
    .val { text-align: right; white-space: nowrap; min-width: 4ch; }
    .m-vram .val { min-width: 13.5ch; }
    .m-pwr .val  { min-width: 10.5ch; }
    .sub { color: var(--dim); }
    .warn-text { color: var(--warn); }
    .hot-text  { color: var(--hot); }

    /* ---------- GPU rows: narrow (sidebar) layout ---------- */
    .row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      grid-template-areas:
        "title meta"
        "util  bw"
        "vram  vram";
      column-gap: 10px;
      row-gap: 1px;
      padding: 5px 4px;
      margin: 0 -4px;
      line-height: 18px;
    }
    .row:hover { background: var(--hover); }
    .head { display: none; }
    .idx  { display: none; grid-area: idx; color: var(--dim); }
    .title { grid-area: title; display: flex; gap: 6px; min-width: 0; white-space: nowrap; }
    .name { grid-area: name; overflow: hidden; text-overflow: ellipsis; color: var(--dim); display: none; }
    body.mixed .name { display: block; }
    .meta { grid-area: meta; display: flex; justify-content: flex-end; gap: 10px; white-space: nowrap; }
    .procs { display: none; color: var(--dim); }
    .m-util { grid-area: util; }
    .m-bw   { grid-area: bw; }
    .m-vram { grid-area: vram; }
    .m-pwr  { grid-area: pwr; display: none; }

    /* ---------- GPU rows: wide (panel) layout, one table row per GPU ---------- */
    @media (min-width: 620px) {
      .row, .head {
        display: grid;
        grid-template-columns: 2ch minmax(80px,1fr) minmax(150px,1.8fr) minmax(80px,1fr) minmax(130px,1.4fr) 5ch 5ch;
        grid-template-areas: "idx util vram bw pwr temp procs";
        column-gap: 16px;
        line-height: 22px;
        padding: 0 4px;
        margin: 0 -4px;
      }
      body.mixed .row, body.mixed .head {
        grid-template-columns: 2ch minmax(90px,1.2fr) minmax(80px,1fr) minmax(150px,1.8fr) minmax(80px,1fr) minmax(130px,1.4fr) 5ch 5ch;
        grid-template-areas: "idx name util vram bw pwr temp procs";
      }
      .head { font-weight: 600; border-bottom: 1px solid var(--border); }
      .idx { display: block; }
      .title { display: contents; }
      .gname { display: none; }
      .name { color: inherit; }
      .meta { display: contents; }
      .temp  { grid-area: temp; text-align: right; }
      .procs { display: block; grid-area: procs; text-align: right; }
      .pwr-text { display: none; }
      .m .lbl { display: none; }
      .m-pwr { display: flex; }
      .h-name { display: none; }
      body.mixed .h-name { display: block; }
      .h-r { text-align: right; }
    }

    /* ---------- processes ---------- */
    #procs { margin-top: 10px; }
    table { width: 100%; border-collapse: collapse; }
    th {
      text-align: left;
      font-weight: 600;
      line-height: 22px;
      padding: 0 8px 0 0;
      border-bottom: 1px solid var(--border);
    }
    td { line-height: 22px; padding: 0 8px 0 0; white-space: nowrap; }
    tbody tr:hover td { background: var(--hover); }
    .c-gpu, .c-pid, .c-mem { width: 1%; }
    .c-pid { color: var(--dim); }
    .c-name { max-width: 0; overflow: hidden; text-overflow: ellipsis; user-select: text; }
    .c-name.unknown { color: var(--dim); }
    th.c-mem, td.c-mem { text-align: right; padding-right: 0; }
  </style>
</head>
<body>
  <div id="loading">Waiting for nvidia-smi…</div>
  <div id="error" class="hidden"></div>
  <div id="summary" class="hidden"><span id="sum-name"></span><span id="sum-totals" class="totals num"></span></div>
  <div id="gpus" class="hidden">
    <div class="head">
      <span style="grid-area:idx">#</span>
      <span style="grid-area:name" class="h-name">Name</span>
      <span style="grid-area:util">GPU</span>
      <span style="grid-area:vram">Memory</span>
      <span style="grid-area:bw">Mem BW</span>
      <span style="grid-area:pwr">Power</span>
      <span style="grid-area:temp" class="h-r">Temp</span>
      <span style="grid-area:procs" class="h-r">Procs</span>
    </div>
    <div id="rows"></div>
  </div>
  <div id="procs" class="hidden">
    <table>
      <thead><tr><th class="c-gpu">GPU</th><th class="c-pid">PID</th><th>Process</th><th class="c-mem">Memory</th></tr></thead>
      <tbody id="proc-body"></tbody>
    </table>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const $ = function(id) { return document.getElementById(id); };
    const rows = new Map();  // gpu index -> { el, r }
    let lastProcKey = '';

    // DOM writes only happen when a value actually changes.
    function setText(el, s) { if (el._t !== s) { el._t = s; el.textContent = s; } }
    function setClass(el, s) { if (el._c !== s) { el._c = s; el.className = s; } }
    function setBar(el, pct, lvl) {
      const w = Math.max(0, Math.min(100, pct || 0)).toFixed(1) + '%';
      if (el._w !== w) { el._w = w; el.style.width = w; }
      setClass(el, lvl);
    }
    function toggle(el, show) { el.classList.toggle('hidden', !show); }

    function level(v, warn, hot) { return v >= hot ? 'hot' : v >= warn ? 'warn' : ''; }
    function gib(mib) { return ((mib || 0) / 1024).toFixed(1); }
    function pct(v) { return isNaN(v) ? '–' : Math.round(v) + '%'; }
    function formatMem(mib) {
      if (!mib || isNaN(mib)) { return '–'; }
      return mib >= 1024 ? gib(mib) + ' GiB' : mib + ' MiB';
    }
    function shortName(n) { return String(n).replace(/^NVIDIA +/, '').replace(/^GeForce +/, ''); }
    function baseName(p) {
      const s = String(p);
      return s.substring(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\\\')) + 1) || s;
    }
    function escHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function meter(key, label, sub) {
      return '<div class="m m-' + key + '"><span class="lbl">' + label + '</span>' +
             '<div class="bar"><i data-r="' + key + 'Bar"></i></div>' +
             '<span class="val"><span data-r="' + key + '"></span>' +
             (sub ? '<span class="sub" data-r="' + key + 'Sub"></span>' : '') + '</span></div>';
    }

    function createRow() {
      const el = document.createElement('div');
      el.className = 'row';
      el.innerHTML =
        '<span class="idx num" data-r="idx"></span>' +
        '<span class="title"><span class="gname" data-r="gname"></span><span class="name" data-r="name"></span></span>' +
        '<span class="meta num">' +
          '<span class="procs" data-r="procs"></span>' +
          '<span class="temp" data-r="temp"></span>' +
          '<span class="pwr-text dim" data-r="pwrText"></span>' +
        '</span>' +
        meter('util', 'Util') + meter('bw', 'BW') + meter('vram', 'Mem', true) + meter('pwr', 'Pwr', true);
      const r = {};
      el.querySelectorAll('[data-r]').forEach(function(n) { r[n.dataset.r] = n; });
      return { el: el, r: r };
    }

    function updateRow(row, g, procCount) {
      const r = row.r;
      const memPct = g.memTotal > 0 ? g.memUsed / g.memTotal * 100 : 0;
      const pwrPct = g.powerLimit > 0 ? g.powerDraw / g.powerLimit * 100 : 0;

      setText(r.idx, String(g.index));
      setText(r.gname, 'GPU ' + g.index);
      setText(r.name, shortName(g.name));
      if (row.el.title !== g.name + '\\n' + g.uuid) { row.el.title = g.name + '\\n' + g.uuid; }
      setText(r.procs, procCount > 0 ? String(procCount) : '');
      setText(r.temp, isNaN(g.temperature) ? '–' : g.temperature + '°C');
      const tl = level(g.temperature, 75, 85);
      setClass(r.temp, 'temp' + (tl ? ' ' + tl + '-text' : ''));
      setText(r.pwrText, Math.round(g.powerDraw) + ' W');

      // Utilisation stays in the accent colour: a busy GPU is not a problem.
      setBar(r.utilBar, g.gpuUtil, '');
      setText(r.util, pct(g.gpuUtil));
      setBar(r.bwBar, g.memUtil, '');
      setText(r.bw, pct(g.memUtil));
      setBar(r.vramBar, memPct, level(memPct, 85, 95));
      setText(r.vram, gib(g.memUsed));
      setText(r.vramSub, ' / ' + gib(g.memTotal) + ' GiB');
      setBar(r.pwrBar, pwrPct, level(pwrPct, 90, 98));
      setText(r.pwr, String(Math.round(g.powerDraw)));
      setText(r.pwrSub, ' / ' + Math.round(g.powerLimit) + ' W');
    }

    function renderGpus(gpus, processes) {
      const container = $('rows');
      const counts = {};
      processes.forEach(function(p) { counts[p.gpuIndex] = (counts[p.gpuIndex] || 0) + 1; });
      const seen = new Set();
      gpus.forEach(function(g, i) {
        let row = rows.get(g.index);
        if (!row) { row = createRow(); rows.set(g.index, row); }
        if (container.children[i] !== row.el) { container.insertBefore(row.el, container.children[i] || null); }
        updateRow(row, g, counts[g.index] || 0);
        seen.add(g.index);
      });
      rows.forEach(function(row, idx) {
        if (!seen.has(idx)) { row.el.remove(); rows.delete(idx); }
      });
    }

    function renderSummary(gpus) {
      const names = new Set(gpus.map(function(g) { return g.name; }));
      const mixed = names.size > 1;
      document.body.classList.toggle('mixed', mixed);
      setText($('sum-name'), mixed ? gpus.length + ' GPUs'
        : (gpus.length > 1 ? gpus.length + ' × ' : '') + (gpus[0] ? gpus[0].name : ''));
      let used = 0, total = 0, power = 0;
      gpus.forEach(function(g) { used += g.memUsed || 0; total += g.memTotal || 0; power += g.powerDraw || 0; });
      setText($('sum-totals'), gpus.length > 1
        ? gib(used) + ' / ' + gib(total) + ' GiB  ·  ' + Math.round(power) + ' W' : '');
    }

    function renderProcs(processes) {
      const key = JSON.stringify(processes);
      if (key === lastProcKey) { return; }
      lastProcKey = key;
      toggle($('procs'), processes.length > 0);
      $('proc-body').innerHTML = processes.slice()
        .sort(function(a, b) { return a.gpuIndex - b.gpuIndex || b.memUsed - a.memUsed; })
        .map(function(p) {
          const unknown = !p.name || p.name.charAt(0) === '[';
          return '<tr><td class="c-gpu num">' + (p.gpuIndex >= 0 ? p.gpuIndex : '?') + '</td>' +
            '<td class="c-pid num">' + p.pid + '</td>' +
            '<td class="c-name' + (unknown ? ' unknown' : '') + '" title="' + escHtml(p.name) + '">' +
              escHtml(unknown ? (p.name || 'unknown') : baseName(p.name)) + '</td>' +
            '<td class="c-mem num">' + formatMem(p.memUsed) + '</td></tr>';
        }).join('');
    }

    window.addEventListener('message', function(event) {
      const msg = event.data;
      if (msg.type !== 'gpuData') { return; }
      const data = msg.payload;
      const ok = !data.error;

      toggle($('loading'), false);
      toggle($('error'), !ok);
      toggle($('summary'), ok);
      toggle($('gpus'), ok);
      if (!ok) {
        setText($('error'), 'nvidia-smi failed: ' + data.error);
        toggle($('procs'), false);
        lastProcKey = '';
        return;
      }
      renderSummary(data.gpus);
      renderGpus(data.gpus, data.processes || []);
      renderProcs(data.processes || []);
    });

    // Ask for the latest snapshot whenever the webview is (re)created.
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

class GpuMonitorViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'multiGpuMonitor.panel';

  private _view?: vscode.WebviewView;
  private _intervalHandle?: ReturnType<typeof setInterval>;
  private _smiPath = 'nvidia-smi';
  private _inFlight = false;
  private _lastData?: GpuData;
  private _lastJson = '';

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewView.webview.html = getWebviewContent();

    webviewView.webview.onDidReceiveMessage(msg => {
      if (msg?.type === 'ready' && this._lastData) {
        webviewView.webview.postMessage({ type: 'gpuData', payload: this._lastData });
      }
    });

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
      this._view = undefined;
    });
  }

  private _startPolling(): void {
    this._stopPolling();
    const config = vscode.workspace.getConfiguration('multiGpuMonitor');
    const interval = config.get<number>('refreshInterval', 2000);
    this._smiPath = config.get<string>('nvidiaSmiPath', 'nvidia-smi');

    void this._poll();
    this._intervalHandle = setInterval(() => void this._poll(), interval);
  }

  private _stopPolling(): void {
    if (this._intervalHandle !== undefined) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = undefined;
    }
  }

  private async _poll(force = false): Promise<void> {
    // Skip a tick rather than stacking nvidia-smi processes if one is still running.
    if (!this._view?.visible || this._inFlight) { return; }
    this._inFlight = true;
    try {
      const data = await queryGpuData(this._smiPath);
      const json = JSON.stringify(data);
      // Unchanged snapshots (common on idle GPUs) are not sent to the webview at all.
      if (!force && json === this._lastJson) { return; }
      this._lastJson = json;
      this._lastData = data;
      this._view?.webview.postMessage({ type: 'gpuData', payload: data });
    } finally {
      this._inFlight = false;
    }
  }

  public restartPolling(): void {
    this._startPolling();
  }

  public forceRefresh(): void {
    void this._poll(true);
  }

  public dispose(): void {
    this._stopPolling();
  }
}

let provider: GpuMonitorViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  provider = new GpuMonitorViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(GpuMonitorViewProvider.viewType, provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('multiGpuMonitor.refresh', () => {
      provider?.forceRefresh();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('multiGpuMonitor')) {
        provider?.restartPolling();
      }
    })
  );
}

export function deactivate(): void {
  provider?.dispose();
}
