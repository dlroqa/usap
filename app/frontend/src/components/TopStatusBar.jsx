import React, { memo, useState, useRef, useEffect, useCallback } from "react";
import { Sun, Moon, Palette, Check, PanelLeft, Power, Loader2 } from "lucide-react";
import { THEMES } from "../themes";
import { getBackendStatus, getLlmStatus, stopServer, stopLlm } from "../services/api";

// "models/Gemma-4-E4B-Q5_K_M.gguf" -> "Gemma-4-E4B-Q5_K_M"
const cleanModelName = (name) => String(name || "").split(/[\\/]/).pop().replace(/\.(safetensors|gguf|ckpt|bin)$/i, "");

const RUNTIME_LABELS = { image: "Image", text: "Chat" };

function TopStatusBar({
  theme,
  setTheme,
  sidebarVisible,
  onToggleSidebar,
  onImageUnloaded,
  onTextUnloaded,
}) {
  // What the server actually has loaded, polled; the screens' own state only knows what was picked
  const [loaded, setLoaded] = useState({ image: null, text: null });
  const [unloading, setUnloading] = useState(null);

  const refreshLoaded = useCallback(async () => {
    const [image, text] = await Promise.all([
      getBackendStatus().catch(() => null),
      getLlmStatus().catch(() => null),
    ]);
    setLoaded({
      image: image?.ready ? cleanModelName(image.settings?.model) || "Image model" : null,
      text: text?.ready ? cleanModelName(text.settings?.model) || "Chat model" : null,
    });
  }, []);

  useEffect(() => {
    refreshLoaded();
    const timer = setInterval(refreshLoaded, 3000);
    return () => clearInterval(timer);
  }, [refreshLoaded]);

  const unload = async (kind) => {
    setUnloading(kind);
    try {
      if (kind === "image") {
        await stopServer();
        onImageUnloaded?.();
      } else {
        await stopLlm();
        onTextUnloaded?.();
      }
    } catch (err) {
      console.error(`Failed to unload the ${kind} model:`, err);
    } finally {
      await refreshLoaded();
      setUnloading(null);
    }
  };

  const loadedKinds = ["image", "text"].filter((kind) => loaded[kind]);
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setShowThemeMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const isDark = (theme || "dark").startsWith("dark");

  return (
    <div className="top-status-bar">
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        {!sidebarVisible && (
          <button
            type="button"
            onClick={onToggleSidebar}
            className="sidebar-toggle-btn"
            aria-label="Open sidebar"
            title="Open sidebar"
          >
            <PanelLeft size={18} />
          </button>
        )}

        {loadedKinds.length === 0 ? (
          <div className="current-model-info status-pill">
            <div className="status-indicator offline" />
            <span>No model loaded</span>
          </div>
        ) : (
          loadedKinds.map((kind) => (
            <div key={kind} className="current-model-info status-pill status-pill-loaded">
              <div className="status-indicator" />
              <span>{RUNTIME_LABELS[kind]}</span>
              <span className="status-pill-model" title={loaded[kind]}>{loaded[kind]}</span>
              <button
                type="button"
                className="status-pill-unload"
                onClick={() => unload(kind)}
                disabled={unloading !== null}
                aria-label={`Unload ${loaded[kind]}`}
                title="Unload to free memory"
              >
                {unloading === kind ? <Loader2 size={13} className="status-pill-spin" aria-hidden="true" /> : <Power size={13} aria-hidden="true" />}
              </button>
            </div>
          ))
        )}
      </div>

      <div className="telemetry-group" style={{ position: "relative" }}>
        <button
          type="button"
          className="theme-toggle-btn"
          onClick={() => setTheme(isDark ? "light" : "dark")}
          aria-label={`Switch to ${isDark ? "light" : "dark"} theme`}
          title={`Switch to ${isDark ? "light" : "dark"} theme`}
        >
          {isDark ? <Sun size={18} /> : <Moon size={18} />}
        </button>

        <div ref={menuRef} style={{ position: "relative", display: "inline-block" }}>
          <button
            type="button"
            aria-label="Choose a color theme"
            aria-expanded={showThemeMenu}
            className={`theme-toggle-btn ${showThemeMenu ? "active" : ""}`}
            onClick={() => setShowThemeMenu(!showThemeMenu)}
            title="Choose a custom color theme"
          >
            <Palette size={18} />
          </button>
          
          {showThemeMenu && (
            <div className="theme-dropdown-menu">
              <div className="theme-dropdown-header">Select Theme</div>
              <div className="theme-dropdown-divider"></div>
              {THEMES.map((t) => {
                const isActive = theme === t.id;
                return (
                  <button
                    key={t.id}
                    className={`theme-dropdown-item ${isActive ? "active" : ""}`}
                    onClick={() => {
                      setTheme(t.id);
                      setShowThemeMenu(false);
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%" }}>
                      <div style={{ display: "flex", gap: "2px" }}>
                        <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: t.primary }} />
                        <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: t.secondary }} />
                      </div>
                      <span className="theme-name-text">{t.name}</span>
                      {isActive && <Check size={12} style={{ marginLeft: "auto", color: "var(--md-sys-color-primary)" }} />}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>


      </div>
    </div>
  );
}

export default memo(TopStatusBar);
