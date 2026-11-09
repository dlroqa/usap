import React, { memo, useEffect, useState, useCallback, useRef } from "react";
import { Check, ChevronDown, DownloadCloud, RefreshCw } from "lucide-react";
import {
  stopServer,
  formatBytes,
  getLlmBackends,
  getLlmStats,
  getLlmStatus,
  benchmarkLlm,
  startLlm,
  stopLlm,
  downloadBackend,
  getDownloadProgress,
  getBackendOptions,
} from "../services/api";
import { THEMES } from "../themes";
import "../styles/settings.css";

const ASPECT_RATIOS = [
  { id: "1:1", label: "1:1 Square", width: 512, height: 512, sdxl_width: 1024, sdxl_height: 1024, desc: "Social posts & avatars" },
  { id: "4:3", label: "4:3 Photo", width: 640, height: 480, sdxl_width: 1152, sdxl_height: 864, desc: "Classic photo look" },
  { id: "16:9", label: "16:9 Landscape", width: 768, height: 432, sdxl_width: 1216, sdxl_height: 684, desc: "Widescreen landscape" },
  { id: "9:16", label: "9:16 Portrait", width: 432, height: 768, sdxl_width: 684, sdxl_height: 1216, desc: "Tall phone screen" }
];

const SECTIONS = [
  { id: "appearance", label: "Appearance" },
  { id: "image", label: "Image generation" },
  { id: "text", label: "Text generation" },
  { id: "speech", label: "Speech" },
  { id: "tts", label: "Voice" },
];

const SECTION_STORAGE_KEY = "settings_active_section";

const readStoredSection = () => {
  try {
    const saved = localStorage.getItem(SECTION_STORAGE_KEY);
    if (SECTIONS.some((s) => s.id === saved)) return saved;
  } catch (_) {}
  return "appearance";
};

const isSD15OrCustomModel = (modelName) => {
  if (!modelName) return true;
  const name = modelName.toLowerCase();
  if (name.includes("flux") || name.includes("schnell")) return false;
  if (name.includes("sdxl") || name.includes("lightning") || name.includes("turbo")) return false;
  if (name.includes("sd3")) return false;
  return true;
};

const getSliderStyle = (value, min, max) => {
  const v = Number(value);
  const mn = Number(min);
  const mx = Number(max);
  const pct = mx === mn ? 0 : ((v - mn) / (mx - mn)) * 100;
  return { "--value": `${Math.max(0, Math.min(100, pct))}%` };
};

// ─── Building blocks ───

// One setting: label + optional description on the left, control on the right.
// `wide` puts the control full width under the label (long text, tile grids).
function SettingRow({ title, description, htmlFor, wide = false, children }) {
  const Title = htmlFor ? "label" : "div";
  return (
    <li className={`row-item settings-row ${wide ? "settings-row-wide" : ""}`}>
      <div className="row-item-main">
        <Title className="row-item-title" {...(htmlFor ? { htmlFor } : {})}>{title}</Title>
        {description && <div className="row-item-meta">{description}</div>}
      </div>
      {children && <div className="settings-control">{children}</div>}
    </li>
  );
}

function Switch({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={Boolean(checked)}
      aria-label={label}
      className="settings-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="settings-switch-knob" aria-hidden="true" />
    </button>
  );
}

function Slider({ label, value, min, max, step = 1, onChange, display }) {
  return (
    <div className="settings-slider-wrap">
      <input
        type="range"
        className="settings-slider"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={onChange}
        style={getSliderStyle(value, min, max)}
      />
      <span className="settings-slider-value" aria-hidden="true">{display ?? value}</span>
    </div>
  );
}

function Choice({ label, options, value, onSelect }) {
  return (
    <div className="segmented settings-choice" role="group" aria-label={label}>
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          className="segmented-item"
          aria-pressed={value === opt.id}
          onClick={() => onSelect(opt.id)}
          disabled={opt.disabled}
          title={opt.title}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Select({ id, value, onChange, children }) {
  return (
    <span className="settings-select-wrap">
      <select id={id} className="settings-select" value={value} onChange={onChange}>
        {children}
      </select>
      <ChevronDown size={14} className="settings-select-chevron" aria-hidden="true" />
    </span>
  );
}

// ─── Hardware summary (top of Text generation) ───
const TIER_CONFIG = {
  high: { label: "High-end PC", profile: "high" },
  mid: { label: "Balanced PC", profile: "balanced" },
  low: { label: "Potato PC", profile: "potato" },
};

function HardwareSummary({ specs }) {
  if (!specs?.tier) return null;
  const tierKey = TIER_CONFIG[specs.tier] ? specs.tier : "low";
  const tier = TIER_CONFIG[tierKey];
  const recRaw = specs.recommended_text_settings;
  // Accept either a flat recommendation or one keyed by tier (low/mid/high).
  const rec = recRaw && recRaw.contextSize === undefined ? recRaw[tierKey] : recRaw;

  const parts = [
    specs.cpu_name,
    specs.cpu_cores_physical ? `${specs.cpu_cores_physical} cores` : null,
    specs.ram_total_gb ? `${specs.ram_total_gb} GB RAM` : null,
    specs.gpu_name && specs.gpu_name !== "Loading..." ? specs.gpu_name : null,
    specs.gpu_vram_gb > 0 ? `${specs.gpu_vram_gb} GB VRAM` : null,
  ].filter(Boolean);

  return (
    <div className="settings-summary">
      <div className="settings-summary-head">
        <span className={`settings-tier-dot tier-${tierKey}`} aria-hidden="true" />
        <span className="settings-summary-title">{tier.label}</span>
      </div>
      {parts.length > 0 && <div className="settings-summary-meta">{parts.join(" · ")}</div>}
      {rec && (
        <div className="settings-summary-tags" aria-label="Recommended settings">
          <span className="settings-summary-tags-label">Recommended</span>
          {rec.contextSize !== undefined && <span className="tag">Context {rec.contextSize}</span>}
          {rec.threads !== undefined && <span className="tag">Threads {rec.threads}</span>}
          {rec.cacheTypeK && <span className="tag">KV {rec.cacheTypeK}</span>}
          {rec.batchSize !== undefined && <span className="tag">Batch {rec.batchSize}</span>}
          <span className="tag">Profile {rec.performanceProfile || tier.profile}</span>
        </div>
      )}
    </div>
  );
}

// ─── Main Settings Component ───
function Settings({
  constraints,
  setConstraints,
  activeModel,
  specs,
  backendOptions,
  setBackendOptions,
  serverRunning,
  setServerRunning,
  setActiveModel,
  textSettings,
  setTextSettings,
  speechSettings,
  setSpeechSettings,
  ttsSettings,
  setTtsSettings,
  showAlert = async ({ message }) => window.alert(message),
  showConfirm = async ({ message }) => window.confirm(message),
  health,
  cleanupItems,
  isReadinessBusy,
  refreshReadiness,
  copyDiagnostics,
  cleanupSafeItems,
  diagnosticsCopied,
  theme,
  setTheme,
  fontSize,
  setFontSize,
}) {
  const [llmStatus, setLlmStatus] = useState({ ready: false, settings: {} });
  const [llmBackends, setLlmBackends] = useState({ available: [], candidates: [] });
  const [llmStats, setLlmStats] = useState({ benchmarks: [] });
  const [benchmarkBusy, setBenchmarkBusy] = useState(false);
  const [backendDownload, setBackendDownload] = useState({
    active: false,
    backendId: "",
    progress: 0,
    speed: "",
    error: null,
  });

  const [pendingTextSettings, setPendingTextSettings] = useState(textSettings || {});

  useEffect(() => {
    if (textSettings) {
      setPendingTextSettings(textSettings);
    }
  }, [textSettings]);

  const EDITABLE_TEXT_KEYS = [
    "systemPrompt", "contextSize", "temperature", "responseTokenMode", 
    "maxTokens", "seed", "performanceProfile", "threads", 
    "gpuLayers", "batchSize", "cacheTypeK", "cacheTypeV", "preferredBackend"
  ];

  const hasPendingChanges = textSettings && pendingTextSettings && EDITABLE_TEXT_KEYS.some(key => {
    return pendingTextSettings[key] !== textSettings[key];
  });

  const handleSaveTextSettings = async () => {
    try {
      setTextSettings(pendingTextSettings);
      if (llmStatus.ready) {
        await stopLlm();
        setLlmStatus((prev) => ({ ...prev, ready: false, running: false }));
        showAlert({
          title: "Text settings saved",
          message: "The running text model was unloaded so the new settings apply on the next load."
        });
      } else {
        showAlert({
          title: "Text settings saved",
          message: "The new settings apply the next time a text model loads."
        });
      }
    } catch (err) {
      showAlert({
        title: "Save Failed",
        message: err.message || String(err),
        danger: true
      });
    }
  };


  const [activeSection, setActiveSection] = useState(readStoredSection);
  const tabRefs = useRef({});

  const selectSection = useCallback((section) => {
    setActiveSection(section);
    try {
      localStorage.setItem(SECTION_STORAGE_KEY, section);
    } catch (_) {}
  }, []);

  const handleTabKeyDown = (e) => {
    const index = SECTIONS.findIndex((s) => s.id === activeSection);
    let next = null;
    if (e.key === "ArrowRight") next = SECTIONS[(index + 1) % SECTIONS.length];
    else if (e.key === "ArrowLeft") next = SECTIONS[(index - 1 + SECTIONS.length) % SECTIONS.length];
    else if (e.key === "Home") next = SECTIONS[0];
    else if (e.key === "End") next = SECTIONS[SECTIONS.length - 1];
    if (!next) return;
    e.preventDefault();
    selectSection(next.id);
    tabRefs.current[next.id]?.focus();
  };

  useEffect(() => {
    let cancelled = false;
    const fetchLlmStatus = async () => {
      try {
        const status = await getLlmStatus();
        if (!cancelled) setLlmStatus(status);
      } catch (_) {}
      try {
        const [backends, stats] = await Promise.all([getLlmBackends(), getLlmStats()]);
        if (!cancelled) {
          setLlmBackends(backends);
          setLlmStats(stats);
        }
      } catch (_) {}
    };
    fetchLlmStatus();
    const interval = setInterval(fetchLlmStatus, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const isSD15OrCustom = activeModel ? isSD15OrCustomModel(activeModel) : false;
  const isOpenVinoNpu = constraints.backendType === "openvino-npu";
  const supportsThinking = Boolean(llmStatus.ready && llmStatus.settings?.supportsThinking);
  const availableBackends = backendOptions?.options?.length
    ? backendOptions.options
    : [{ id: "cpu", label: "CPU", available: true }];
  const unavailableBackends = Array.isArray(backendOptions?.unavailable)
    ? backendOptions.unavailable.filter((backend) => !availableBackends.some((available) => available.id === backend.id))
    : [];
  const visibleBackends = [...availableBackends, ...unavailableBackends.map((backend) => ({ ...backend, available: false }))];

  const refreshBackendOptions = useCallback(async () => {
    if (typeof setBackendOptions !== "function") return;
    const nextOptions = await getBackendOptions();
    setBackendOptions(nextOptions);
  }, [setBackendOptions]);

  useEffect(() => {
    refreshBackendOptions().catch(() => {});
    const handleFocus = () => refreshBackendOptions().catch(() => {});
    const handleVisibility = () => {
      if (document.visibilityState === "visible") handleFocus();
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refreshBackendOptions]);

  useEffect(() => {
    if (!backendDownload.active) return undefined;
    let cancelled = false;

    const poll = async () => {
      try {
        const progress = await getDownloadProgress();
        if (cancelled) return;
        setBackendDownload((prev) => ({
          ...prev,
          active: Boolean(progress.active),
          progress: Number(progress.progress ?? prev.progress ?? 0),
          speed: progress.speed || prev.speed || "",
          error: progress.error || null,
        }));

        if (!progress.active && !progress.error) {
          await refreshBackendOptions();
        }
      } catch (err) {
        if (!cancelled) {
          setBackendDownload((prev) => ({
            ...prev,
            active: false,
            error: err.message || "Download failed",
          }));
        }
      }
    };

    poll();
    const interval = setInterval(poll, 700);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [backendDownload.active, refreshBackendOptions]);

  const updateConstraint = (key, value) => {
    setConstraints((prev) => ({
      ...prev,
      [key]: value,
      ...(key === "steps"
        ? isOpenVinoNpu
          ? { npuSteps: value }
          : { standardSteps: value }
        : {}),
    }));
  };

  const updateTextSetting = (key, value) => {
    setPendingTextSettings((prev) => {
      const updated = { ...prev, [key]: value };
      
      // If the user selected a preset performance profile, apply its hardware parameters
      if (key === "performanceProfile") {
        const presets = specs?.recommended_text_settings;
        if (presets) {
          let preset = null;
          if (value === "potato") preset = presets.low;
          else if (value === "balanced") preset = presets.mid;
          else if (value === "high") preset = presets.high;
          
          if (preset) {
            Object.assign(updated, {
              contextSize: preset.contextSize,
              threads: preset.threads,
              gpuLayers: preset.gpuLayers,
              cacheTypeK: preset.cacheTypeK,
              cacheTypeV: preset.cacheTypeV,
              flashAttn: preset.flashAttn,
              mlock: preset.mlock,
              mmap: preset.mmap,
              cachePrompt: preset.cachePrompt,
              batchSize: preset.batchSize,
              ubatchSize: preset.ubatchSize,
            });
          }
        }
      } else {
        // If the user manually overrides any performance-related setting, auto-switch profile to "custom"
        const isPerformanceKey = [
          "contextSize", "threads", "gpuLayers", "cacheTypeK", "cacheTypeV",
          "flashAttn", "mlock", "mmap", "cachePrompt", "batchSize", "ubatchSize"
        ].includes(key);
        
        if (isPerformanceKey) {
          updated.performanceProfile = "custom";
        }
      }
      
      return updated;
    });
  };

  const updateSpeechSetting = (key, value) => {
    setSpeechSettings((prev) => ({
      ...prev,
      [key]: value
    }));
  };

  const updateTtsSetting = (key, value) => {
    setTtsSettings((prev) => ({
      ...prev,
      [key]: value
    }));
  };

  const buildTextStartOptions = (settings) => ({
    threads: settings?.threads || specs?.cpu_cores_physical || 4,
    contextSize: settings?.contextSize ?? 0,
    gpuLayers: settings?.gpuLayers ?? -1,
    enableThinking: settings?.enableThinking === true,
    flashAttn: settings?.flashAttn,
    cacheTypeK: settings?.cacheTypeK,
    cacheTypeV: settings?.cacheTypeV,
    mlock: settings?.mlock,
    mmap: settings?.mmap,
    cachePrompt: settings?.cachePrompt,
    defragThold: settings?.defragThold,
    batchSize: settings?.batchSize,
    ubatchSize: settings?.ubatchSize,
    performanceProfile: settings?.performanceProfile,
    preferredBackend: settings?.preferredBackend,
  });

  const handleBenchmarkTextBackend = async () => {
    const model = llmStatus.settings?.model;
    if (!model) {
      showAlert({ title: "No Text Model Loaded", message: "Load a GGUF text model before benchmarking.", danger: true });
      return;
    }
    setBenchmarkBusy(true);
    try {
      const result = await benchmarkLlm(model, {
        contextSize: Math.min(2048, Number(pendingTextSettings?.contextSize) || 2048),
        gpuLayers: pendingTextSettings?.gpuLayers ?? -1,
        includeCpu: true,
      });
      const winner = result.winner;
      showAlert({
        title: winner ? "Benchmark Complete" : "Benchmark Finished",
        message: winner
          ? `Fastest backend: ${winner.backendMode} at ${Number(winner.predicted_per_second || 0).toFixed(1)} tokens/sec.`
          : "Benchmark finished, but no backend returned usable timing data.",
      });
      const [status, backends, stats] = await Promise.all([getLlmStatus(), getLlmBackends(true), getLlmStats()]);
      setLlmStatus(status);
      setLlmBackends(backends);
      setLlmStats(stats);
    } catch (err) {
      showAlert({ title: "Benchmark Failed", message: err.message || String(err), danger: true });
    } finally {
      setBenchmarkBusy(false);
    }
  };

  const handleThinkingToggle = async (enabled) => {
    const nextSettings = { ...pendingTextSettings, enableThinking: enabled };

    let status = null;
    try {
      status = await getLlmStatus();
    } catch (_) {}
    if (!status?.ready || !status?.settings?.model) {
      setPendingTextSettings(nextSettings);
      setTextSettings(nextSettings);
      return;
    }

    const reload = await showConfirm({
      title: enabled ? "Reload With DeepThink?" : "Reload Without DeepThink?",
      message: "Changing DeepThink requires reloading the text model before it affects new replies. Reload now, or skip and keep the currently loaded model as-is?",
      confirmLabel: "Reload",
      cancelLabel: "Skip",
    });
    if (!reload) return;

    try {
      setPendingTextSettings(nextSettings);
      setTextSettings(nextSettings);
      await stopLlm();
      await startLlm(status.settings.model, buildTextStartOptions(nextSettings));
    } catch (err) {
      await showAlert({
        title: "Reload Failed",
        message: err.message || String(err),
        danger: true,
      });
    }
  };

  const handleAspectRatioChange = (ratio, sizeType) => {
    if (isOpenVinoNpu && ratio !== "1:1") return;
    const isSDXL = sizeType === "sdxl" && !isSD15OrCustom;
    const selected = ASPECT_RATIOS.find((r) => r.id === ratio);
    if (selected) {
      let w = isSDXL ? selected.sdxl_width : selected.width;
      let h = isSDXL ? selected.sdxl_height : selected.height;
      if (isOpenVinoNpu) {
        const size = constraints.width >= 1024 ? 1024 : 512;
        w = size;
        h = size;
      } else if (isSD15OrCustom) {
        if (w > h) {
          h = Math.round((h * 512) / w);
          w = 512;
        } else {
          w = Math.round((w * 512) / h);
          h = 512;
        }
        w = Math.round(w / 64) * 64;
        h = Math.round(h / 64) * 64;
      }
      updateConstraint("width", w);
      updateConstraint("height", h);
    }
  };

  const handleBackendChange = async (backendType) => {
    const currentBackend = constraints.backendType || "cpu";
    if (backendType === currentBackend) return;

    const switchesAccelerator =
      (currentBackend === "openvino-npu" && backendType !== "openvino-npu") ||
      (currentBackend !== "openvino-npu" && backendType === "openvino-npu");

    if (serverRunning && switchesAccelerator) {
      const leavingNpu = currentBackend === "openvino-npu";
      const confirmed = await showConfirm({
        title: leavingNpu ? "Unload NPU Model?" : "Unload Model?",
        message: leavingNpu
          ? "The OpenVINO NPU model must be unloaded before switching to the standard backend."
          : "The active model must be unloaded before switching to the OpenVINO NPU backend.",
        confirmLabel: "Unload",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (!confirmed) return;

      try {
        await stopServer();
        setServerRunning(false);
        setActiveModel(null);
      } catch (err) {
        await showAlert({
          title: "Unload Failed",
          message: err.message || String(err),
          danger: true,
        });
        return;
      }
    }

    setConstraints((prev) => ({
      ...prev,
      backendType,
      useGpu: backendType !== "cpu",
      steps: backendType === "openvino-npu"
        ? Math.max(1, Math.min(8, prev.npuSteps || 4))
        : Math.max(1, Math.min(60, prev.standardSteps || 20)),
      ...(backendType === "openvino-npu"
        ? {
            width: prev.width >= 1024 ? 1024 : 512,
            height: prev.width >= 1024 ? 1024 : 512,
          }
        : {}),
    }));
  };

  const handleBackendDownload = async (backend) => {
    if (!backend?.id || backendDownload.active) return;
    try {
      setBackendDownload({
        active: true,
        backendId: backend.id,
        progress: 0,
        speed: "Starting",
        error: null,
      });
      await downloadBackend(backend.id);
    } catch (err) {
      setBackendDownload({
        active: false,
        backendId: backend.id,
        progress: 0,
        speed: "",
        error: err.message || "Download failed",
      });
      await showAlert({
        title: "Backend Download Failed",
        message: err.message || "Could not start backend download.",
        danger: true,
      });
    }
  };

  // ─── Image Settings ───
  const renderImageSettings = () => {
    const resolutionMode = constraints.width >= 1024 ? "sdxl" : "sd15";
    const isSDXLSize = constraints.width >= 1024 && !isSD15OrCustom;
    const stepsMax = isOpenVinoNpu ? 8 : 60;

    return (
      <>
        <div className="page-section-label settings-group-label">Size</div>
        <ul className="row-list">
          <SettingRow
            title="Resolution"
            description={resolutionMode === "sdxl" ? "SDXL base size" : "SD 1.5 base size"}
          >
            <Choice
              label="Resolution"
              value={resolutionMode}
              options={[
                { id: "sd15", label: "512px" },
                {
                  id: "sdxl",
                  label: "1024px",
                  disabled: isSD15OrCustom,
                  title: isSD15OrCustom ? "The loaded model works at 512px" : undefined,
                },
              ]}
              onSelect={(mode) => {
                const ratio = ASPECT_RATIOS.find(r => {
                  const rw = constraints.width >= 1024 ? r.sdxl_width : r.width;
                  const rh = constraints.height >= 1024 ? r.sdxl_height : r.height;
                  return Math.abs(rw - constraints.width) < 10 && Math.abs(rh - constraints.height) < 10;
                })?.id || "1:1";
                handleAspectRatioChange(ratio, mode);
              }}
            />
          </SettingRow>
          <SettingRow
            title="Aspect ratio"
            description={isOpenVinoNpu ? "OpenVINO NPU supports square images only" : undefined}
            wide
          >
            <div className="settings-ratio-grid" role="group" aria-label="Aspect ratio">
              {ASPECT_RATIOS.map((ratio) => {
                const rw = isSDXLSize ? ratio.sdxl_width : ratio.width;
                const rh = isSDXLSize ? ratio.sdxl_height : ratio.height;
                const isActive = Math.abs(constraints.width - rw) < 10 && Math.abs(constraints.height - rh) < 10;
                const scale = 28 / Math.max(ratio.width, ratio.height);
                return (
                  <button
                    key={ratio.id}
                    type="button"
                    className="settings-ratio-tile"
                    aria-pressed={isActive}
                    aria-label={`${ratio.label}, ${rw} by ${rh}`}
                    onClick={() => handleAspectRatioChange(ratio.id, isSDXLSize ? "sdxl" : "sd15")}
                    disabled={isOpenVinoNpu && ratio.id !== "1:1"}
                  >
                    <span className="settings-ratio-shape-box" aria-hidden="true">
                      <span
                        className="settings-ratio-shape"
                        style={{ width: `${Math.round(ratio.width * scale)}px`, height: `${Math.round(ratio.height * scale)}px` }}
                      />
                    </span>
                    <span className="settings-ratio-id">{ratio.id}</span>
                    <span className="settings-ratio-size">{rw}×{rh}</span>
                  </button>
                );
              })}
            </div>
          </SettingRow>
          <SettingRow title="Width" description="Pixels, rounded to multiples of 64" htmlFor="settings-image-width">
            <input
              id="settings-image-width"
              type="number"
              className="settings-input"
              value={constraints.width}
              onChange={(e) => updateConstraint("width", Math.round(parseInt(e.target.value) / 64) * 64)}
              min="64"
              max="2048"
              step="64"
            />
          </SettingRow>
          <SettingRow title="Height" description="Pixels, rounded to multiples of 64" htmlFor="settings-image-height">
            <input
              id="settings-image-height"
              type="number"
              className="settings-input"
              value={constraints.height}
              onChange={(e) => updateConstraint("height", Math.round(parseInt(e.target.value) / 64) * 64)}
              min="64"
              max="2048"
              step="64"
            />
          </SettingRow>
        </ul>

        <div className="page-section-label settings-group-label">Quality</div>
        <ul className="row-list">
          <SettingRow
            title="Detail steps"
            description={isOpenVinoNpu ? "LCM OpenVINO: 1–8 fast steps" : "More steps give sharper detail but take longer"}
          >
            <Slider
              label="Detail steps"
              value={constraints.steps}
              min={1}
              max={stepsMax}
              onChange={(e) => updateConstraint("steps", parseInt(e.target.value))}
            />
          </SettingRow>
          <SettingRow title="Seed" description="-1 picks a random seed each time" htmlFor="settings-image-seed">
            <div className="settings-inline">
              <input
                id="settings-image-seed"
                type="number"
                className="settings-input"
                value={constraints.seed}
                onChange={(e) => updateConstraint("seed", parseInt(e.target.value) || -1)}
                placeholder="-1"
              />
              <button type="button" className="btn" onClick={() => updateConstraint("seed", -1)}>
                Random
              </button>
            </div>
          </SettingRow>
        </ul>

        <div className="page-section-label settings-group-label">Memory</div>
        <ul className="row-list">
          <SettingRow title="VAE tiling" description="Process the image in tiles to save VRAM">
            <Switch label="VAE tiling" checked={constraints.vaeTiling} onChange={(v) => updateConstraint("vaeTiling", v)} />
          </SettingRow>
          <SettingRow title="VAE on CPU" description="Run the decoder on the CPU if the GPU runs out of memory">
            <Switch label="VAE on CPU" checked={constraints.vaeOnCpu} onChange={(v) => updateConstraint("vaeOnCpu", v)} />
          </SettingRow>
          <SettingRow title="Flash attention" description="Faster attention with less memory">
            <Switch label="Flash attention" checked={constraints.useFlashAttn} onChange={(v) => updateConstraint("useFlashAttn", v)} />
          </SettingRow>
        </ul>

        <div className="page-section-label settings-group-label">Acceleration</div>
        <ul className="row-list">
          <SettingRow title="Accelerator" description="Hardware used to generate images" wide>
            <Choice
              label="Accelerator"
              value={constraints.backendType}
              options={visibleBackends.map((b) => {
                const isAvailable = b.available !== false;
                const isDownloading = backendDownload.active && backendDownload.backendId === b.id;
                return {
                  id: b.id,
                  label: isDownloading
                    ? `${Math.max(0, Math.min(100, Math.round(backendDownload.progress)))}%`
                    : b.label,
                  disabled: !isAvailable,
                  title: !isAvailable ? b.reason : undefined,
                };
              })}
              onSelect={(id) => {
                const b = visibleBackends.find((item) => item.id === id);
                if (b && b.available !== false) handleBackendChange(id);
              }}
            />
          </SettingRow>
          {unavailableBackends.map((backend) => {
            const isDownloading = backendDownload.active && backendDownload.backendId === backend.id;
            const progress = Math.max(0, Math.min(100, Math.round(backendDownload.progress || 0)));
            const hasError = backendDownload.error && backendDownload.backendId === backend.id;
            return (
              <li key={`download-${backend.id}`} className="row-item settings-row">
                <div className="row-item-main">
                  <div className="row-item-title">{backend.label}</div>
                  <div
                    className={`row-item-meta ${hasError && !isDownloading ? "settings-error-text" : ""}`}
                    title={backendDownload.error || backend.reason}
                  >
                    {isDownloading
                      ? `${progress}%${backendDownload.speed ? ` · ${backendDownload.speed}` : ""}`
                      : hasError
                        ? backendDownload.error
                        : backend.reason}
                  </div>
                  {isDownloading && (
                    <div
                      className="settings-progress"
                      role="progressbar"
                      aria-label={`Downloading ${backend.label}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={progress}
                    >
                      <div className="settings-progress-fill" style={{ width: `${progress}%` }} />
                    </div>
                  )}
                </div>
                <div className="row-item-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => handleBackendDownload(backend)}
                    disabled={backendDownload.active}
                  >
                    {isDownloading
                      ? <RefreshCw className="progress-spinner" size={14} aria-hidden="true" />
                      : <DownloadCloud size={14} aria-hidden="true" />}
                    <span>{isDownloading ? "Downloading" : "Download"}</span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </>
    );
  };

  // ─── Text Settings ───
  const renderTextSettings = () => {
    const tokenMode = pendingTextSettings.responseTokenMode || "auto";
    const maxThreads = specs?.cpu_cores_logical || 16;
    const gpuLayersValue = pendingTextSettings.gpuLayers === -1 ? 50 : pendingTextSettings.gpuLayers;

    return (
      <>
        <HardwareSummary specs={specs} />

        <div className="page-section-label settings-group-label">Model and context</div>
        <ul className="row-list">
          <SettingRow
            title="System prompt"
            description="Sets the assistant's personality and instructions"
            htmlFor="settings-system-prompt"
            wide
          >
            <textarea
              id="settings-system-prompt"
              className="settings-textarea"
              value={pendingTextSettings.systemPrompt || ""}
              onChange={(e) => updateTextSetting("systemPrompt", e.target.value)}
              placeholder="Enter a system prompt"
              rows={3}
            />
          </SettingRow>
          <SettingRow title="Context size" description="Model memory limit. 0 uses the model default (recommended)">
            <Slider
              label="Context size"
              value={pendingTextSettings.contextSize || 0}
              min={0}
              max={32768}
              step={512}
              onChange={(e) => updateTextSetting("contextSize", parseInt(e.target.value))}
            />
          </SettingRow>
        </ul>

        <div className="page-section-label settings-group-label">Generation</div>
        <ul className="row-list">
          <SettingRow title="Temperature" description="Lower is focused, higher is more creative. Recommended 0.7">
            <Slider
              label="Temperature"
              value={pendingTextSettings.temperature}
              min={0}
              max={2}
              step={0.1}
              onChange={(e) => updateTextSetting("temperature", parseFloat(e.target.value))}
            />
          </SettingRow>
          <SettingRow
            title="Max response tokens"
            description={tokenMode === "auto"
              ? "Auto adjusts length to the context window (recommended)"
              : "Manual uses the token limit below"}
          >
            <Choice
              label="Max response tokens"
              value={tokenMode}
              options={[
                { id: "auto", label: "Auto" },
                { id: "manual", label: "Manual" },
              ]}
              onSelect={(mode) => updateTextSetting("responseTokenMode", mode)}
            />
          </SettingRow>
          {tokenMode === "manual" && (
            <SettingRow title="Token limit" description="Longest reply the model may write">
              <Slider
                label="Token limit"
                value={pendingTextSettings.maxTokens || 1024}
                min={64}
                max={4096}
                step={64}
                onChange={(e) => updateTextSetting("maxTokens", parseInt(e.target.value))}
              />
            </SettingRow>
          )}
          <SettingRow
            title="Seed"
            description="-1 is random. A fixed number repeats the same reply"
            htmlFor="settings-text-seed"
          >
            <input
              id="settings-text-seed"
              type="number"
              className="settings-input"
              value={pendingTextSettings.seed}
              onChange={(e) => updateTextSetting("seed", parseInt(e.target.value) || -1)}
              placeholder="-1"
            />
          </SettingRow>
        </ul>

        <div className="page-section-label settings-group-label">Performance</div>
        <ul className="row-list">
          <SettingRow title="Profile" description="Presets fill in the hardware settings below">
            <Choice
              label="Performance profile"
              value={pendingTextSettings.performanceProfile || "balanced"}
              options={["potato", "balanced", "high", "custom"].map((profile) => ({
                id: profile,
                label: profile.charAt(0).toUpperCase() + profile.slice(1),
              }))}
              onSelect={(profile) => updateTextSetting("performanceProfile", profile)}
            />
          </SettingRow>
          {llmBackends.available?.length > 1 && (
            <SettingRow title="Text backend">
              <Choice
                label="Text backend"
                value={pendingTextSettings.preferredBackend || "auto"}
                options={llmBackends.available.map((backend) => ({
                  id: backend.key,
                  label: backend.key === "cpu" ? "CPU only" : backend.key.toUpperCase(),
                }))}
                onSelect={(key) => updateTextSetting("preferredBackend", key)}
              />
            </SettingRow>
          )}
          <SettingRow title="CPU threads">
            <Slider
              label="CPU threads"
              value={pendingTextSettings.threads || 4}
              min={1}
              max={maxThreads}
              onChange={(e) => updateTextSetting("threads", parseInt(e.target.value))}
            />
          </SettingRow>
          <SettingRow title="GPU layers" description="50 puts all layers on the GPU">
            <Slider
              label="GPU layers"
              value={gpuLayersValue}
              min={0}
              max={50}
              display={pendingTextSettings.gpuLayers === -1 ? "All" : pendingTextSettings.gpuLayers}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                updateTextSetting("gpuLayers", val >= 50 ? -1 : val);
              }}
            />
          </SettingRow>
          <SettingRow title="Batch size">
            <Slider
              label="Batch size"
              value={pendingTextSettings.batchSize || 512}
              min={64}
              max={2048}
              step={64}
              onChange={(e) => updateTextSetting("batchSize", parseInt(e.target.value))}
            />
          </SettingRow>
          <SettingRow title="KV cache" description="Lower precision uses less memory">
            <Choice
              label="KV cache"
              value={pendingTextSettings.cacheTypeK || "q8_0"}
              options={["q4_0", "q8_0", "f16"].map((type) => ({ id: type, label: type.toUpperCase() }))}
              onSelect={(type) => {
                updateTextSetting("cacheTypeK", type);
                updateTextSetting("cacheTypeV", type);
              }}
            />
          </SettingRow>
        </ul>

        {hasPendingChanges && (
          <div className="settings-savebar" role="status">
            <div className="settings-savebar-text">
              <div className="settings-savebar-title">Unsaved text settings</div>
              <div className="settings-savebar-meta">
                {llmStatus.ready
                  ? "Saving unloads the running text model to apply the changes."
                  : "Changes apply the next time a model loads."}
              </div>
            </div>
            <button type="button" className="btn btn-primary" onClick={handleSaveTextSettings}>
              Save and apply
            </button>
          </div>
        )}
      </>
    );
  };

  // ─── Speech Settings ───
  const renderSpeechSettings = () => {
    const SPEECH_LANGUAGES = [
      { value: "auto", label: "Auto detect" },
      { value: "en", label: "English" },
      { value: "es", label: "Spanish" },
      { value: "fr", label: "French" },
      { value: "de", label: "German" },
      { value: "it", label: "Italian" },
      { value: "pt", label: "Portuguese" },
      { value: "hi", label: "Hindi" },
      { value: "ja", label: "Japanese" },
      { value: "ko", label: "Korean" },
      { value: "zh", label: "Chinese" },
    ];

    return (
      <>
        <div className="page-section-label settings-group-label">Transcription</div>
        <ul className="row-list">
          <SettingRow
            title="Default backend"
            description="Auto uses a GPU whisper.cpp build when installed, then falls back to CPU"
            htmlFor="settings-speech-backend"
          >
            <Select
              id="settings-speech-backend"
              value={speechSettings.backendPreference || "auto"}
              onChange={(e) => updateSpeechSetting("backendPreference", e.target.value)}
            >
              <option value="auto">Auto (GPU if installed)</option>
              <option value="vulkan">Vulkan GPU</option>
              <option value="metal">Metal GPU</option>
              <option value="cpu">CPU</option>
            </Select>
          </SettingRow>
          <SettingRow
            title="Default language"
            description="Language of the audio. Auto detect is recommended"
            htmlFor="settings-speech-language"
          >
            <Select
              id="settings-speech-language"
              value={speechSettings.language || "auto"}
              onChange={(e) => updateSpeechSetting("language", e.target.value)}
            >
              {SPEECH_LANGUAGES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </SettingRow>
          <SettingRow title="CPU threads" description="Threads used for transcription. Recommended 4">
            <Slider
              label="CPU threads"
              value={speechSettings.threads || 4}
              min={1}
              max={specs?.cpu_cores_logical || 16}
              onChange={(e) => updateSpeechSetting("threads", parseInt(e.target.value))}
            />
          </SettingRow>
        </ul>

        <div className="page-section-label settings-group-label">Translation</div>
        <ul className="row-list">
          <SettingRow title="Translate to English" description="Translate other languages to English while transcribing">
            <Switch
              label="Translate to English"
              checked={speechSettings.translate === true}
              onChange={(val) => updateSpeechSetting("translate", val)}
            />
          </SettingRow>
        </ul>
      </>
    );
  };

  // ─── Text to Speech Settings ───
  const renderTtsSettings = () => {
    const TTS_VOICES = [
      { value: "af_heart", label: "Heart - Female, US English" },
      { value: "af_bella", label: "Bella - Female, US English" },
      { value: "af_nicole", label: "Nicole - Female, US English" },
      { value: "af_sarah", label: "Sarah - Female, US English" },
      { value: "am_michael", label: "Michael - Male, US English" },
      { value: "am_fenrir", label: "Fenrir - Male, US English" },
      { value: "bf_emma", label: "Emma - Female, UK English" },
      { value: "bm_george", label: "George - Male, UK English" },
    ];

    return (
      <>
        <div className="page-section-label settings-group-label">Text to speech</div>
        <ul className="row-list">
          <SettingRow
            title="Default voice"
            description="Kokoro voice used for generated audio"
            htmlFor="settings-tts-voice"
          >
            <Select
              id="settings-tts-voice"
              value={ttsSettings?.voice || "af_heart"}
              onChange={(e) => updateTtsSetting("voice", e.target.value)}
            >
              {TTS_VOICES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </SettingRow>
          <SettingRow title="Speed" description="1.00x is natural speed">
            <Slider
              label="Speed"
              value={ttsSettings?.speed || 1}
              min={0.5}
              max={2}
              step={0.05}
              display={`${(ttsSettings?.speed || 1).toFixed(2)}x`}
              onChange={(e) => updateTtsSetting("speed", parseFloat(e.target.value))}
            />
          </SettingRow>
        </ul>
      </>
    );
  };

  // ─── Appearance Settings ───
  const renderAppearanceSettings = () => (
    <>
      <div className="page-section-label settings-group-label">Theme</div>
      <div className="settings-theme-grid" role="group" aria-label="Theme">
        {THEMES.map((t) => {
          const isActive = theme === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTheme(t.id)}
              className={`settings-theme-card ${t.type === "dark" ? "is-dark" : "is-light"}`}
              aria-pressed={isActive}
              style={{ "--theme-bg": t.bg, "--theme-primary": t.primary, "--theme-secondary": t.secondary }}
            >
              <span className="settings-theme-preview" aria-hidden="true">
                <span className="settings-theme-swatch swatch-primary" />
                <span className="settings-theme-swatch swatch-secondary" />
                {isActive && (
                  <span className="settings-theme-check">
                    <Check size={12} strokeWidth={3} />
                  </span>
                )}
              </span>
              <span className="settings-theme-name">{t.name}</span>
              <span className="settings-theme-type">{t.type === "dark" ? "Dark" : "Light"}</span>
            </button>
          );
        })}
      </div>

      <div className="page-section-label settings-group-label">Text</div>
      <ul className="row-list">
        <SettingRow title="Text size" description="Size of text across the app, including chat replies. Default is 16px">
          <Slider
            label="Text size"
            value={fontSize || 16}
            min={12}
            max={24}
            step={1}
            display={`${fontSize || 16}px`}
            onChange={(e) => setFontSize(parseInt(e.target.value))}
          />
        </SettingRow>
      </ul>
    </>
  );

  const renderSection = () => {
    switch (activeSection) {
      case "image": return renderImageSettings();
      case "text": return renderTextSettings();
      case "speech": return renderSpeechSettings();
      case "tts": return renderTtsSettings();
      default: return renderAppearanceSettings();
    }
  };

  return (
    <div className="page settings-page">
      <div className="page-scroll">
        <div className="page-column settings-column">
          <header className="page-header">
            <h1 className="page-title">Settings</h1>
          </header>

          <div
            className="segmented settings-tabs"
            role="tablist"
            aria-label="Settings sections"
            onKeyDown={handleTabKeyDown}
          >
            {SECTIONS.map((section) => {
              const selected = activeSection === section.id;
              return (
                <button
                  key={section.id}
                  ref={(el) => { tabRefs.current[section.id] = el; }}
                  type="button"
                  role="tab"
                  id={`settings-tab-${section.id}`}
                  aria-selected={selected}
                  aria-controls={`settings-panel-${section.id}`}
                  tabIndex={selected ? 0 : -1}
                  className="segmented-item"
                  onClick={() => selectSection(section.id)}
                >
                  {section.label}
                </button>
              );
            })}
          </div>

          <div
            className="settings-panel"
            role="tabpanel"
            id={`settings-panel-${activeSection}`}
            aria-labelledby={`settings-tab-${activeSection}`}
          >
            {renderSection()}
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(Settings);
