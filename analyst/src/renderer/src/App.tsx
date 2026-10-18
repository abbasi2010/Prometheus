import { useEffect, useRef, useState } from "react";
import type { AgentEvent, Chip, Entry, EnvStatus, FilingLink, Quote, ReaderDoc, SelectionInfo, TabInfo } from "../../shared/types";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "status";
  text: string;
  chips?: Chip[];
  bad?: boolean;
};

const TAGS = ["Evidence", "Risk", "Thesis point", "Question", "Data"];

function uid(): string {
  return Math.random().toString(36).slice(2, 9);
}

function money(value?: number | null): string {
  if (value == null) return "";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function App() {
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      if (window.analyst) setBooted(true);
      else window.setTimeout(tick, 20);
    };
    tick();
    return () => {
      stopped = true;
    };
  }, []);
  if (!booted) return <p className="empty">Starting…</p>;
  return <Shell />;
}

function Shell() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [address, setAddress] = useState("");
  const [env, setEnv] = useState<EnvStatus | null>(null);
  const [companyInput, setCompanyInput] = useState("");
  const [company, setCompany] = useState("");
  const [companyTitle, setCompanyTitle] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [filings, setFilings] = useState<FilingLink[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [rail, setRail] = useState<"timeline" | "archive">("timeline");
  const [filter, setFilter] = useState("all");
  const [summary, setSummary] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [doc, setDoc] = useState<ReaderDoc | null>(null);
  const [highlight, setHighlight] = useState<SelectionInfo | null>(null);
  const [highlightNote, setHighlightNote] = useState("");
  const [highlightTag, setHighlightTag] = useState(TAGS[0]);
  const [highlightHint, setHighlightHint] = useState("");
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteBody, setPasteBody] = useState("");
  const [status, setStatus] = useState("");

  const active = tabs.find((tab) => tab.active) || null;

  useEffect(() => {
    void window.analyst.env().then(setEnv);
    void window.analyst.tabs.snapshot().then((snap) => setTabs(snap.tabs));
    const offTabs = window.analyst.tabs.onChange((snap) => setTabs(snap.tabs));
    const offError = window.analyst.tabs.onError((payload) => setStatus(payload.text));
    const offHighlight = window.analyst.onHighlight(() => void grabSelection());
    const offAgent = window.analyst.agent.onEvent(onAgent);
    const offCo = window.analyst.onCompanyResolved((row) => {
      setCompany(row.ticker.toUpperCase());
      setCompanyTitle(row.title);
      setCompanyInput(row.ticker);
    });
    return () => {
      offTabs();
      offError();
      offHighlight();
      offAgent();
      offCo();
    };
    // company is read when the notebook pings; the listener is refreshed below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return window.analyst.notebook.onChange(() => {
      if (company) void window.analyst.notebook.list(company).then(setEntries);
    });
  }, [company]);

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const send = () => {
      const rect = node.getBoundingClientRect();
      window.analyst.tabs.setBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    };
    send();
    const observer = new ResizeObserver(send);
    observer.observe(node);
    window.addEventListener("resize", send);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", send);
    };
  }, [active?.id, active?.kind, active?.url]);

  useEffect(() => {
    if (active?.kind === "web") setAddress(active.url || "");
    if (active?.kind === "reader" && active.docId) {
      void window.analyst.docs.get(active.docId).then(setDoc);
      setAddress(active.url || active.title);
    } else {
      setDoc(null);
    }
  }, [active?.id, active?.kind, active?.docId, active?.url, active?.anchor, active?.title]);

  function onAgent(event: AgentEvent) {
    if (event.type === "user") {
      setMessages((items) => [...items, { id: uid(), role: "user", text: event.text }]);
    } else if (event.type === "progress") {
      setMessages((items) => [...items, { id: uid(), role: "status", text: event.text }]);
    } else if (event.type === "error") {
      setMessages((items) => [...items, { id: uid(), role: "status", text: event.text, bad: true }]);
    } else if (event.type === "token") {
      setMessages((items) => {
        const copy = [...items];
        const last = copy[copy.length - 1];
        if (!last || last.role !== "assistant") copy.push({ id: uid(), role: "assistant", text: event.text, chips: [] });
        else copy[copy.length - 1] = { ...last, text: last.text + event.text };
        return copy;
      });
    } else if (event.type === "source") {
      if (event.chip.url) void window.analyst.tabs.openUrl(event.chip.url);
      else if (event.chip.docId) void window.analyst.docs.open(event.chip.docId, event.chip.anchor);
      setMessages((items) => {
        const copy = [...items];
        let index = copy.length - 1;
        if (index < 0 || copy[index].role !== "assistant") {
          copy.push({ id: uid(), role: "assistant", text: "", chips: [] });
          index = copy.length - 1;
        }
        const chips = copy[index].chips || [];
        if (!chips.some((chip) => chip.url === event.chip.url && chip.docId === event.chip.docId && chip.label === event.chip.label)) {
          copy[index] = { ...copy[index], chips: [...chips, event.chip] };
        }
        return copy;
      });
    } else if (event.type === "summary-token") {
      setSummary((text) => text + event.text);
    } else if (event.type === "summary-done") {
      setStatus("");
    }
  }

  async function chooseCompany() {
    const name = companyInput.trim();
    if (!name) return;
    setStatus("");
    const row = await window.analyst.company.resolve(name);
    const ticker = row?.ticker || (/^[A-Za-z.]{1,6}$/.test(name) ? name.toUpperCase() : "");
    if (!ticker) {
      setStatus(`Couldn't find ${name} in the SEC company list.`);
      return;
    }
    setCompany(ticker);
    setCompanyTitle(row?.title || ticker);
    window.analyst.company.set(ticker);
    setFilings([]);
    setSummary("");
    void window.analyst.notebook.list(ticker).then(setEntries);
    try {
      setQuote(await window.analyst.company.quote(ticker));
    } catch (error) {
      setQuote(null);
      setStatus(error instanceof Error ? error.message : "Quote failed.");
    }
  }

  async function loadFilings() {
    if (!company) return;
    try {
      setFilings(await window.analyst.company.filings(company));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Couldn't list filings.");
    }
  }

  async function grabSelection() {
    const selection = await window.analyst.selection.current();
    if (!selection) {
      setHighlight(null);
      setHighlightHint("Select text in the page or filing, then click Highlight.");
      return;
    }
    setHighlight(selection);
    setHighlightHint("");
    setHighlightNote("");
  }

  async function saveHighlight() {
    if (!highlight || !company) {
      setHighlightHint(company ? "Select text first." : "Choose a company first.");
      return;
    }
    const next = await window.analyst.notebook.highlight({
      company,
      text: highlight.text,
      context: highlight.context,
      note: highlightNote,
      tag: highlightTag,
      url: highlight.url,
      title: highlight.title,
      anchor: highlight.anchor,
      docId: highlight.docId,
    });
    setEntries(next);
    setHighlight(null);
  }

  function send() {
    const text = question.trim();
    if (!text) return;
    setQuestion("");
    window.analyst.agent.ask(text, company);
  }

  function openChip(chip: Chip) {
    if (chip.docId) void window.analyst.docs.open(chip.docId, chip.anchor);
    else if (chip.url) void window.analyst.tabs.openUrl(chip.url);
  }

  const shown = entries.filter((entry) => {
    if (rail === "archive" && !entry.pinned) return false;
    if (filter === "all") return true;
    if (filter === "highlights") return entry.type === "highlight";
    if (filter === "sources") return entry.type === "page" || entry.type === "source";
    return entry.type === "finding" || entry.type === "question";
  });

  return (
    <div className="app">
      <aside className="left">
        <p className="mark">Prometheus</p>
        <div className="company">
          <input
            value={companyInput}
            placeholder="Ticker or company"
            onChange={(event) => setCompanyInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void chooseCompany();
            }}
          />
          <button className="solid" onClick={() => void chooseCompany()}>Go</button>
        </div>
        {companyTitle && <p className="company-name">{companyTitle}</p>}
        {quote?.price != null && (
          <p className="price">
            {quote.currency === "USD" || !quote.currency ? "$" : ""}
            {quote.price.toFixed(2)}
            {quote.changePercent != null && ` · ${quote.changePercent}% over the past year, from ${quote.from} to ${quote.to}`}
            {quote.marketCap ? ` · ${money(quote.marketCap)} market cap` : ""}
          </p>
        )}
        <div className="actions">
          <button className="ghost" disabled={!company} onClick={() => void loadFilings()}>Filings</button>
          <button className="ghost" disabled={!company} onClick={() => window.analyst.agent.overview(company)}>Quick overview</button>
        </div>
        <div className="filings">
          {filings.map((filing) => (
            <button key={filing.url} className="ghost" onClick={() => void window.analyst.company.openFiling(filing.url, `${company} ${filing.label}`)}>
              {filing.label}
            </button>
          ))}
        </div>
        {env && (!env.groq || !env.tavily || !env.sec) && (
          <p className="notice">
            Add the missing keys in <code>{env.envPath}</code>, then restart. Groq {env.groq ? "is set" : "is missing"}. Tavily {env.tavily ? "is set" : "is missing"}. SEC email {env.sec ? "is set" : "is missing"}.
          </p>
        )}
        {status && <p className="notice">{status}</p>}
        <div className="rail-head">
          <button className="ghost" data-on={rail === "timeline"} onClick={() => setRail("timeline")}>Timeline</button>
          <button className="ghost" data-on={rail === "archive"} onClick={() => setRail("archive")}>Archive</button>
          <button className="ghost" disabled={!company} onClick={() => { setSummary(""); window.analyst.agent.summary(company); }}>Summarize</button>
        </div>
        <select value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="all">All</option>
          <option value="highlights">Highlights</option>
          <option value="sources">Sources</option>
          <option value="notes">Questions and findings</option>
        </select>
        {summary && <p className="summary">{summary}</p>}
        {shown.map((entry) => (
          <article key={entry.id} className="entry">
            <div className="meta">{new Date(entry.at).toLocaleString()} · {entry.type}{entry.tag ? ` · ${entry.tag}` : ""}{entry.pinned ? " · pinned" : ""}</div>
            <p>{entry.title}</p>
            {entry.text && <p>{entry.text.slice(0, 220)}</p>}
            {entry.note && <p>{entry.note}</p>}
            <div className="row">
              <button className="ghost" onClick={() => void window.analyst.notebook.open(entry.id)}>Open</button>
              <button className="ghost" onClick={() => void window.analyst.notebook.pin(entry.id, company).then(setEntries)}>Pin</button>
              <button className="ghost" onClick={() => void window.analyst.notebook.remove(entry.id, company).then(setEntries)}>Delete</button>
            </div>
          </article>
        ))}
        <form
          className="paste"
          onSubmit={(event) => {
            event.preventDefault();
            if (!pasteBody.trim()) return;
            void window.analyst.notebook.paste(company, pasteTitle, pasteBody);
            setPasteBody("");
            setPasteTitle("");
          }}
        >
          <input value={pasteTitle} placeholder="Paste a transcript or note" onChange={(event) => setPasteTitle(event.target.value)} />
          <textarea value={pasteBody} onChange={(event) => setPasteBody(event.target.value)} />
          <button className="ghost" type="submit">Add to reader</button>
        </form>
      </aside>
      <section className="center">
        <div className="tabstrip">
          {tabs.map((tab) => (
            <div key={tab.id} className={tab.active ? "tab active" : "tab"}>
              <button className="tab" onClick={() => void window.analyst.tabs.activate(tab.id)}>
                <span>{tab.title || "New tab"}</span>
              </button>
              <button className="x" onClick={() => void window.analyst.tabs.close(tab.id)}>×</button>
            </div>
          ))}
          <button className="icon" onClick={() => void window.analyst.tabs.newTab()}>+</button>
        </div>
        <form
          className="toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            if (!active) return;
            void window.analyst.tabs.navigate(active.id, address).then((snap) => setTabs(snap.tabs));
          }}
        >
          <button type="button" className="icon" disabled={active?.kind !== "web"} onClick={() => void window.analyst.tabs.back()}>←</button>
          <button type="button" className="icon" disabled={active?.kind !== "web"} onClick={() => void window.analyst.tabs.forward()}>→</button>
          <button type="button" className="icon" disabled={active?.kind !== "web"} onClick={() => void window.analyst.tabs.reload()}>↻</button>
          <input className="address" value={address} placeholder="URL or search" onChange={(event) => setAddress(event.target.value)} />
          <button className="ghost" type="button" onClick={() => void grabSelection()}>Highlight</button>
        </form>
        <div className="stage" ref={stageRef}>
          {active?.kind === "reader" && doc && <Reader doc={doc} anchor={active.anchor} onSelect={(selection) => window.analyst.selection.remember(selection)} />}
          {active?.kind !== "reader" && !active?.url && <p className="empty">Type a URL or a search. Filings open in the reader.</p>}
        </div>
      </section>
      <aside className="right">
        <div className="highlight-form">
          <strong>Highlight</strong>
          <p className="hint">Select text, then click Highlight or press Shift-Command-H. The note stays in this panel.</p>
          {highlightHint && <p className="hint">{highlightHint}</p>}
          {highlight && (
            <>
              <p className="quote">{highlight.text}</p>
              <input value={highlightNote} placeholder="Note, optional" onChange={(event) => setHighlightNote(event.target.value)} />
              <div className="row">
                <select value={highlightTag} onChange={(event) => setHighlightTag(event.target.value)}>
                  {TAGS.map((tag) => <option key={tag}>{tag}</option>)}
                </select>
                <button className="solid" type="button" onClick={() => void saveHighlight()}>Save</button>
              </div>
            </>
          )}
        </div>
        <div className="transcript">
          {messages.map((message) => (
            <div key={message.id} className={`bubble ${message.role}${message.bad ? " error" : ""}`}>
              {message.role === "assistant" && message.text && (
                <>
                  <p>{message.text}</p>
                  <button className="ghost" onClick={() => void window.analyst.notebook.finding(company, message.text).then(setEntries)}>Pin finding</button>
                </>
              )}
              {message.role !== "assistant" && <p>{message.text}</p>}
              {!!message.chips?.length && (
                <div className="chips">
                  {message.chips.map((chip, index) => (
                    <button key={`${chip.url || chip.docId}-${index}`} className="chip" onClick={() => openChip(chip)}>{chip.label}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <form
          className="ask"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <textarea
            value={question}
            placeholder="Ask about the company, the filing, or the page"
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
          <button className="solid" type="submit">Ask</button>
        </form>
      </aside>
    </div>
  );
}

function Reader({
  doc,
  anchor,
  onSelect,
}: {
  doc: ReaderDoc;
  anchor?: string;
  onSelect: (selection: SelectionInfo) => void;
}) {
  const match = doc.sections.find((section) => section.id === anchor || section.paragraphs.some((p) => p.id === anchor));
  const [sectionId, setSectionId] = useState(match?.id || doc.sections[0]?.id || "");
  useEffect(() => {
    if (match) setSectionId(match.id);
  }, [match, doc.id]);
  useEffect(() => {
    if (!anchor) return;
    document.getElementById(anchor)?.scrollIntoView({ block: "center" });
  }, [anchor, sectionId]);
  const section = doc.sections.find((item) => item.id === sectionId) || doc.sections[0];
  return (
    <article
      className="reader"
      onMouseUp={() => {
        const selection = window.getSelection();
        const text = selection?.toString().replace(/\s+/g, " ").trim() || "";
        if (text.length < 2) return;
        const parent = selection?.anchorNode?.parentElement?.closest("[data-anchor]");
        onSelect({
          text,
          context: (parent?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500),
          url: doc.url,
          title: doc.title,
          anchor: parent?.getAttribute("data-anchor") || undefined,
          docId: doc.id,
        });
      }}
    >
      <h2>{doc.title}</h2>
      <div className="reader-nav">
        {doc.sections.map((item) => (
          <button key={item.id} className="ghost" onClick={() => setSectionId(item.id)}>{item.title.replace(/\s+/g, " ").slice(0, 42)}</button>
        ))}
      </div>
      <div className="reader-body">
        {section?.paragraphs.map((paragraph) => (
          <p key={paragraph.id} id={paragraph.id} data-anchor={paragraph.id} className={paragraph.id === anchor ? "hit" : ""}>
            {paragraph.text}
          </p>
        ))}
      </div>
    </article>
  );
}
