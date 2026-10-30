# Multi-GPU Monitor

> Fork of [GPU Monitoring Service](https://github.com/Minato3000/gpu-monitoring-service) by Minato3000, redesigned for machines with many GPUs.

Real-time NVIDIA GPU stats in VS Code. Works locally and over Remote-SSH.

## Features

- **Fits many GPUs on screen**: one table row per GPU in a wide panel, compact three-line items in the sidebar
- Utilization, memory, memory bandwidth, power draw and temperature for every GPU
- Totals across all GPUs (memory, power); the model is shown once when all GPUs are identical
- Compute processes mapped to the GPU they run on
- Native VS Code look that follows your color theme; warning and error colors only when memory, power or temperature run high
- Light on resources: `nvidia-smi` runs asynchronously, unchanged data is not re-rendered, and polling stops while the view is hidden

## Requirements

- NVIDIA GPU with `nvidia-smi` installed and on `PATH`
- Linux or Windows with NVIDIA drivers

When connected to a remote machine, the extension runs on the remote host and shows that host's GPUs.

## Settings

| Setting | Default | Description |
|---|---|---|
| `multiGpuMonitor.refreshInterval` | `2000` | Poll interval in ms |
| `multiGpuMonitor.nvidiaSmiPath` | `nvidia-smi` | Path to the nvidia-smi executable |

## Credits

Forked from [GPU Monitoring Service](https://github.com/Minato3000/gpu-monitoring-service) by Minato3000 (MIT).
