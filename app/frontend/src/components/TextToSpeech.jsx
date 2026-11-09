import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  Gauge,
  LoaderCircle,
  Mic,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Settings2,
  Square,
  Trash2,
  User,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  deleteTtsOutput,
  getSpeechStatus,
  getTtsStatus,
  listSpeechModels,
  listTtsModels,
  speakTts,
  startTts,
  stopTts,
  transcribeSpeech,
} from "../services/api";
import { createMicRecorder } from "../utils/audio";
import "../styles/voice.css";

const FALLBACK_VOICES = [
  { id: "af_heart", name: "Heart", language: "en-us", gender: "Female" },
  { id: "af_bella", name: "Bella", language: "en-us", gender: "Female" },
  { id: "am_michael", name: "Michael", language: "en-us", gender: "Male" },
  { id: "bf_emma", name: "Emma", language: "en-gb", gender: "Female" },
  { id: "bm_george", name: "George", language: "en-gb", gender: "Male" },
];

const MAX_CHARS = 5000;

function downloadUrl(url, filename) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

const clipId = (clip) => clip && (clip.filename || clip.metadata || clip.audioFile || clip.url);

function formatDuration(ms) {
  const total = Math.round(Number(ms) / 1000);
  if (!Number.isFinite(total) || total <= 0) return "";
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

// Player clock: m:ss, always shown even at zero
function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// ---- Word highlighting ----
// The worker saves when each sentence starts and ends; inside a sentence, time is shared out
// by word length plus a little extra where punctuation makes the voice pause.
const splitWords = (text) => String(text || "").match(/\S+/g) || [];

function wordWeight(word) {
  let weight = word.replace(/[^\p{L}\p{N}]/gu, "").length + 2;
  if (/[,;:\u2013\u2014]["')\]]*$/.test(word)) weight += 4;
  if (/[.!?]["')\]]*$/.test(word)) weight += 6;
  return weight;
}

function buildWordTimeline(clip, duration) {
  const displayWords = splitWords(clip.text);
  const timed = (segments) => {
    const out = [];
    for (const segment of segments) {
      const words = splitWords(segment.text);
      const total = words.reduce((sum, word) => sum + wordWeight(word), 0) || 1;
      // Kokoro opens each part with a short silence; start the words after it
      const lead = segment.end - segment.start > 0.6 ? SEGMENT_LEAD_IN : 0;
      const span = Math.max(0, segment.end - segment.start - lead);
      let at = segment.start + lead;
      for (const word of words) {
        const length = (span * wordWeight(word)) / total;
        out.push({ start: at, end: at + length });
        at += length;
      }
    }
    return out;
  };
  if (Array.isArray(clip.segments) && clip.segments.length) {
    const timeline = timed(clip.segments);
    if (timeline.length === displayWords.length) return timeline;
  }
  if (!duration) return [];
  // Older clips have no sentence timings. When the text fits the audio, spread it over the clip;
  // when it doesn't, the clip was cut short, so pace the words as Kokoro speaks and let the rest go unspoken.
  const paced = estimateSpokenSeconds(clip.text, clip.speed);
  return timed([{ text: clip.text, start: 0, end: paced > duration * 1.15 ? paced : duration }]);
}

// Silence at the start of each spoken part, measured against Whisper word times
const SEGMENT_LEAD_IN = 0.15;

// Kokoro speaks about 0.045s per unit of wordWeight at 1x (fitted to Whisper word times)
const SECONDS_PER_WEIGHT = 0.045;

function estimateSpokenSeconds(text, speed = 1) {
  const weight = splitWords(text).reduce((sum, word) => sum + wordWeight(word), 0);
  return (weight * SECONDS_PER_WEIGHT) / (Number(speed) || 1);
}

// Last few words an old, cut-short clip actually reaches, at Kokoro's normal pace
function spokenUpTo(clip, duration) {
  const words = splitWords(clip.text);
  const limit = (duration * (Number(clip.speed) || 1)) / SECONDS_PER_WEIGHT;
  let used = 0;
  let last = 0;
  words.forEach((word, index) => {
    used += wordWeight(word);
    if (used <= limit) last = index;
  });
  return words.slice(Math.max(0, last - 3), last + 1).join(" ");
}

// Clips made before long text was split into sentences stop partway through
const isCutShort = (clip, duration) =>
  !clip.segments && duration > 0 && estimateSpokenSeconds(clip.text, clip.speed) > duration * 1.3;

function findWordIndex(timeline, time) {
  let low = 0;
  let high = timeline.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (timeline[mid].start <= time) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const PLAYER_PREFS_KEY = "voicePlayerPrefs";

const readPlayerPrefs = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYER_PREFS_KEY) || "{}");
    return {
      rate: PLAYBACK_RATES.includes(saved.rate) ? saved.rate : 1,
      volume: Number.isFinite(saved.volume) ? Math.min(1, Math.max(0, saved.volume)) : 1,
      muted: Boolean(saved.muted),
    };
  } catch (_) {
    return { rate: 1, volume: 1, muted: false };
  }
};

function formatSpeed(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  return `${Number(num.toFixed(2))}×`;
}

export default function TextToSpeech({
  showAlert,
  showConfirm,
  selectedOutput,
  onOutputsChanged,
  ttsSettings,
  setTtsSettings,
  // Optional: the saved clip history and delete handler from App.jsx. When they are not
  // passed, the screen lists the clips made in this session plus the sidebar selection.
  outputs,
  onDeleteOutput,
}) {
  const [status, setStatus] = useState({ ready: false, running: false, runtimeInstalled: false, settings: {}, voices: [] });
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [text, setText] = useState("");
  const [isLoadingModel, setIsLoadingModel] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  // Live progress from the server: which part of the text is being spoken, plus timing for an estimate
  const [progress, setProgress] = useState(null);
  const [pendingText, setPendingText] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [sessionClips, setSessionClips] = useState([]);
  const [deletedIds, setDeletedIds] = useState(() => new Set());
  const [activeId, setActiveId] = useState(null);
  const [playingId, setPlayingId] = useState(null);
  // Player bar: the clip loaded into the audio element and its live position
  const [loadedId, setLoadedId] = useState(null);
  // The play event can fire before React re-renders with the new clip, so it reads this ref
  const loadedIdRef = useRef(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [playerPrefs, setPlayerPrefs] = useState(readPlayerPrefs);
  const [openMenu, setOpenMenu] = useState(null); // "model" | "settings" | "voice" | "speed"
  const abortRef = useRef(null);
  const textareaRef = useRef(null);
  const [copiedId, setCopiedId] = useState(null);
  // Dictation: record from the mic, Whisper turns it into text in the box
  const [dictation, setDictation] = useState("idle"); // "idle" | "recording" | "transcribing"
  const [dictationSeconds, setDictationSeconds] = useState(0);
  const dictationRef = useRef(null);
  const audioRef = useRef(null);
  const rowRefs = useRef(new Map());
  const headerMenusRef = useRef(null);
  const voiceMenuRef = useRef(null);
  const speedMenuRef = useRef(null);

  const installedModels = useMemo(() => models.filter((model) => model.installed), [models]);
  const voices = status.voices?.length ? status.voices : FALLBACK_VOICES;
  const selectedVoice = ttsSettings?.voice || "af_heart";
  const speed = ttsSettings?.speed || 1;
  const currentVoice = voices.find((voice) => voice.id === selectedVoice);

  const updateTtsSetting = (key, value) => {
    setTtsSettings((prev) => ({ ...prev, [key]: value }));
  };

  const refresh = useCallback(async () => {
    const [nextStatus, nextModels] = await Promise.all([
      getTtsStatus(),
      listTtsModels(),
    ]);
    setStatus(nextStatus);
    setModels(nextModels);
    setSelectedModel((current) => {
      const installed = nextModels.filter((model) => model.installed);
      if (current && installed.some((model) => model.filename === current || model.id === current)) return current;
      const active = nextStatus.settings?.model;
      if (active && installed.some((model) => model.filename === active)) return active;
      const preferred = ttsSettings?.model;
      if (preferred && installed.some((model) => model.filename === preferred)) return preferred;
      return installed.find((model) => model.recommended)?.filename || installed[0]?.filename || "";
    });
  }, [ttsSettings?.model]);

  useEffect(() => {
    refresh().catch((err) => showAlert?.({ title: "Couldn't read voice status", message: err.message || String(err), danger: true }));
    const interval = setInterval(() => {
      refresh().catch(() => {});
    }, 2500);
    return () => clearInterval(interval);
  }, [refresh, showAlert]);

  useEffect(() => {
    if (!selectedOutput) return;
    setActiveId(clipId(selectedOutput));
    setText(selectedOutput.text || "");
    if (selectedOutput.voice) updateTtsSetting("voice", selectedOutput.voice);
    if (selectedOutput.speed) updateTtsSetting("speed", selectedOutput.speed);
    if (selectedOutput.model) setSelectedModel(selectedOutput.model);
  }, [selectedOutput]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      audioRef.current?.pause();
    };
  }, []);

  // Close whichever menu is open on an outside click or Escape.
  useEffect(() => {
    if (!openMenu) return undefined;
    const refs = {
      model: headerMenusRef,
      settings: headerMenusRef,
      voice: voiceMenuRef,
      speed: speedMenuRef,
    };
    const handleClickOutside = (event) => {
      const ref = refs[openMenu];
      if (ref?.current && !ref.current.contains(event.target)) setOpenMenu(null);
    };
    const handleKey = (event) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [openMenu]);

  const toggleMenu = (name) => setOpenMenu((current) => (current === name ? null : name));

  // Clips shown on the page, newest first.
  const clips = useMemo(() => {
    const seen = new Set();
    const list = [];
    const add = (clip) => {
      const id = clipId(clip);
      if (!clip || !id || seen.has(id) || deletedIds.has(id)) return;
      seen.add(id);
      list.push(clip);
    };
    if (Array.isArray(outputs)) {
      outputs.forEach(add);
    } else {
      sessionClips.forEach(add);
      add(selectedOutput);
    }
    return list.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }, [outputs, sessionClips, selectedOutput, deletedIds]);

  useEffect(() => {
    if (!activeId) return;
    rowRefs.current.get(activeId)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeId, clips.length]);

  const handleLoadModel = async (modelName = selectedModel) => {
    if (!modelName) return;
    setIsLoadingModel(true);
    try {
      await startTts(modelName, { voice: selectedVoice, speed });
      updateTtsSetting("model", modelName);
      await refresh();
    } catch (err) {
      showAlert?.({ title: "Couldn't load the voice model", message: err.message || String(err), danger: true });
    } finally {
      setIsLoadingModel(false);
    }
  };

  const handleStop = async () => {
    try {
      await stopTts();
      await refresh();
    } catch (err) {
      showAlert?.({ title: "Couldn't stop the voice runtime", message: err.message || String(err), danger: true });
    }
  };

  const handleRefresh = () => {
    refresh().catch((err) => showAlert?.({ title: "Couldn't read voice status", message: err.message || String(err), danger: true }));
  };

  const handleGenerate = async () => {
    if (isGenerating || !text.trim() || !selectedModel) return;
    setPendingText(text.trim());
    setIsGenerating(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      if (!status.ready || status.settings?.model !== selectedModel) {
        setIsLoadingModel(true);
        try {
          await startTts(selectedModel, { voice: selectedVoice, speed });
          updateTtsSetting("model", selectedModel);
          await refresh();
        } finally {
          setIsLoadingModel(false);
        }
      }
      const generated = await speakTts(text, {
        model: selectedModel,
        voice: selectedVoice,
        speed,
        signal: controller.signal,
      });
      setSessionClips((prev) => [generated, ...prev]);
      setActiveId(clipId(generated));
      playClip(generated, { restart: true });
      setText("");
      await refresh();
      await onOutputsChanged?.();
    } catch (err) {
      if (err.name !== "AbortError") {
        showAlert?.({ title: "Couldn't generate speech", message: err.message || String(err), danger: true });
      }
    } finally {
      abortRef.current = null;
      setIsGenerating(false);
    }
  };

  // Poll the server while generating. Parts finish in steps, so between updates the bar
  // creeps forward at the average pace of the parts done so far.
  useEffect(() => {
    if (!isGenerating) {
      setProgress(null);
      return undefined;
    }
    const startedAt = Date.now();
    setProgress({ phase: "Starting", done: 0, total: 0, startedAt, speakingAt: null, partAt: null });
    let cancelled = false;
    const poll = async () => {
      const next = await getTtsStatus();
      const gen = next?.generation;
      if (cancelled || !gen?.active) return;
      setProgress((prev) => {
        if (!prev) return prev;
        const done = Number(gen.done) || 0;
        const total = Number(gen.total) || 0;
        const speaking = gen.phase === "Generating speech" || gen.phase === "Saving";
        const at = Date.now();
        return {
          ...prev,
          phase: gen.phase,
          done,
          total,
          speakingAt: prev.speakingAt || (speaking ? at : null),
          partAt: done !== prev.done || !prev.partAt ? at : prev.partAt,
        };
      });
    };
    poll();
    const pollTimer = setInterval(poll, 500);
    const tickTimer = setInterval(() => setNow(Date.now()), 250);
    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      clearInterval(tickTimer);
    };
  }, [isGenerating]);

  const progressView = (() => {
    if (!progress) return null;
    const elapsed = Math.max(0, (now - progress.startedAt) / 1000);
    const { done, total, speakingAt, partAt } = progress;
    let percent = null;
    let secondsLeft = null;
    if (total > 0 && speakingAt) {
      const perPart = done > 0 ? (partAt - speakingAt) / done : null;
      const intoPart = perPart ? Math.min(0.9, (now - partAt) / perPart) : 0;
      percent = Math.min(99, Math.round(((Math.min(done, total) + (done < total ? intoPart : 0)) / total) * 100));
      if (perPart) secondsLeft = Math.max(1, Math.round(((total - done) * perPart - (now - partAt)) / 1000));
    }
    const label = isLoadingModel || progress.phase === "Loading voice model"
      ? "Loading voice model"
      : progress.phase === "Saving"
        ? "Saving clip"
        : total > 1
          ? `Generating speech · part ${Math.min(done + 1, total)} of ${total}`
          : "Generating speech";
    return { percent, label, elapsed: Math.round(elapsed), secondsLeft };
  })();

  const handleCancel = () => {
    abortRef.current?.abort();
    setIsGenerating(false);
  };

  useEffect(() => {
    try {
      localStorage.setItem(PLAYER_PREFS_KEY, JSON.stringify(playerPrefs));
    } catch (_) {
      // Preferences just reset next time
    }
    const audio = audioRef.current;
    if (!audio) return;
    audio.playbackRate = playerPrefs.rate;
    audio.volume = playerPrefs.volume;
    audio.muted = playerPrefs.muted;
  }, [playerPrefs]);

  const playClip = (clip, { restart = false } = {}) => {
    const audio = audioRef.current;
    const id = clipId(clip);
    if (!audio || !clip?.url) return;
    if (loadedId !== id) {
      audio.pause();
      audio.src = clip.url;
      loadedIdRef.current = id;
      setLoadedId(id);
      setCurrentTime(0);
      setMediaDuration(0);
    } else if (restart || audio.ended) {
      audio.currentTime = 0;
    }
    audio.playbackRate = playerPrefs.rate;
    setActiveId(id);
    audio.play().catch((err) => {
      setPlayingId(null);
      if (err.name !== "AbortError") {
        showAlert?.({ title: "Couldn't play the clip", message: err.message || String(err), danger: true });
      }
    });
  };

  // Same clip pauses or resumes where it was; another clip starts from the top
  const togglePlay = (clip) => {
    if (playingId === clipId(clip)) {
      audioRef.current?.pause();
      return;
    }
    playClip(clip);
  };

  const seekTo = (seconds) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.min(audio.duration, Math.max(0, seconds));
    setCurrentTime(audio.currentTime);
  };

  const skipBy = (seconds) => seekTo((audioRef.current?.currentTime || 0) + seconds);

  const stepRate = (direction) => {
    setPlayerPrefs((prev) => {
      const index = PLAYBACK_RATES.indexOf(prev.rate);
      const next = PLAYBACK_RATES[Math.min(PLAYBACK_RATES.length - 1, Math.max(0, index + direction))];
      return { ...prev, rate: next };
    });
  };

  const closePlayer = () => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    loadedIdRef.current = null;
    setLoadedId(null);
    setPlayingId(null);
    setCurrentTime(0);
    setMediaDuration(0);
  };

  const handleDelete = async (clip, event) => {
    const id = clipId(clip);
    if (loadedId === id) closePlayer();
    if (onDeleteOutput) {
      await onDeleteOutput(clip, event);
      return;
    }
    const itemId = clip.filename || clip.metadata;
    if (!itemId) return;
    const preview = (clip.text || clip.displayName || "this clip").slice(0, 60);
    const ok = showConfirm
      ? await showConfirm({
        title: "Delete clip",
        message: `Delete "${preview}"? This can't be undone.`,
        confirmLabel: "Delete",
        danger: true,
      })
      : true;
    if (!ok) return;
    try {
      await deleteTtsOutput(itemId);
      setDeletedIds((prev) => new Set(prev).add(id));
      setSessionClips((prev) => prev.filter((item) => clipId(item) !== id));
      await onOutputsChanged?.();
    } catch (err) {
      showAlert?.({ title: "Couldn't delete the clip", message: err.message || String(err), danger: true });
    }
  };

  const isLoaded = status.ready && status.settings?.model === selectedModel;
  const selectedModelInfo = installedModels.find((model) => model.filename === selectedModel || model.id === selectedModel);
  const modelLabel = selectedModelInfo?.name || selectedModel || (installedModels.length ? "Choose a model" : "No voice model");
  const runtimeLabel = status.runtimeInstalled ? (status.ready ? "Ready" : "Installed") : "Runtime missing";
  const charCount = text.trim().length;
  const canGenerate = Boolean(text.trim()) && Boolean(selectedModel) && status.runtimeInstalled;

  let notice = "";
  if (installedModels.length === 0) notice = "Download a Kokoro model in Models, under TTS models, to start.";
  else if (!status.runtimeInstalled) notice = "The voice runtime isn't installed. Run the TTS setup script for this platform.";

  useEffect(() => {
    if (dictation !== "recording") return undefined;
    setDictationSeconds(0);
    const startedAt = Date.now();
    const timer = setInterval(() => setDictationSeconds(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => clearInterval(timer);
  }, [dictation]);

  // Release the mic if the screen goes away mid-recording
  useEffect(() => () => {
    dictationRef.current?.cancel().catch(() => {});
  }, []);

  const startDictation = async () => {
    try {
      dictationRef.current = await createMicRecorder();
      setDictation("recording");
    } catch (err) {
      showAlert?.({ title: "Microphone unavailable", message: err.message || String(err), danger: true });
    }
  };

  const cancelDictation = () => {
    dictationRef.current?.cancel().catch(() => {});
    dictationRef.current = null;
    setDictation("idle");
  };

  const finishDictation = async () => {
    const recorder = dictationRef.current;
    if (!recorder) return;
    dictationRef.current = null;
    setDictation("transcribing");
    try {
      const wav = await recorder.stop();
      // Use the Whisper model Transcribe has loaded, or else the first one installed
      const [speechStatus, speechModels] = await Promise.all([getSpeechStatus(), listSpeechModels()]);
      const installed = speechModels.filter((model) => model.installed);
      const model = installed.find((item) => item.filename === speechStatus?.settings?.model)?.filename
        || installed[0]?.filename;
      if (!model) throw new Error("Install a speech model on the Models screen to use dictation.");
      const result = await transcribeSpeech(wav, { model, language: "auto", filename: "dictation.wav", save: false });
      const spoken = String(result?.text || "").replace(/\s+/g, " ").trim();
      if (!spoken) {
        showAlert?.({ title: "Didn't catch that", message: "No speech was heard. Try again a little closer to the mic." });
        return;
      }
      setText((prev) => (prev.trim() ? `${prev.replace(/\s+$/, "")} ${spoken}` : spoken));
      setTimeout(() => textareaRef.current?.focus(), 0);
    } catch (err) {
      showAlert?.({ title: "Couldn't transcribe", message: err.message || String(err), danger: true });
    } finally {
      setDictation("idle");
    }
  };

  const composer = (
    <div className="chat-composer">
      <div className="chat-composer-inner">
        <textarea
          ref={textareaRef}
          className="chat-composer-textarea voice-composer-textarea"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (canGenerate) handleGenerate();
            }
          }}
          placeholder={dictation === "recording" ? "Listening… press Done when you've finished" : dictation === "transcribing" ? "Turning your speech into text…" : "Type something to speak, or use the mic"}
          aria-label="Text to speak"
          maxLength={MAX_CHARS}
          rows={1}
        />

        <div className="chat-composer-toolbar">
          <div className="chat-composer-toolbar-left">
            <div ref={voiceMenuRef} className="voice-anchor">
              <button
                type="button"
                className={`chat-composer-chip ${openMenu === "voice" ? "voice-chip-open" : ""}`}
                onClick={() => toggleMenu("voice")}
                aria-haspopup="menu"
                aria-expanded={openMenu === "voice"}
                title="Voice"
              >
                <User size={15} aria-hidden="true" />
                <span>{currentVoice?.name || selectedVoice}</span>
              </button>
              {openMenu === "voice" && (
                <div className="chat-model-menu up voice-menu-left" role="menu" aria-label="Voices">
                  <div className="chat-model-menu-label">Voices</div>
                  {voices.map((voice) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={voice.id === selectedVoice}
                      key={voice.id}
                      className={`chat-model-menu-item ${voice.id === selectedVoice ? "selected" : ""}`}
                      onClick={() => {
                        updateTtsSetting("voice", voice.id);
                        setOpenMenu(null);
                      }}
                    >
                      <span className="chat-model-menu-name">{voice.name}</span>
                      <span className="voice-menu-meta">
                        {[voice.gender, voice.language].filter(Boolean).join(" · ")}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div ref={speedMenuRef} className="voice-anchor">
              <button
                type="button"
                className={`chat-composer-chip ${openMenu === "speed" ? "voice-chip-open" : ""}`}
                onClick={() => toggleMenu("speed")}
                aria-haspopup="dialog"
                aria-expanded={openMenu === "speed"}
                title="Speed"
              >
                <Gauge size={15} aria-hidden="true" />
                <span>{formatSpeed(speed)}</span>
              </button>
              {openMenu === "speed" && (
                <div className="popover voice-popover-up" role="dialog" aria-label="Speed">
                  <div className="field">
                    <div className="voice-speed-head">
                      <label className="field-label" htmlFor="voice-speed">Speed</label>
                      <span className="voice-speed-value">{formatSpeed(speed)}</span>
                    </div>
                    <input
                      id="voice-speed"
                      className="voice-speed-range"
                      type="range"
                      min="0.5"
                      max="2"
                      step="0.05"
                      value={speed}
                      onChange={(event) => updateTtsSetting("speed", Math.max(0.5, Math.min(2, Number(event.target.value) || 1)))}
                    />
                    <div className="voice-speed-scale" aria-hidden="true">
                      <span>0.5×</span>
                      <span>2×</span>
                    </div>
                  </div>
                  {speed !== 1 && (
                    <button type="button" className="btn voice-speed-reset" onClick={() => updateTtsSetting("speed", 1)}>
                      Reset to 1×
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="chat-composer-toolbar-right">
            {dictation === "recording" ? (
              <div className="voice-dictation" role="status">
                <span className="voice-dictation-dot" aria-hidden="true" />
                <span className="voice-dictation-time">{formatClock(dictationSeconds)}</span>
                <button type="button" className="icon-btn" onClick={cancelDictation} aria-label="Cancel recording" title="Cancel">
                  <X size={16} aria-hidden="true" />
                </button>
                <button type="button" className="btn voice-dictation-done" onClick={finishDictation}>
                  <Check size={15} aria-hidden="true" />
                  <span>Done</span>
                </button>
              </div>
            ) : dictation === "transcribing" ? (
              <span className="voice-generating" role="status">
                <LoaderCircle size={14} className="voice-spin" aria-hidden="true" />
                Transcribing
              </span>
            ) : (
              <button
                type="button"
                className="icon-btn voice-mic-btn"
                onClick={startDictation}
                disabled={isGenerating}
                aria-label="Dictate with the microphone"
                title="Dictate: speak and it becomes text"
              >
                <Mic size={18} aria-hidden="true" />
              </button>
            )}
            {isGenerating ? (
              <span className="voice-generating" role="status">
                <LoaderCircle size={14} className="voice-spin" aria-hidden="true" />
                {isLoadingModel ? "Loading model" : progressView?.percent != null ? `Generating ${progressView.percent}%` : "Generating"}
              </span>
            ) : (
              <span className="voice-char-count" aria-live="polite">
                {charCount.toLocaleString()} / {MAX_CHARS.toLocaleString()}
              </span>
            )}
            {isGenerating ? (
              <button
                type="button"
                className="chat-composer-stop-btn"
                onClick={handleCancel}
                aria-label="Cancel generation"
                title="Cancel generation"
              >
                <Square size={14} fill="currentColor" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="chat-composer-send-btn voice-speak-btn"
                onClick={handleGenerate}
                disabled={!canGenerate || dictation !== "idle"}
                aria-label="Speak"
                title={!selectedModel ? "Choose a voice model first" : !text.trim() ? "Type something to speak" : "Speak (Enter)"}
              >
                <Volume2 size={16} aria-hidden="true" />
                <span>Speak</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  const loadedClip = loadedId ? clips.find((clip) => clipId(clip) === loadedId) || null : null;
  const playerDuration = mediaDuration || (loadedClip?.durationMs ? loadedClip.durationMs / 1000 : 0);
  const playerPercent = playerDuration ? Math.min(100, (currentTime / playerDuration) * 100) : 0;

  // Space plays or pauses, arrows skip 5s. Only while this screen is showing and not while typing.
  const pageRef = useRef(null);
  const playerKeysRef = useRef(null);
  playerKeysRef.current = { loadedClip, togglePlay, skipBy };
  useEffect(() => {
    const onKeyDown = (event) => {
      const { loadedClip: clip, togglePlay: toggle, skipBy: skip } = playerKeysRef.current;
      if (!clip || !pageRef.current?.offsetParent) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = event.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || event.target?.isContentEditable) return;
      if (event.key === " " && tag !== "BUTTON") {
        event.preventDefault();
        toggle(clip);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        skip(-5);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        skip(5);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // timeupdate only fires a few times a second; follow the audio every frame while it plays
  const wordTimeline = useMemo(
    () => (loadedClip ? buildWordTimeline(loadedClip, playerDuration) : []),
    [loadedClip, playerDuration],
  );
  const wordTimelineRef = useRef(wordTimeline);
  wordTimelineRef.current = wordTimeline;

  // Re-render only when the spoken word changes or the clock moves a tenth of a second,
  // so the highlight lands on time without redrawing the whole list every frame
  useEffect(() => {
    if (!playingId) return undefined;
    let frame = 0;
    let lastWord = -2;
    let lastTenth = -1;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) {
        const time = audio.currentTime;
        const word = findWordIndex(wordTimelineRef.current, time);
        const tenth = Math.floor(time * 10);
        if (word !== lastWord || tenth !== lastTenth) {
          lastWord = word;
          lastTenth = tenth;
          setCurrentTime(time);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playingId]);
  const activeWord = loadedClip && (playingId || currentTime > 0) ? findWordIndex(wordTimeline, currentTime) : -1;

  // Keep the word being spoken in view on long clips
  const activeWordRef = useRef(null);
  useEffect(() => {
    if (activeWord < 0 || !playingId) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    activeWordRef.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [activeWord, playingId]);

  const seekToWord = (index) => {
    const word = wordTimeline[index];
    if (!word || !loadedClip) return;
    seekTo(word.start);
    if (!playingId) playClip(loadedClip);
  };

  const readingText = (clip) => {
    let wordIndex = -1;
    return String(clip.text || "").split(/(\s+)/).map((token, tokenIndex) => {
      if (!token || /^\s+$/.test(token)) return token;
      wordIndex += 1;
      const index = wordIndex;
      const state = index === activeWord ? "is-current" : index < activeWord ? "is-spoken" : "is-upcoming";
      return (
        <span
          key={tokenIndex}
          ref={index === activeWord ? activeWordRef : undefined}
          className={`voice-word ${state}`}
          onClick={() => seekToWord(index)}
        >
          {token}
        </span>
      );
    });
  };

  const copyClipText = async (clip) => {
    try {
      await navigator.clipboard.writeText(clip.text || "");
      const id = clipId(clip);
      setCopiedId(id);
      setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500);
    } catch (err) {
      showAlert?.({ title: "Couldn't copy the text", message: err.message || String(err), danger: true });
    }
  };

  // Put an old clip's text and settings back in the composer so it can be made again in full
  const regenerateClip = (clip) => {
    setText(clip.text || "");
    if (clip.voice) updateTtsSetting("voice", clip.voice);
    if (clip.speed) updateTtsSetting("speed", clip.speed);
    if (clip.model) setSelectedModel(clip.model);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const player = loadedClip && (
    <div className="voice-player" role="region" aria-label="Audio player">
      <div className="voice-player-top">
        <div className="voice-player-controls">
          <button type="button" className="icon-btn" onClick={() => skipBy(-10)} aria-label="Back 10 seconds" title="Back 10s">
            <RotateCcw size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="voice-player-play"
            onClick={() => togglePlay(loadedClip)}
            aria-label={playingId === loadedId ? "Pause" : "Play"}
            title={playingId === loadedId ? "Pause (Space)" : "Play (Space)"}
          >
            {playingId === loadedId ? (
              <Pause size={17} fill="currentColor" aria-hidden="true" />
            ) : (
              <Play size={17} fill="currentColor" className="voice-play-icon" aria-hidden="true" />
            )}
          </button>
          <button type="button" className="icon-btn" onClick={() => skipBy(10)} aria-label="Forward 10 seconds" title="Forward 10s">
            <RotateCw size={17} aria-hidden="true" />
          </button>
        </div>

        <div className="voice-player-info">
          <span className="voice-player-title">{loadedClip.text || loadedClip.displayName || "Untitled clip"}</span>
          <span className="voice-player-sub">{loadedClip.voiceName || loadedClip.voice}</span>
        </div>

        <div className="voice-player-tools">
          <div className="voice-player-rate" role="group" aria-label="Playback speed">
            <button
              type="button"
              className="voice-player-rate-btn"
              onClick={() => stepRate(-1)}
              disabled={playerPrefs.rate === PLAYBACK_RATES[0]}
              aria-label="Slower"
              title="Slower"
            >
              <Minus size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="voice-player-rate-value"
              onClick={() => setPlayerPrefs((prev) => ({ ...prev, rate: 1 }))}
              aria-label={`Playback speed ${formatSpeed(playerPrefs.rate)}, reset to 1×`}
              title="Reset to 1×"
            >
              {formatSpeed(playerPrefs.rate)}
            </button>
            <button
              type="button"
              className="voice-player-rate-btn"
              onClick={() => stepRate(1)}
              disabled={playerPrefs.rate === PLAYBACK_RATES[PLAYBACK_RATES.length - 1]}
              aria-label="Faster"
              title="Faster"
            >
              <Plus size={14} aria-hidden="true" />
            </button>
          </div>

          <div className="voice-player-volume">
            <button
              type="button"
              className="icon-btn"
              onClick={() => setPlayerPrefs((prev) => ({ ...prev, muted: !prev.muted }))}
              aria-label={playerPrefs.muted ? "Unmute" : "Mute"}
              title={playerPrefs.muted ? "Unmute" : "Mute"}
            >
              {playerPrefs.muted || playerPrefs.volume === 0 ? <VolumeX size={17} aria-hidden="true" /> : <Volume2 size={17} aria-hidden="true" />}
            </button>
            <input
              type="range"
              className="voice-player-range voice-player-volume-range"
              min="0"
              max="1"
              step="0.05"
              value={playerPrefs.muted ? 0 : playerPrefs.volume}
              onChange={(event) => setPlayerPrefs((prev) => ({ ...prev, volume: Number(event.target.value), muted: false }))}
              style={{ "--fill": `${(playerPrefs.muted ? 0 : playerPrefs.volume) * 100}%` }}
              aria-label="Volume"
            />
          </div>

          <button
            type="button"
            className="icon-btn"
            onClick={() => downloadUrl(loadedClip.url, loadedClip.audioFile || "tts.wav")}
            aria-label="Download WAV"
            title="Download WAV"
          >
            <Download size={17} aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn" onClick={closePlayer} aria-label="Close player" title="Close player">
            <X size={17} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="voice-player-seek">
        <span className="voice-player-time">{formatClock(currentTime)}</span>
        <input
          type="range"
          className="voice-player-range"
          min="0"
          max={playerDuration || 0}
          step="0.1"
          value={Math.min(currentTime, playerDuration || 0)}
          onChange={(event) => seekTo(Number(event.target.value))}
          style={{ "--fill": `${playerPercent}%` }}
          aria-label="Seek"
          aria-valuetext={`${formatClock(currentTime)} of ${formatClock(playerDuration)}`}
        />
        <span className="voice-player-time">{formatClock(playerDuration)}</span>
      </div>
    </div>
  );

  return (
    <div className="page voice-page" ref={pageRef}>
      <audio
        ref={audioRef}
        className="voice-audio"
        preload="metadata"
        onPlay={() => setPlayingId(loadedIdRef.current)}
        onPause={() => setPlayingId(null)}
        onEnded={() => setPlayingId(null)}
        onTimeUpdate={(event) => {
          if (event.currentTarget.paused) setCurrentTime(event.currentTarget.currentTime);
        }}
        onLoadedMetadata={(event) => {
          setMediaDuration(event.currentTarget.duration || 0);
          event.currentTarget.playbackRate = playerPrefs.rate;
        }}
        onDurationChange={(event) => setMediaDuration(event.currentTarget.duration || 0)}
      />

      <div className="page-scroll">
        <div className="page-column">
          <header className="page-header">
            <h2 className="page-title">Voice</h2>

            <div ref={headerMenusRef} className="voice-header-tools">
              <div className="chat-model-picker">
                <button
                  type="button"
                  className={`chat-model-trigger ${openMenu === "model" ? "active" : ""}`}
                  onClick={() => toggleMenu("model")}
                  disabled={isGenerating}
                  aria-haspopup="menu"
                  aria-expanded={openMenu === "model"}
                  title={selectedModel || "Choose a Kokoro model"}
                >
                  {isLoadingModel ? (
                    <LoaderCircle size={14} className="voice-spin" aria-hidden="true" />
                  ) : (
                    isLoaded && <span className="chat-model-dot" aria-hidden="true" />
                  )}
                  <span className="chat-model-trigger-label">{modelLabel}</span>
                  <ChevronDown size={15} aria-hidden="true" />
                </button>

                {openMenu === "model" && (
                  <div className="chat-model-menu" role="menu" aria-label="Voice models">
                    <div className="chat-model-menu-label">Voice models</div>
                    {installedModels.length === 0 && (
                      <div className="chat-model-menu-label voice-menu-empty">
                        No models yet. Download one in Models.
                      </div>
                    )}
                    {installedModels.map((model) => {
                      const active = status.ready && status.settings?.model === model.filename;
                      return (
                        <button
                          type="button"
                          role="menuitem"
                          key={model.id || model.filename}
                          className={`chat-model-menu-item ${model.filename === selectedModel ? "selected" : ""}`}
                          onClick={() => {
                            setOpenMenu(null);
                            setSelectedModel(model.filename);
                            if (!active) handleLoadModel(model.filename);
                          }}
                          disabled={isLoadingModel}
                          title={model.filename}
                        >
                          <span className="chat-model-menu-name">{model.name || model.filename}</span>
                          {active && <span className="chat-model-menu-badge">Loaded</span>}
                        </button>
                      );
                    })}
                    <div className="chat-model-menu-divider" />
                    <button
                      type="button"
                      role="menuitem"
                      className="chat-model-menu-item"
                      onClick={() => {
                        setOpenMenu(null);
                        handleRefresh();
                      }}
                    >
                      Refresh
                    </button>
                  </div>
                )}
              </div>

              <div className="voice-anchor">
                <button
                  type="button"
                  className={`icon-btn ${openMenu === "settings" ? "voice-icon-btn-active" : ""}`}
                  onClick={() => toggleMenu("settings")}
                  aria-haspopup="dialog"
                  aria-expanded={openMenu === "settings"}
                  aria-label="Runtime options"
                  title="Runtime options"
                >
                  <Settings2 size={17} aria-hidden="true" />
                </button>
                {openMenu === "settings" && (
                  <div className="popover voice-popover-down" role="dialog" aria-label="Runtime options">
                    <div className="voice-runtime-row">
                      <span className="field-label">Runtime</span>
                      <span className={`tag ${status.ready ? "tag-success" : ""}`}>{runtimeLabel}</span>
                    </div>
                    {status.error && <p className="voice-runtime-error">{status.error}</p>}
                    <p className="field-hint voice-runtime-hint">
                      Kokoro runs locally. Stopping the runtime frees its memory; it starts again when you generate.
                    </p>
                    <div className="voice-runtime-actions">
                      <button
                        type="button"
                        className="btn btn-danger"
                        onClick={() => {
                          setOpenMenu(null);
                          handleStop();
                        }}
                        disabled={!status.ready}
                      >
                        <Square size={13} aria-hidden="true" />
                        Stop runtime
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </header>

          {notice && <p className="voice-notice" role="status">{notice}</p>}
          {status.error && !notice && <p className="voice-notice voice-notice-error" role="alert">{status.error}</p>}

          {isGenerating && progressView && (
            <div className="voice-progress" role="status" aria-live="polite">
              <div className="voice-progress-head">
                <LoaderCircle size={16} className="voice-spin" aria-hidden="true" />
                <span className="voice-progress-label">{progressView.label}</span>
                <span className="voice-progress-percent">
                  {progressView.percent != null ? `${progressView.percent}%` : ""}
                </span>
              </div>
              {pendingText && <p className="voice-progress-text">{pendingText}</p>}
              <div className={`voice-progress-bar ${progressView.percent == null ? "is-indeterminate" : ""}`} aria-hidden="true">
                <div className="voice-progress-fill" style={progressView.percent != null ? { width: `${progressView.percent}%` } : undefined} />
              </div>
              <div className="voice-progress-meta">
                {progressView.elapsed}s
                {progressView.secondsLeft != null ? ` · about ${progressView.secondsLeft}s left` : ""}
              </div>
            </div>
          )}

          {clips.length === 0 && !isGenerating ? (
            <div className="empty-state voice-empty">
              <div className="empty-state-title">Turn text into speech</div>
              <p>Type below, pick a voice and speed, then press Enter.</p>
            </div>
          ) : (
            <ul className="row-list voice-clip-list">
              {clips.map((clip) => {
                const id = clipId(clip);
                const isActive = id === activeId;
                const isPlaying = id === playingId;
                const meta = [
                  clip.voiceName || clip.voice,
                  clip.speed ? formatSpeed(clip.speed) : "",
                  // Old clips stored generation time here; once loaded, the audio's own length is known
                  formatDuration(id === loadedId && playerDuration ? playerDuration * 1000 : clip.durationMs),
                ].filter(Boolean).join(" · ");
                const created = clip.createdAt ? new Date(clip.createdAt).toLocaleString() : "";
                return (
                  <li
                    key={id}
                    ref={(node) => {
                      if (node) rowRefs.current.set(id, node);
                      else rowRefs.current.delete(id);
                    }}
                    className={`row-item voice-clip ${isActive ? "is-active" : ""} ${id === loadedId ? "is-loaded" : ""}`}
                    style={id === loadedId ? { "--voice-row-progress": `${playerPercent}%` } : undefined}
                  >
                    <button
                      type="button"
                      className="voice-play-btn"
                      onClick={() => togglePlay(clip)}
                      disabled={!clip.url}
                      aria-label={isPlaying ? "Pause clip" : "Play clip"}
                      title={isPlaying ? "Pause" : "Play"}
                    >
                      {isPlaying ? (
                        <Pause size={15} fill="currentColor" aria-hidden="true" />
                      ) : (
                        <Play size={15} fill="currentColor" className="voice-play-icon" aria-hidden="true" />
                      )}
                    </button>

                    {id === loadedId ? (
                      <div className="row-item-main voice-clip-main is-reading" title="Click a word to jump there">
                        <span className="row-item-title voice-clip-text">{readingText(clip)}</span>
                        {meta && (
                          <span className="row-item-meta voice-clip-meta">
                            {meta}
                            {created && <>{" · "}{created}</>}
                          </span>
                        )}
                        {isCutShort(clip, playerDuration) && (
                          <span className="voice-cut-short">
                            {`The audio stops at about "…${spokenUpTo(clip, playerDuration)}". This clip was made before long text was supported, so the rest was never spoken.`}
                            <button type="button" className="btn voice-cut-short-btn" onClick={() => regenerateClip(clip)}>
                              <RotateCw size={14} aria-hidden="true" />
                              <span>Regenerate in full</span>
                            </button>
                          </span>
                        )}
                      </div>
                    ) : (
                    <button
                      type="button"
                      className="row-item-main voice-clip-main"
                      onClick={() => setActiveId(isActive ? null : id)}
                      aria-expanded={isActive}
                      title={created}
                    >
                      <span className={`row-item-title voice-clip-text ${isActive ? "" : "is-clamped"}`}>
                        {clip.text || clip.displayName || clip.audioFile || "Untitled clip"}
                      </span>
                      {(meta || (isActive && created)) && (
                        <span className="row-item-meta voice-clip-meta">
                          {meta}
                          {isActive && created && <>{meta ? " · " : ""}{created}</>}
                        </span>
                      )}
                    </button>
                    )}

                    <div className="row-item-actions">
                      {(isActive || id === loadedId) && (
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => copyClipText(clip)}
                          aria-label={copiedId === id ? "Text copied" : "Copy text"}
                          title={copiedId === id ? "Copied" : "Copy text"}
                        >
                          {copiedId === id ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                        </button>
                      )}
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => clip.url && downloadUrl(clip.url, clip.audioFile || "tts.wav")}
                        disabled={!clip.url}
                        aria-label="Download WAV"
                        title="Download WAV"
                      >
                        <Download size={16} aria-hidden="true" />
                      </button>
                      {(clip.filename || clip.metadata) && (
                        <button
                          type="button"
                          className="icon-btn danger"
                          onClick={(event) => handleDelete(clip, event)}
                          aria-label="Delete clip"
                          title="Delete clip"
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="page-dock">
        {player}
        {composer}
      </div>
    </div>
  );
}
