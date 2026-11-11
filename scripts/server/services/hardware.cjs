// services/hardware.cjs — hardware detection, telemetry and memory polling (Step 9.8e).
//
// Moved from serve.cjs without behaviour changes: the same detection order, the same once-per-run
// caches, the same 5-second polling timers (NVIDIA VRAM, llama.cpp device memory, and macOS RAM),
// and the same report shapes for /api/hardware-specs, /api/telemetry and the health/diagnostics routes.
// What is new:
//   * everything the code touches (os, fs, child_process, the platform, engine paths) is injected, so
//     tests can supply recorded outputs for each OS and GPU vendor without real hardware;
//   * the polling timers are started by start() (serve.cjs calls it at the same point of module load
//     as before) and can be cleared by stop();
//   * budget: a read-only view of memory for model loading and the future resource scheduler (9.9).
// GPU and NPU acceleration remain unverified in USAP; this module doesn't change that.
"use strict";

/**
 * @param {object} deps
 * @param {typeof import("os")} deps.os
 * @param {typeof import("fs")} deps.fs
 * @param {typeof import("path")} deps.path
 * @param {Function} deps.execSync
 * @param {Function} deps.spawnSync
 * @param {Function} deps.exec
 * @param {Function} deps.execFile
 * @param {string} deps.osPlatform                  process.platform (or a recorded one in tests)
 * @param {object} deps.LLM_BACKEND_PATHS            llama.cpp engine binaries per backend
 * @param {() => object|null} deps.getBackendProc    the image engine process (VRAM polling pauses while it runs)
 * @param {() => string} deps.getOpenVinoPython
 * @param {() => string} deps.getCoreMLPythonPath
 * @param {{ setInterval?: Function, clearInterval?: Function }} [deps.timers]
 */
function createHardwareService(deps) {
  const REQUIRED = ["os", "fs", "path", "execSync", "spawnSync", "exec", "execFile", "osPlatform", "LLM_BACKEND_PATHS", "getBackendProc", "getOpenVinoPython", "getCoreMLPythonPath"];
  for (const name of REQUIRED) {
    if (deps[name] === undefined || deps[name] === null) throw new Error(`services/hardware: missing dependency ${name}`);
  }
  const { os, fs, path, execSync, spawnSync, exec, execFile, osPlatform, LLM_BACKEND_PATHS, getBackendProc, getOpenVinoPython, getCoreMLPythonPath } = deps;
  const setIntervalFn = (deps.timers && deps.timers.setInterval) || setInterval;
  const clearIntervalFn = (deps.timers && deps.timers.clearInterval) || clearInterval;

  let lastCpuSample = null;
  let cachedGpuInfo = null;

  let cachedVramInfo = null;

  function roundGb(bytes) {
    return Math.round((bytes / (1024 ** 3)) * 100) / 100;
  }

  // Detect physical CPU cores (not logical/hyperthreaded cores)
  // llama.cpp docs: "Do NOT set threads too high — major cause of oversaturation"
  function getPhysicalCores() {
    const cpus = os.cpus();
    const logicalCores = cpus.length;
    
    if (logicalCores <= 1) return 1;
    
    // Check if hyperthreading is likely: compare unique core IDs vs total
    // On Windows/Linux, os.cpus() lists each logical core separately
    // Physical cores typically have the same model but different speeds can indicate HT
    const uniqueModels = new Set(cpus.map(c => c.model)).size;
    
    // If we have very few unique models relative to core count, likely HT
    // Also check: if logical cores is exactly 2x a common physical core count
    const commonPhysicalCounts = [2, 4, 6, 8, 10, 12, 16, 20, 24, 32];
    const isLikelyHT = commonPhysicalCounts.some(physical => logicalCores === physical * 2);
    
    if (isLikelyHT || uniqueModels < logicalCores / 2) {
      return Math.max(1, Math.floor(logicalCores / 2));
    }
    
    return logicalCores;
  }

  // Get optimal thread count for llama.cpp
  // GPU mode: fewer threads to avoid CPU-GPU contention (physical/2)
  // CPU mode: use physical cores directly
  function getOptimalThreads(isGpuMode) {
    const physicalCores = getPhysicalCores();
    if (isGpuMode) {
      // llama.cpp benchmark: 4 threads on 7-core CPU + GPU = 9.1 t/s (optimal)
      // vs 7 threads = 8.7 t/s (oversaturated)
      return Math.max(1, Math.floor(physicalCores / 2));
    }
    return Math.max(1, physicalCores);
  }

  function getCpuSample() {
    return os.cpus().reduce((acc, cpu) => {
      const times = cpu.times;
      acc.idle += times.idle;
      acc.total += times.user + times.nice + times.sys + times.idle + times.irq;
      return acc;
    }, { idle: 0, total: 0 });
  }

  function getCpuUsagePercent() {
    const current = getCpuSample();
    if (!lastCpuSample) {
      lastCpuSample = current;
      return 0;
    }

    const idleDelta = current.idle - lastCpuSample.idle;
    const totalDelta = current.total - lastCpuSample.total;
    lastCpuSample = current;

    if (totalDelta <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10));
  }

  function hasVulkanRuntime() {
    if (osPlatform !== "win32") return true;
    try {
      const sysPaths = [
        path.join(process.env.SystemRoot || "C:\\Windows", "System32", "vulkan-1.dll"),
        path.join(process.env.SystemRoot || "C:\\Windows", "SysWOW64", "vulkan-1.dll"),
      ];
      for (const dllPath of sysPaths) {
        if (fs.existsSync(dllPath)) return true;
      }
      try {
        execSync("where vulkan-1.dll", { stdio: "ignore" });
        return true;
      } catch (_) {}
    } catch (_) {}
    return false;
  }

  function detectLinuxGpuFromSysfs() {
    try {
      const pciDir = "/sys/bus/pci/devices";
      if (!fs.existsSync(pciDir)) return null;
      const entries = fs.readdirSync(pciDir);
      for (const entry of entries) {
        const vendorFile = path.join(pciDir, entry, "vendor");
        const deviceFile = path.join(pciDir, entry, "device");
        if (!fs.existsSync(vendorFile)) continue;
        const vendor = fs.readFileSync(vendorFile, "utf8").trim();
        let device = "";
        try { device = fs.readFileSync(deviceFile, "utf8").trim(); } catch (_) {}
        if (vendor === "0x10de") {
          return { name: `NVIDIA GPU (${device || entry})` };
        }
        if (vendor === "0x1002") {
          return { name: `AMD GPU (${device || entry})` };
        }
        if (vendor === "0x8086") {
          return { name: `Intel GPU (${device || entry})` };
        }
      }
    } catch (_) {}
    return null;
  }

  function isVirtualOrSoftwareGpu(name) {
    const lowercase = String(name || "").toLowerCase();
    return lowercase.includes("virtual desktop") ||
           lowercase.includes("remote display") ||
           lowercase.includes("microsoft basic render") ||
           lowercase.includes("citrix") ||
           lowercase.includes("software rasterizer") ||
           lowercase.includes("virtualbox") ||
           lowercase.includes("vmware");
  }

  let cachedPreferredVulkanBackend = null;
  let cachedPreferredVulkanBackendChecked = false;
  function getPreferredVulkanBackendName() {
    const explicit = String(process.env.SD_VULKAN_DEVICE || process.env.UAIS_VULKAN_DEVICE || "").trim();
    if (/^vulkan\d+$/i.test(explicit)) return explicit.toLowerCase();
    if (/^\d+$/.test(explicit)) return `vulkan${explicit}`;

    if (cachedPreferredVulkanBackendChecked) return cachedPreferredVulkanBackend || "vulkan0";
    cachedPreferredVulkanBackendChecked = true;
    cachedPreferredVulkanBackend = "vulkan0";

    if (osPlatform !== "linux") return cachedPreferredVulkanBackend;
    try {
      const result = spawnSync("vulkaninfo", ["--summary"], {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      const output = `${result.stdout || ""}\n${result.stderr || ""}`;
      const devices = [];
      let current = null;
      for (const line of output.split(/\r?\n/)) {
        const gpuMatch = line.match(/^\s*GPU(\d+)\s*:/i);
        if (gpuMatch) {
          current = { index: Number(gpuMatch[1]), name: "", type: "" };
          devices.push(current);
          continue;
        }
        if (!current) continue;
        const nameMatch = line.match(/deviceName\s*=\s*(.+)$/i);
        if (nameMatch) current.name = nameMatch[1].trim();
        const typeMatch = line.match(/deviceType\s*=\s*(.+)$/i);
        if (typeMatch) current.type = typeMatch[1].trim();
      }
      const usable = devices.filter((device) => Number.isInteger(device.index) && !isVirtualOrSoftwareGpu(device.name));
      const discrete = usable.find((device) => /discrete/i.test(device.type));
      const amd = usable.find((device) => /amd|radeon/i.test(device.name));
      const selected = discrete || amd || usable[0];
      if (selected) cachedPreferredVulkanBackend = `vulkan${selected.index}`;
    } catch (_) {}

    return cachedPreferredVulkanBackend;
  }

  let cachedLlamaCudaGpu = null;
  let cachedLlamaCudaGpuChecked = false;
  function detectLlamaCudaGpu() {
    if (cachedLlamaCudaGpuChecked) return cachedLlamaCudaGpu;
    cachedLlamaCudaGpuChecked = true;

    const backendPath = osPlatform === "win32"
      ? LLM_BACKEND_PATHS.winCuda
      : osPlatform === "linux"
        ? LLM_BACKEND_PATHS.linuxCuda
        : "";
    if (!backendPath || !fs.existsSync(backendPath)) return null;

    try {
      const result = spawnSync(backendPath, ["--list-devices"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });
      const output = `${result.stdout || ""}\n${result.stderr || ""}`;
      const devices = [];
      const devicePattern = /CUDA\d+\s*:\s*(.+?)\s+\(([\d.]+)\s+MiB(?:,\s*([\d.]+)\s+MiB free)?\)/gi;
      let match;
      while ((match = devicePattern.exec(output)) !== null) {
        devices.push({
          name: match[1].trim(),
          vram_gb: Math.round((Number(match[2]) / 1024) * 100) / 100,
          free_vram_gb: match[3] ? Math.round((Number(match[3]) / 1024) * 100) / 100 : null,
        });
      }
      let activeDevices = devices.filter(d => !isVirtualOrSoftwareGpu(d.name));
      if (activeDevices.length === 0) {
        activeDevices = devices;
      }
      cachedLlamaCudaGpu = activeDevices.sort((a, b) => b.vram_gb - a.vram_gb)[0] || null;
    } catch (_) {
      cachedLlamaCudaGpu = null;
    }
    return cachedLlamaCudaGpu;
  }

  let cachedLlamaVulkanGpu = null;
  let cachedLlamaVulkanGpuChecked = false;
  function detectLlamaVulkanGpu() {
    if (cachedLlamaVulkanGpuChecked) return cachedLlamaVulkanGpu;
    cachedLlamaVulkanGpuChecked = true;

    const backendPath = osPlatform === "win32"
      ? LLM_BACKEND_PATHS.winVulkan
      : osPlatform === "linux"
        ? LLM_BACKEND_PATHS.linuxVulkan
        : "";
    if (!backendPath || !fs.existsSync(backendPath)) return null;

    try {
      const result = spawnSync(backendPath, ["--list-devices"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });
      const output = `${result.stdout || ""}\n${result.stderr || ""}`;
      const devices = [];
      const devicePattern = /Vulkan\d+\s*:\s*(.+?)\s+\(([\d.]+)\s+MiB(?:,\s*([\d.]+)\s+MiB free)?\)/gi;
      let match;
      while ((match = devicePattern.exec(output)) !== null) {
        devices.push({
          name: match[1].trim(),
          vram_gb: Math.round((Number(match[2]) / 1024) * 100) / 100,
          free_vram_gb: match[3] ? Math.round((Number(match[3]) / 1024) * 100) / 100 : null,
        });
      }
      let activeDevices = devices.filter(d => !isVirtualOrSoftwareGpu(d.name));
      if (activeDevices.length === 0) {
        activeDevices = devices;
      }
      cachedLlamaVulkanGpu = activeDevices.sort((a, b) => b.vram_gb - a.vram_gb)[0] || null;
    } catch (_) {
      cachedLlamaVulkanGpu = null;
    }
    return cachedLlamaVulkanGpu;
  }

  let cachedLlamaSyclGpu = null;
  let cachedLlamaSyclGpuChecked = false;
  function detectLlamaSyclGpu() {
    if (cachedLlamaSyclGpuChecked) return cachedLlamaSyclGpu;
    cachedLlamaSyclGpuChecked = true;

    const backendPath = osPlatform === "win32"
      ? LLM_BACKEND_PATHS.winSycl
      : osPlatform === "linux"
        ? LLM_BACKEND_PATHS.linuxSycl
        : "";
    if (!backendPath || !fs.existsSync(backendPath)) return null;

    try {
      const result = spawnSync(backendPath, ["--list-devices"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });
      const output = `${result.stdout || ""}\n${result.stderr || ""}`;
      const devices = [];
      const devicePattern = /SYCL\d+\s*:\s*(.+?)\s+\(([\d.]+)\s+MiB(?:,\s*([\d.]+)\s+MiB free)?\)/gi;
      let match;
      while ((match = devicePattern.exec(output)) !== null) {
        devices.push({
          name: match[1].trim(),
          vram_gb: Math.round((Number(match[2]) / 1024) * 100) / 100,
          free_vram_gb: match[3] ? Math.round((Number(match[3]) / 1024) * 100) / 100 : null,
        });
      }
      cachedLlamaSyclGpu = devices.sort((a, b) => b.vram_gb - a.vram_gb)[0] || null;
    } catch (_) {
      cachedLlamaSyclGpu = null;
    }
    return cachedLlamaSyclGpu;
  }

  function getGpuInfo() {
    if (cachedGpuInfo) return cachedGpuInfo;

    if (osPlatform === "win32" || osPlatform === "linux") {
      const llamaCudaGpu = detectLlamaCudaGpu();
      if (llamaCudaGpu) {
        cachedGpuInfo = llamaCudaGpu;
        return cachedGpuInfo;
      }

      const llamaVulkanGpu = detectLlamaVulkanGpu();
      if (llamaVulkanGpu) {
        cachedGpuInfo = llamaVulkanGpu;
        return cachedGpuInfo;
      }

      try {
        const stdout = execSync(
          'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | ForEach-Object { [PSCustomObject]@{ Name = $_.Name; VRAM = [math]::Round($_.AdapterRAM / 1GB, 2) } } | ConvertTo-Json"',
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
        ).trim();
        if (stdout) {
          let gpus = [];
          try {
            const parsed = JSON.parse(stdout);
            if (Array.isArray(parsed)) {
              gpus = parsed;
            } else if (parsed && typeof parsed === "object") {
              gpus = [parsed];
            }
          } catch (_) {}

          if (gpus.length > 0) {
            const discreteKeywords = ["nvidia", "amd", "arc", "geforce", "radeon", "rtx", "gtx"];
            let activeGpus = gpus.filter(gpu => !isVirtualOrSoftwareGpu(gpu.Name));
            if (activeGpus.length === 0) {
              activeGpus = gpus;
            }
            let selectedGpu = activeGpus.find(gpu => {
              const name = String(gpu.Name || "").toLowerCase();
              return discreteKeywords.some(kw => name.includes(kw));
            });
            if (!selectedGpu) {
              selectedGpu = activeGpus[0];
            }
            cachedGpuInfo = {
              name: selectedGpu.Name || "Unknown GPU",
              vram_gb: typeof selectedGpu.VRAM === "number" ? selectedGpu.VRAM : 0
            };
            return cachedGpuInfo;
          }
        }
      } catch (_) {}
      // Fallback if Powershell fails or returns empty
      try {
        const output = execSync(
          "powershell -NoProfile -Command \"Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name\"",
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
        if (output) {
          cachedGpuInfo = { name: output, vram_gb: 0 };
          return cachedGpuInfo;
        }
      } catch (_) {}
    }

    if (osPlatform === "darwin") {
      try {
        const output = execSync("system_profiler SPDisplaysDataType", {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        const lines = output.split("\n");
        let currentGpu = null;
        const gpus = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("Chipset Model:")) {
            if (currentGpu) {
              gpus.push(currentGpu);
            }
            currentGpu = {
              name: trimmed.substring("Chipset Model:".length).trim(),
              vram_gb: 0,
            };
          } else if (currentGpu && (trimmed.startsWith("VRAM (Total):") || trimmed.startsWith("VRAM (Dynamic, Max):"))) {
            const valStr = trimmed.split(":")[1].trim(); // e.g. "2 GB" or "1536 MB"
            let bytesVal = 0;
            const numMatch = valStr.match(/^([\d\.]+)\s*(GB|MB)/i);
            if (numMatch) {
              const val = parseFloat(numMatch[1]);
              const unit = numMatch[2].toUpperCase();
              if (unit === "GB") {
                bytesVal = val;
              } else if (unit === "MB") {
                bytesVal = val / 1024;
              }
            }
            currentGpu.vram_gb = Math.round(bytesVal * 100) / 100;
          }
        }
        if (currentGpu) {
          gpus.push(currentGpu);
        }

        if (gpus.length > 0) {
          const isAppleSilicon = gpus.some(g => {
            const name = g.name.toLowerCase();
            return name.includes("apple") || name.includes("m1") || name.includes("m2") || name.includes("m3") || name.includes("m4");
          }) || (os.arch() === "arm64");

          if (isAppleSilicon) {
            const totalRamGb = Math.round((os.totalmem() / (1024 ** 3)) * 100) / 100;
            let selected = gpus.find(g => g.name.toLowerCase().includes("apple")) || gpus[0];
            cachedGpuInfo = {
              name: selected.name,
              vram_gb: totalRamGb
            };
            return cachedGpuInfo;
          } else {
            const discreteKeywords = ["nvidia", "amd", "radeon", "geforce"];
            let selected = gpus.find(gpu => {
              const name = gpu.name.toLowerCase();
              return discreteKeywords.some(kw => name.includes(kw));
            });
            if (!selected) {
              selected = gpus[0];
            }
            cachedGpuInfo = {
              name: selected.name,
              vram_gb: selected.vram_gb
            };
            return cachedGpuInfo;
          }
        }
      } catch (_) {}
      // Fallback if system_profiler command fails
      const totalRamGb = Math.round((os.totalmem() / (1024 ** 3)) * 100) / 100;
      cachedGpuInfo = { name: "Apple Metal GPU", vram_gb: totalRamGb };
      return cachedGpuInfo;
    }

    if (osPlatform === "linux") {
      // AMD cards: Scan /sys/class/drm/card*/device/vendor and mem_info_vram_total
      try {
        if (fs.existsSync("/sys/class/drm")) {
          const cards = fs.readdirSync("/sys/class/drm").filter(name => name.startsWith("card"));
          for (const card of cards) {
            const vendorPath = `/sys/class/drm/${card}/device/vendor`;
            const vramPath = `/sys/class/drm/${card}/device/mem_info_vram_total`;
            if (fs.existsSync(vendorPath) && fs.existsSync(vramPath)) {
              const vendor = fs.readFileSync(vendorPath, "utf8").trim();
              if (vendor === "0x1002") {
                const vramBytesStr = fs.readFileSync(vramPath, "utf8").trim();
                const vramBytes = parseFloat(vramBytesStr);
                if (!isNaN(vramBytes)) {
                  cachedGpuInfo = {
                    name: "AMD Radeon GPU",
                    vram_gb: Math.round((vramBytes / (1024 ** 3)) * 100) / 100
                  };
                  return cachedGpuInfo;
                }
              }
            }
          }
        }
      } catch (_) {}

      // NVIDIA cards: read /proc/driver/nvidia/gpus/*/information or run nvidia-smi
      try {
        if (fs.existsSync("/proc/driver/nvidia/gpus")) {
          const gpuDirs = fs.readdirSync("/proc/driver/nvidia/gpus");
          for (const gpuDir of gpuDirs) {
            const infoPath = `/proc/driver/nvidia/gpus/${gpuDir}/information`;
            if (fs.existsSync(infoPath)) {
              const info = fs.readFileSync(infoPath, "utf8");
              const modelMatch = info.match(/Model:\s+(.*)/);
              if (modelMatch) {
                const modelName = modelMatch[1].trim();
                let vram_gb = 0;
                try {
                  const smiOut = execSync("nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits", {
                    encoding: "utf8",
                    stdio: ["ignore", "pipe", "ignore"]
                  }).trim();
                  const parsedVal = parseFloat(smiOut);
                  if (!isNaN(parsedVal)) {
                    vram_gb = Math.round((parsedVal / 1024) * 100) / 100;
                  }
                } catch (_) {}
                cachedGpuInfo = {
                  name: modelName,
                  vram_gb: vram_gb || 8.0
                };
                return cachedGpuInfo;
              }
            }
          }
        }
      } catch (_) {}

      try {
        const smiOut = execSync("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits", {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"]
        }).trim();
        if (smiOut) {
          const lines = smiOut.split("\n");
          if (lines[0]) {
            const [name, totalMb] = lines[0].split(",").map(p => p.trim());
            const parsedVal = parseFloat(totalMb);
            cachedGpuInfo = {
              name: name || "NVIDIA GPU",
              vram_gb: !isNaN(parsedVal) ? Math.round((parsedVal / 1024) * 100) / 100 : 8.0
            };
            return cachedGpuInfo;
          }
        }
      } catch (_) {}

      const linuxGpu = detectLinuxGpuFromSysfs();
      if (linuxGpu) {
        cachedGpuInfo = {
          name: linuxGpu.name,
          vram_gb: 0
        };
        return cachedGpuInfo;
      }
    }

    cachedGpuInfo = { name: "Unavailable", vram_gb: 0 };
    return cachedGpuInfo;
  }

  // ── NPU Detection ─────────────────────────────────────────────────────────────
  let cachedNpuInfo = null;
  let cachedHasNpuHardware = null;

  function hasNpuHardware() {
    if (cachedHasNpuHardware !== null) return cachedHasNpuHardware;

    if (osPlatform !== "win32" && osPlatform !== "linux") {
      cachedHasNpuHardware = false;
      return cachedHasNpuHardware;
    }

    try {
      if (osPlatform === "win32") {
        const deviceResult = spawnSync("wmic", [
          "path", "win32_pnpentity", "where", "Name like '%NPU%' or Name like '%Intel%AI%' or Name like '%VPU%'", "get", "Name", "/value"
        ], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
        if (deviceResult.status === 0 && deviceResult.stdout && /NPU|AI Boost|VPU/i.test(deviceResult.stdout)) {
          cachedHasNpuHardware = true;
          return cachedHasNpuHardware;
        }

        const cpuResult = spawnSync("wmic", ["cpu", "get", "Name", "/value"], {
          encoding: "utf8",
          timeout: 10000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (cpuResult.status === 0 && cpuResult.stdout) {
          const cpuName = cpuResult.stdout.toLowerCase();
          if (cpuName.includes("ultra") && (cpuName.match(/ultra\s*\d/) || cpuName.includes("core(tm) ultra"))) {
            cachedHasNpuHardware = true;
            return cachedHasNpuHardware;
          }
        }
      } else if (osPlatform === "linux") {
        const lspciResult = spawnSync("lspci", [], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
        if (lspciResult.status === 0 && lspciResult.stdout && lspciResult.stdout.toLowerCase().includes("npu")) {
          cachedHasNpuHardware = true;
          return cachedHasNpuHardware;
        }

        try {
          const sysPci = fs.readdirSync("/sys/bus/pci/devices");
          for (const dev of sysPci) {
            const vendorPath = `/sys/bus/pci/devices/${dev}/vendor`;
            const classPath = `/sys/bus/pci/devices/${dev}/class`;
            if (!fs.existsSync(vendorPath) || !fs.existsSync(classPath)) continue;
            const vendor = fs.readFileSync(vendorPath, "utf8").trim();
            const devClass = fs.readFileSync(classPath, "utf8").trim();
            if (vendor === "0x8086" && (devClass.includes("1180") || devClass.includes("acce"))) {
              cachedHasNpuHardware = true;
              return cachedHasNpuHardware;
            }
          }
        } catch (_) {}

        try {
          const cpuInfo = fs.readFileSync("/proc/cpuinfo", "utf8").toLowerCase();
          if (cpuInfo.includes("ultra") && cpuInfo.includes("intel")) {
            cachedHasNpuHardware = true;
            return cachedHasNpuHardware;
          }
        } catch (_) {}
      }
    } catch (_) {}

    cachedHasNpuHardware = false;
    return cachedHasNpuHardware;
  }

  function detectNpu() {
    if (cachedNpuInfo !== null) return cachedNpuInfo;
    cachedNpuInfo = { detected: false, vendor: null, name: null };
    
    if (osPlatform === "win32") {
      try {
        const output = execSync(
          'powershell -NoProfile -Command "Get-PnpDevice | Where-Object { $_.FriendlyName -match \'Intel.*NPU\' -or $_.FriendlyName -match \'Neural\' } | Select-Object -First 1 FriendlyName"',
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }
        ).trim();
        if (output && output.includes("NPU")) {
          cachedNpuInfo = { detected: true, vendor: "intel", name: output.trim() };
        }
      } catch (_) {}
    } else if (osPlatform === "linux") {
      try {
        const output = execSync("lspci | grep -i 'neural\|npu' || true", {
          encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000
        }).trim();
        if (output) {
          const isIntel = output.toLowerCase().includes("intel");
          cachedNpuInfo = { 
            detected: true, 
            vendor: isIntel ? "intel" : "unknown", 
            name: output.split("\n")[0].trim() 
          };
        }
      } catch (_) {}
    }
    // macOS: Apple Silicon Neural Engine is part of the SoC, not a separate NPU device
    return cachedNpuInfo;
  }

  let nvidiaSmiCmd = "nvidia-smi";
  let hasNvidiaSmi = null;

  if (osPlatform === "win32") {
    const commonPath = "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe";
    if (fs.existsSync(commonPath)) {
      nvidiaSmiCmd = `"${commonPath}"`;
    }
  }

  let isPollingVram = false;
  let lastVramPollTime = 0;

  function pollNvidiaVram(force = false) {
    if (isPollingVram) return;
    if (hasNvidiaSmi === false) return;

    const now = Date.now();
    // If not forced, skip if backend is running (driver queries conflict & cause display lag),
    // or if it has been polled too recently
    if (!force) {
      if (getBackendProc() !== null) {
        return;
      }
      if (now - lastVramPollTime < 4500) {
        return;
      }
    }

    isPollingVram = true;
    lastVramPollTime = now;
    const cmd = `${nvidiaSmiCmd} --query-gpu=name,memory.used,memory.total --format=csv,noheader,nounits`;
    exec(
      cmd,
      { stdio: ["ignore", "pipe", "ignore"] },
      (error, stdout) => {
        isPollingVram = false;
        if (error) {
          // Only permanently disable if we are not currently running a backend workload
          if (getBackendProc() === null) {
            hasNvidiaSmi = false;
          }
          cachedVramInfo = null;
          return;
        }
        hasNvidiaSmi = true;
        const output = (stdout || "").trim();
        const firstLine = output.split(/\r?\n/)[0];
        if (!firstLine) {
          cachedVramInfo = null;
          return;
        }

        const [name, usedMb, totalMb] = firstLine.split(",").map(part => part.trim());
        cachedVramInfo = {
          gpu_name: name || getGpuInfo().name,
          vram_used_gb: Math.round((parseFloat(usedMb) / 1024) * 100) / 100,
          vram_total_gb: Math.round((parseFloat(totalMb) / 1024) * 100) / 100,
        };
      }
    );
  }

  function getNvidiaVram() {
    return cachedVramInfo;
  }

  let cachedLlamaVramInfo = null;
  let isPollingLlamaVram = false;
  let lastLlamaVramPollTime = 0;

  function parseLlamaDeviceMemory(output) {
    const devices = [];
    const devicePattern = /(CUDA|Vulkan|SYCL)\d+\s*:\s*(.+?)\s+\(([\d.]+)\s+MiB(?:,\s*([\d.]+)\s+MiB free)?\)/gi;
    let match;
    while ((match = devicePattern.exec(output || "")) !== null) {
      const totalMiB = Number(match[3]);
      const freeMiB = match[4] ? Number(match[4]) : NaN;
      if (!Number.isFinite(totalMiB) || totalMiB <= 0) continue;

      const usedMiB = Number.isFinite(freeMiB) ? Math.max(0, totalMiB - freeMiB) : 0;
      devices.push({
        gpu_name: match[2].trim(),
        vram_used_gb: Math.round((usedMiB / 1024) * 100) / 100,
        vram_total_gb: Math.round((totalMiB / 1024) * 100) / 100,
      });
    }
    return devices.sort((a, b) => b.vram_total_gb - a.vram_total_gb)[0] || null;
  }

  function getLlamaTelemetryBackendPath() {
    if (osPlatform === "win32") {
      if (fs.existsSync(LLM_BACKEND_PATHS.winVulkan)) return LLM_BACKEND_PATHS.winVulkan;
      if (fs.existsSync(LLM_BACKEND_PATHS.winSycl)) return LLM_BACKEND_PATHS.winSycl;
      if (fs.existsSync(LLM_BACKEND_PATHS.winHip)) return LLM_BACKEND_PATHS.winHip;
      if (fs.existsSync(LLM_BACKEND_PATHS.winCuda)) return LLM_BACKEND_PATHS.winCuda;
    } else if (osPlatform === "linux") {
      if (fs.existsSync(LLM_BACKEND_PATHS.linuxVulkan)) return LLM_BACKEND_PATHS.linuxVulkan;
      if (fs.existsSync(LLM_BACKEND_PATHS.linuxSycl)) return LLM_BACKEND_PATHS.linuxSycl;
      if (fs.existsSync(LLM_BACKEND_PATHS.linuxRocm)) return LLM_BACKEND_PATHS.linuxRocm;
      if (fs.existsSync(LLM_BACKEND_PATHS.linuxCuda)) return LLM_BACKEND_PATHS.linuxCuda;
    }
    return null;
  }

  function pollLlamaVram(force = false) {
    if (isPollingLlamaVram) return;

    const now = Date.now();
    if (!force && now - lastLlamaVramPollTime < 4500) {
      return;
    }

    const backendPath = getLlamaTelemetryBackendPath();
    if (!backendPath) return;

    isPollingLlamaVram = true;
    lastLlamaVramPollTime = now;
    execFile(
      backendPath,
      ["--list-devices"],
      { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        isPollingLlamaVram = false;
        if (error) {
          cachedLlamaVramInfo = null;
          return;
        }
        cachedLlamaVramInfo = parseLlamaDeviceMemory(`${stdout || ""}\n${stderr || ""}`);
      }
    );
  }

  function getLlamaVram() {
    return cachedLlamaVramInfo;
  }

  let cachedMacRamUsedGb = null;
  function pollMacRam() {
    if (osPlatform !== "darwin") return;
    exec("vm_stat", (err, stdout) => {
      if (err) return;
      try {
        const vmStat = stdout.toString();
        const pageSizeMatch = vmStat.match(/page size of (\d+) bytes/);
        const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 4096;

        const getVal = (key) => {
          const match = vmStat.match(new RegExp(key + ":\\s+(\\d+)\\."));
          return match ? parseInt(match[1], 10) : 0;
        };

        const freePages = getVal("Pages free");
        const inactivePages = getVal("Pages inactive");
        const speculativePages = getVal("Pages speculative");
        
        const totalFreeBytes = (freePages + inactivePages + speculativePages) * pageSize;
        cachedMacRamUsedGb = roundGb(os.totalmem() - totalFreeBytes);
      } catch (e) {
        // Ignore parsing errors
      }
    });
  }

  function getHardwareSpecs() {
    const cpus = os.cpus();
    const gpu = getGpuInfo();
    const ramTotalGb = roundGb(os.totalmem());
    const gpuVramGb = gpu.vram_gb || 0;
    const physicalCores = getPhysicalCores();
    const logicalCores = cpus.length;
    const npuInfo = detectNpu();

    // Tiering logic
    let tier = "low";
    let tierReason = "";

    const isAppleSilicon = osPlatform === "darwin" && (os.arch() === "arm64" || String(cpus[0]?.model || "").toLowerCase().includes("apple"));

    if (isAppleSilicon) {
      if (ramTotalGb >= 16) {
        tier = "high";
        tierReason = `Apple Silicon Mac with ${ramTotalGb} GB unified memory.`;
      } else if (ramTotalGb >= 8) {
        tier = "mid";
        tierReason = `Apple Silicon Mac with ${ramTotalGb} GB unified memory.`;
      } else {
        tier = "low";
        tierReason = `Apple Silicon Mac with ${ramTotalGb} GB unified memory.`;
      }
    } else {
      if (gpuVramGb >= 12) {
        tier = "high";
        tierReason = `Discrete GPU with ${gpuVramGb} GB VRAM.`;
      } else if (gpuVramGb >= 6) {
        tier = "mid";
        tierReason = `GPU with ${gpuVramGb} GB VRAM.`;
      } else {
        tier = "low";
        tierReason = `GPU with ${gpuVramGb} GB VRAM and ${ramTotalGb} GB RAM.`;
      }
    }

    // Recommended text settings per tier
    const recommendedTextSettings = {
      low: {
        contextSize: 2048,
        threads: Math.max(1, physicalCores),
        gpuLayers: 0,
        cacheTypeK: "q4_0",
        cacheTypeV: "q4_0",
        flashAttn: true,
        mlock: true,
        mmap: true,
        cachePrompt: true,
        batchSize: 256,
        ubatchSize: 256,
        performanceProfile: "potato",
      },
      mid: {
        contextSize: 4096,
        threads: Math.max(1, Math.floor(physicalCores / 2)),
        gpuLayers: -1,
        cacheTypeK: "q8_0",
        cacheTypeV: "q8_0",
        flashAttn: true,
        mlock: false,
        mmap: true,
        cachePrompt: true,
        batchSize: 512,
        ubatchSize: 512,
        performanceProfile: "balanced",
      },
      high: {
        contextSize: 8192,
        threads: Math.max(1, Math.floor(physicalCores / 2)),
        gpuLayers: -1,
        cacheTypeK: "q8_0",
        cacheTypeV: "q8_0",
        flashAttn: true,
        mlock: false,
        mmap: true,
        cachePrompt: true,
        batchSize: 1024,
        ubatchSize: 1024,
        performanceProfile: "high",
      },
    };

    // Recommended models catalog matching contract exactly
    let recommended_models = [];
    if (tier === "high") {
      recommended_models = [
        {
          name: "Llama 3 8B Instruct (Q8_0)",
          filename: "Meta-Llama-3-8B-Instruct-Q8_0.gguf",
          approxSize: "8.5 GB",
          url: "https://huggingface.co/QuantFactory/Meta-Llama-3-8B-Instruct-GGUF/resolve/main/Meta-Llama-3-8B-Instruct-Q8_0.gguf",
          notes: "Near-lossless precision for high quality responses.",
          reason: tierReason
        },
        {
          name: "Mistral 7B Instruct v0.3 (Q8_0)",
          filename: "Mistral-7B-Instruct-v0.3.Q8_0.gguf",
          approxSize: "7.7 GB",
          url: "https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3.Q8_0.gguf",
          notes: "Superb instruction-following and context window size.",
          reason: tierReason
        }
      ];
    } else if (tier === "mid") {
      recommended_models = [
        {
          name: "Llama 3 8B Instruct (Q4_K_M)",
          filename: "Meta-Llama-3-8B-Instruct-Q4_K_M.gguf",
          approxSize: "4.8 GB",
          url: "https://huggingface.co/QuantFactory/Meta-Llama-3-8B-Instruct-GGUF/resolve/main/Meta-Llama-3-8B-Instruct-Q4_K_M.gguf",
          notes: "Great balance of speed and performance.",
          reason: tierReason
        },
        {
          name: "Phi-3 Mini Instruct (Q4_K_M)",
          filename: "Phi-3-mini-4k-instruct-q4.gguf",
          approxSize: "2.2 GB",
          url: "https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf",
          notes: "Lightweight and fast, optimized by Microsoft.",
          reason: tierReason
        }
      ];
    } else {
      recommended_models = [
        {
          name: "Qwen 2.5 Coder 0.5B Instruct (Q4_K_M)",
          filename: "qwen2.5-coder-0.5b-instruct-q4_k_m.gguf",
          approxSize: "491 MB",
          url: "https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf",
          notes: "Extremely fast, lightweight assistant, perfect for low RAM/VRAM machines.",
          reason: tierReason
        },
        {
          name: "SmolLM2 1.7B Instruct (Q4_K_M)",
          filename: "smollm2-1.7b-instruct-q4_k_m.gguf",
          approxSize: "1.1 GB",
          url: "https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF/resolve/main/smollm2-1.7b-instruct-q4_k_m.gguf",
          notes: "Excellent lightweight assistant with strong logic, reasoning, and prompt expansion capabilities.",
          reason: tierReason
        }
      ];
    }

    return {
      os_name: `${os.type()} ${os.release()}`,
      cpu_name: cpus[0]?.model || "Unavailable",
      cpu_cores_physical: physicalCores,
      cpu_cores_logical: logicalCores,
      ram_total_gb: ramTotalGb,
      gpu_name: gpu.name,
      gpu_vram_gb: gpuVramGb,
      npu: npuInfo,
      tier,
      recommended_models,
      recommended_text_settings: recommendedTextSettings[tier] || recommendedTextSettings.mid,
    };
  }

  function getTelemetry() {
    const vram = getNvidiaVram();
    const llamaVram = vram || getLlamaVram();
    let ram_used_gb = roundGb(os.totalmem() - os.freemem());
    if (osPlatform === "darwin" && cachedMacRamUsedGb !== null) {
      ram_used_gb = cachedMacRamUsedGb;
    }
    const gpu = getGpuInfo();
    return {
      cpu_usage: getCpuUsagePercent(),
      ram_used_gb,
      ram_total_gb: roundGb(os.totalmem()),
      gpu_name: llamaVram?.gpu_name || gpu.name,
      vram_used_gb: Number.isFinite(Number(llamaVram?.vram_used_gb)) ? llamaVram.vram_used_gb : 0,
      vram_total_gb: llamaVram?.vram_total_gb || gpu.vram_gb || 0,
    };
  }

  let cachedOpenVinoNpuInfo = null;

  function getOpenVinoNpuInfo() {
    if (cachedOpenVinoNpuInfo) return cachedOpenVinoNpuInfo;

    if (osPlatform !== "win32" && osPlatform !== "linux") {
      cachedOpenVinoNpuInfo = { supported: false, reason: "OpenVINO NPU backend is supported on Windows and Linux Intel Core Ultra systems." };
      return cachedOpenVinoNpuInfo;
    }
    const python = getOpenVinoPython();
    if (!python) {
      const setupScript = osPlatform === "win32"
        ? "scripts/setup/setup-openvino-npu.ps1"
        : "bash scripts/setup/setup-openvino-npu.sh";
      cachedOpenVinoNpuInfo = {
        supported: false,
        reason: `OpenVINO GenAI runtime is not installed. Run ${setupScript} first.`,
      };
      return cachedOpenVinoNpuInfo;
    }
    try {
      const script = [
        "import json, openvino as ov",
        "core=ov.Core()",
        "devices=core.available_devices",
        "info={'devices':devices,'npu':None}",
        "if 'NPU' in devices:",
        "    info['npu']={'name':core.get_property('NPU','FULL_DEVICE_NAME'),'capabilities':core.get_property('NPU','OPTIMIZATION_CAPABILITIES')}",
        "print(json.dumps(info))",
      ].join("\n");
      const result = spawnSync(python, ["-c", script], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
      if (result.status !== 0) {
        cachedOpenVinoNpuInfo = { supported: false, python, reason: result.stderr.trim() || "OpenVINO NPU probe failed." };
        return cachedOpenVinoNpuInfo;
      }
      const info = JSON.parse(result.stdout.trim());
      if (!info.devices.includes("NPU")) {
        cachedOpenVinoNpuInfo = { supported: false, python, reason: `OpenVINO is installed, but NPU is not available. Devices: ${info.devices.join(", ")}` };
        return cachedOpenVinoNpuInfo;
      }
      cachedOpenVinoNpuInfo = { supported: true, platform: osPlatform, python, devices: info.devices, npu: info.npu };
      return cachedOpenVinoNpuInfo;
    } catch (err) {
      cachedOpenVinoNpuInfo = { supported: false, python, reason: err.message || String(err) };
      return cachedOpenVinoNpuInfo;
    }
  }

  function getCoreMLNpuInfo() {
    const isAppleSilicon = osPlatform === "darwin" && os.arch() === "arm64";
    if (!isAppleSilicon) {
      return { supported: false, reason: "Apple Silicon ANE (NPU) is only available on Apple Silicon macOS devices." };
    }

    const pythonPath = getCoreMLPythonPath();
    if (!pythonPath) {
      return {
        supported: true,
        ready: false,
        reason: "CoreML Python environment is not set up. Run scripts/setup/setup-coreml-npu.sh first.",
      };
    }

    return {
      supported: true,
      ready: true,
      python: pythonPath,
    };
  }

  // ── Polling timers (moved from module load in serve.cjs; same order and period) ──
  let timers = [];
  function start() {
    if (timers.length) return;
    timers.push(setIntervalFn(() => pollNvidiaVram(false), 5000));
    pollNvidiaVram(true);
    timers.push(setIntervalFn(() => pollLlamaVram(false), 5000));
    pollLlamaVram(true);
    if (osPlatform === "darwin") {
      pollMacRam();
      timers.push(setIntervalFn(pollMacRam, 5000));
    }
  }
  function stop() {
    for (const t of timers) clearIntervalFn(t);
    timers = [];
  }

  // ── Read-only memory budget (for model loading and the future resource scheduler, Step 9.9) ──
  // Values come from the same sources as /api/telemetry; nothing here changes any state.
  const GB = 1024 ** 3;
  const budget = Object.freeze({
    totalRamBytes: () => os.totalmem(),
    freeRamBytes: () => {
      if (osPlatform === "darwin" && cachedMacRamUsedGb !== null) return Math.max(0, os.totalmem() - cachedMacRamUsedGb * GB);
      return os.freemem();
    },
    /** Total VRAM of the detected GPU in bytes, or 0 when none is known. */
    // The same choice as getTelemetry(): the NVIDIA poll, else the llama.cpp device poll, else the
    // detected GPU's total.
    totalVramBytes: () => {
      const vram = getNvidiaVram() || getLlamaVram();
      const gpu = getGpuInfo();
      return ((vram && vram.vram_total_gb) || (gpu && gpu.vram_gb) || 0) * GB;
    },
    /**
     * Free VRAM in bytes as reported by the last poll, or null when no poll has reported memory.
     * (llama.cpp builds that don't print free memory report used = 0, so free = total.)
     */
    freeVramBytes: () => {
      const vram = getNvidiaVram() || getLlamaVram();
      const total = Number(vram && vram.vram_total_gb);
      const used = Number(vram && vram.vram_used_gb);
      if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(used)) return null;
      return Math.max(0, (total - used) * GB);
    },
  });

  return {
    start,
    stop,
    activeTimers: () => timers.length,
    budget,
    // The functions serve.cjs used before the move, under their existing names.
    fns: { roundGb, getPhysicalCores, getOptimalThreads, getCpuSample, getCpuUsagePercent, hasVulkanRuntime, detectLinuxGpuFromSysfs, isVirtualOrSoftwareGpu, getPreferredVulkanBackendName, detectLlamaCudaGpu, detectLlamaVulkanGpu, detectLlamaSyclGpu, getGpuInfo, hasNpuHardware, detectNpu, pollNvidiaVram, getNvidiaVram, parseLlamaDeviceMemory, getLlamaTelemetryBackendPath, pollLlamaVram, getLlamaVram, pollMacRam, getHardwareSpecs, getTelemetry, getOpenVinoNpuInfo, getCoreMLNpuInfo },
  };
}

module.exports = { createHardwareService };
