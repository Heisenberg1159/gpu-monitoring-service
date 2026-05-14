# NVIDIA GPU Monitor

Real-time NVIDIA GPU stats in a VS Code sidebar panel. No terminal needed.

## Features

- Per-GPU utilization, VRAM usage, memory bandwidth, power draw, and temperature
- ASCII progress bars that color-shift green → yellow → red as load increases
- Compute process table showing which processes are using the GPU
- Adapts to VS Code dark/light themes automatically
- Configurable poll interval

## Requirements

- NVIDIA GPU with `nvidia-smi` installed and on PATH
- Linux or Windows with NVIDIA drivers

## Settings

| Setting | Default | Description |
|---|---|---|
| `nvidiagpumonitor.refreshInterval` | `2000` | Poll interval in ms |
| `nvidiagpumonitor.nvidiaSmiPath` | `nvidia-smi` | Path to nvidia-smi executable |
