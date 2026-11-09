import React, { memo, useMemo, useRef, useState, useEffect } from "react";
import { Image, Box, Mic, Settings, Trash2, AudioLines, SquarePen, PanelLeftClose, Search, X, ChevronRight } from "lucide-react";
import BrandMark from "./BrandMark";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 420;
const SIDEBAR_DEFAULT = 260;
const SIDEBAR_WIDTH_KEY = "sidebarWidth";

const clampWidth = (value) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(value)));

function readSidebarWidth() {
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return saved ? clampWidth(saved) : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatGb(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "--";
  return number.toFixed(number >= 10 ? 0 : 1);
}

function toTime(value) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

// Turns saved file names into readable titles:
// "tts-2026-06-26T14-30-13.wav" -> "Recording, Jun 26, 2:30 PM"; "meeting-recording.wav" -> "Meeting recording"
function friendlyFileTitle(name) {
  if (!name) return "";
  const base = String(name).replace(/\.(wav|mp3|m4a|ogg|flac|webm|txt|json)$/i, "");
  const stamp = base.match(/^[a-z]+-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/i);
  if (stamp) {
    const [, , month, day, hour, minute] = stamp;
    const h = Number(hour);
    const time = `${h % 12 || 12}:${minute} ${h < 12 ? "AM" : "PM"}`;
    return `Recording, ${MONTHS[Number(month) - 1]} ${Number(day)}, ${time}`;
  }
  const words = base.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Older chats were saved with titles cut at 26 characters plus "..."; rebuild them from the first message
function chatTitle(conv) {
  const title = conv.title || "";
  if (!title.endsWith("...")) return title || "Chat";
  const first = (conv.messages || []).find((m) => m.role === "user");
  const content = Array.isArray(first?.content)
    ? first.content.find((part) => part.type === "text")?.text
    : first?.content;
  const text = typeof content === "string" ? content.trim().split("\n")[0] : "";
  return text || title.slice(0, -3);
}

// Lets div-based rows respond to Enter/Space like real buttons (ignores keys from nested buttons)
function activateOnKey(e) {
  if (e.target !== e.currentTarget) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    e.currentTarget.click();
  }
}

const OPEN_SECTIONS_KEY = "sidebarOpenSections";

function readOpenSections() {
  try {
    return JSON.parse(localStorage.getItem(OPEN_SECTIONS_KEY)) || {};
  } catch {
    return {};
  }
}

function RecentSection({ id, label, items, isOpen, onToggle }) {
  if (items.length === 0) return null;
  const listId = `sidebar-section-${id}`;
  return (
    <section className="sidebar-section">
      <h2>
        <button
          type="button"
          className="sidebar-section-label"
          onClick={onToggle}
          aria-expanded={isOpen}
          aria-controls={listId}
        >
          <span>{label}</span>
          <span className="sidebar-section-count">{items.length}</span>
          <ChevronRight size={14} className="sidebar-section-chevron" aria-hidden="true" />
        </button>
      </h2>
      {isOpen && (
        <ul className="sidebar-recents-list" id={listId}>
        {items.map((item) => (
          <li key={item.key}>
            <div
              className={`sidebar-history-item ${item.isActive ? "active" : ""}`}
              role="button"
              tabIndex={0}
              aria-current={item.isActive ? "page" : undefined}
              onClick={item.open}
              onKeyDown={activateOnKey}
              title={item.title}
            >
              <span className="sidebar-history-title">{item.title}</span>
              <button
                type="button"
                className="sidebar-history-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  item.remove(e);
                }}
                aria-label={`${item.deleteLabel}: ${item.title}`}
                title={item.deleteLabel}
              >
                <Trash2 size={15} />
              </button>
            </div>
          </li>
        ))}
      </ul>
      )}
    </section>
  );
}

function Sidebar({
  collapsed = false,
  onToggleSidebar,
  activeTab,
  setActiveTab,
  specs,
  telemetry,
  onNewChat,
  conversations = [],
  activeConversationId,
  setActiveConversationId,
  onDeleteConversation,
  speechTranscriptions = [],
  selectedSpeechTranscript,
  setSelectedSpeechTranscript,
  onDeleteSpeechTranscription,
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef(null);
  const [width, setWidth] = useState(readSidebarWidth);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    } catch {}
  }, [width]);

  const startResize = (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    setResizing(true);
    document.body.style.cursor = "col-resize";
    const onMove = (moveEvent) => setWidth(clampWidth(startWidth + moveEvent.clientX - startX));
    const onUp = () => {
      setResizing(false);
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const resizeWithKeys = (event) => {
    const step = event.shiftKey ? 40 : 16;
    const nextWidth = {
      ArrowLeft: (current) => current - step,
      ArrowRight: (current) => current + step,
      Home: () => SIDEBAR_MIN,
      End: () => SIDEBAR_MAX,
    }[event.key];
    if (!nextWidth) return;
    event.preventDefault();
    setWidth((current) => clampWidth(nextWidth(current)));
  };

  // History sections start collapsed; remember which ones the user opened
  const [openSections, setOpenSections] = useState(readOpenSections);

  const toggleSection = (id) => {
    setOpenSections((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(OPEN_SECTIONS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
  };

  const sections = useMemo(() => {
    const speechId = (item) => item && (item.filename || item.metadata || item.textFile);
    const needle = query.trim().toLowerCase();
    const matches = (item) => !needle || item.title.toLowerCase().includes(needle);
    const newestFirst = (a, b) => b.time - a.time;

    const chats = conversations.map((conv) => ({
      key: `chat:${conv.id}`,
      title: chatTitle(conv),
      time: toTime(conv.timestamp),
      isActive: activeTab === "chat" && activeConversationId === conv.id,
      open: () => {
        setActiveConversationId(conv.id);
        setActiveTab("chat");
      },
      remove: (e) => onDeleteConversation(conv.id, e),
      deleteLabel: "Delete chat",
    }));

    const transcripts = speechTranscriptions.map((item) => ({
      key: `speech:${speechId(item)}`,
      title: friendlyFileTitle(item.displayName || item.sourceFilename || item.textFile || item.filename) || "Transcript",
      time: toTime(item.modifiedAt || item.createdAt),
      isActive: activeTab === "speech" && speechId(selectedSpeechTranscript) === speechId(item),
      open: () => {
        setSelectedSpeechTranscript(item);
        setActiveTab("speech");
      },
      remove: (e) => onDeleteSpeechTranscription?.(item, e),
      deleteLabel: "Delete transcription",
    }));

    return [
      { id: "chats", label: "Chats", items: chats.filter(matches).sort(newestFirst) },
      { id: "transcriptions", label: "Transcriptions", items: transcripts.filter(matches).sort(newestFirst) },
    ];
  }, [
    query, conversations, speechTranscriptions, activeTab, activeConversationId,
    selectedSpeechTranscript, setActiveTab, setActiveConversationId,
    setSelectedSpeechTranscript, onDeleteConversation, onDeleteSpeechTranscription
  ]);

  const navItems = [
    { tab: "generator", label: "Images", Icon: Image },
    { tab: "speech", label: "Transcribe", Icon: Mic },
    { tab: "tts", label: "Voice", Icon: AudioLines },
    { tab: "models", label: "Models", Icon: Box },
  ];

  const isNewChatActive = activeTab === "chat" && !activeConversationId;
  const deviceName = specs.gpu_name && !specs.gpu_name.startsWith("Loading") ? specs.gpu_name : specs.cpu_name;
  const hasResults = sections.some((section) => section.items.length > 0);

  return (
    <aside
      className={`sidebar ${collapsed ? "collapsed" : ""} ${resizing ? "resizing" : ""}`}
      style={{ "--sidebar-width": `${width}px` }}
      aria-label="Sidebar"
    >
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        aria-valuenow={width}
        tabIndex={0}
        title="Drag to resize, double-click to reset"
        onPointerDown={startResize}
        onDoubleClick={() => setWidth(SIDEBAR_DEFAULT)}
        onKeyDown={resizeWithKeys}
      />
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <BrandMark className="sidebar-mark" size={24} title="Local Studio" />
          <span className="sidebar-brand-name">Local Studio</span>
        </div>
        <div className="sidebar-header-actions">
          <button
            type="button"
            className={`sidebar-icon-btn ${searchOpen ? "active" : ""}`}
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            aria-label="Search history"
            aria-expanded={searchOpen}
            title="Search history"
          >
            <Search size={20} />
          </button>
          <button type="button" className="sidebar-icon-btn" onClick={onToggleSidebar} aria-label="Close sidebar" title="Close sidebar">
            <PanelLeftClose size={20} />
          </button>
        </div>
      </div>

      {searchOpen && (
        <div className="sidebar-search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && closeSearch()}
            placeholder="Search chats and recordings"
            aria-label="Search chats and recordings"
          />
          {query && (
            <button type="button" className="sidebar-search-clear" onClick={() => setQuery("")} aria-label="Clear search">
              <X size={14} />
            </button>
          )}
        </div>
      )}

      <nav className="nav-list" aria-label="Main">
        <div
          className={`nav-item ${isNewChatActive ? "active" : ""}`}
          role="button"
          tabIndex={0}
          aria-current={isNewChatActive ? "page" : undefined}
          onClick={onNewChat}
          onKeyDown={activateOnKey}
        >
          <SquarePen size={20} aria-hidden="true" />
          <span>New chat</span>
        </div>
        {navItems.map(({ tab, label, Icon }) => (
          <div
            key={tab}
            className={`nav-item ${activeTab === tab ? "active" : ""}`}
            role="button"
            tabIndex={0}
            aria-current={activeTab === tab ? "page" : undefined}
            onClick={() => setActiveTab(tab)}
            onKeyDown={activateOnKey}
          >
            <Icon size={20} aria-hidden="true" />
            <span>{label}</span>
          </div>
        ))}
      </nav>

      <div className="sidebar-recents">
        {sections.map((section) => (
          <RecentSection
            key={section.id}
            id={section.id}
            label={section.label}
            items={section.items}
            isOpen={Boolean(query.trim()) || Boolean(openSections[section.id])}
            onToggle={() => toggleSection(section.id)}
          />
        ))}
        {!hasResults && (
          <p className="sidebar-recents-empty">
            {query ? "No matches." : "Your chats and recordings will show up here."}
          </p>
        )}
      </div>

      <div className="sidebar-footer">
        <div
          className={`nav-item ${activeTab === "settings" ? "active" : ""}`}
          role="button"
          tabIndex={0}
          aria-current={activeTab === "settings" ? "page" : undefined}
          onClick={() => setActiveTab("settings")}
          onKeyDown={activateOnKey}
        >
          <Settings size={20} aria-hidden="true" />
          <span>Settings</span>
        </div>
        <div className="sidebar-device" title={`${specs.cpu_name} · ${specs.gpu_name} · ${specs.os_name}`}>
          <span className="sidebar-device-avatar" aria-hidden="true">
            {(deviceName || "PC").replace(/^Apple\s+/i, "").slice(0, 2).toUpperCase()}
          </span>
          <span className="sidebar-device-name">{deviceName}</span>
          <span className="sidebar-device-stats">
            {formatGb(telemetry?.ram_used_gb)}/{formatGb(telemetry?.ram_total_gb || specs.ram_total_gb)} GB
          </span>
        </div>
      </div>
    </aside>
  );
}

export default memo(Sidebar);
