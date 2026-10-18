import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { companies, filingBody, notes, stand, type Company, type Note } from "./mock";

type Kind = "overview" | "sources" | "highlights" | "notebook" | "archive" | "chats" | "page";
type Tab = { id: string; kind: Kind; title: string };
type Theme = "system" | "light" | "dark";
type Bubble = { role: "user" | "assistant"; text: string };

const nav: { kind: Kind; title: string }[] = [
  { kind: "overview", title: "Overview" },
  { kind: "sources", title: "Sources" },
  { kind: "highlights", title: "Highlights" },
  { kind: "notebook", title: "Notebook" },
  { kind: "archive", title: "Archive" },
  { kind: "chats", title: "Chats" },
];

function uid(): string {
  return Math.random().toString(36).slice(2, 8);
}

function seed(company: Company): Tab[] {
  if (company.id === "uber") {
    return [
      { id: "uber-overview", kind: "overview", title: "Overview" },
      { id: "uber-10k", kind: "page", title: "UBER 10-K 2025" },
      { id: "uber-notebook", kind: "notebook", title: "Notebook" },
    ];
  }
  return [{ id: `${company.id}-overview`, kind: "overview", title: "Overview" }];
}

export function Shell() {
  const [theme, setTheme] = useState<Theme>("system");
  const [darkSystem, setDarkSystem] = useState(window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [screen, setScreen] = useState<"home" | string>("home");
  const [openCompanies, setOpenCompanies] = useState<string[]>(["uber"]);
  const [sideOpen, setSideOpen] = useState(true);
  const [agentOpen, setAgentOpen] = useState(false);
  const [tabs, setTabs] = useState<Record<string, Tab[]>>(() => Object.fromEntries(companies.map((c) => [c.id, seed(c)])));
  const [active, setActive] = useState<Record<string, string>>({ uber: "uber-10k", lyft: "lyft-overview" });
  const [palette, setPalette] = useState(false);
  const [query, setQuery] = useState("");
  const [pick, setPick] = useState(0);
  const [homeChat, setHomeChat] = useState<Bubble[]>([
    { role: "assistant", text: "Ask about a market, a company, or something you saved. This preview does not call the model yet." },
  ]);
  const [draft, setDraft] = useState("");
  const [agentDraft, setAgentDraft] = useState("");
  const [companyChat, setCompanyChat] = useState<Record<string, Bubble[]>>({
    uber: [{ role: "assistant", text: "Opened UBER 10-K 2025. The model is not connected in this preview." }],
  });
  const [filter, setFilter] = useState("All");
  const [expanded, setExpanded] = useState<string | null>("n1");
  const [toolbar, setToolbar] = useState<{ x: number; y: number; text: string } | null>(null);
  const [popover, setPopover] = useState<{ x: number; y: number; mark: HTMLElement } | null>(null);
  const [comment, setComment] = useState("Watch the lawsuit");

  const company = companies.find((item) => item.id === screen) || null;

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setDarkSystem(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const dark = theme === "dark" || (theme === "system" && darkSystem);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [theme, darkSystem]);

  useEffect(() => {
    window.analyst?.tabs.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette(true);
        setQuery("");
        setPick(0);
      } else if (event.key === "Escape") setPalette(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function goHome() {
    setScreen("home");
    setAgentOpen(false);
  }

  function goCompany(id: string) {
    setScreen(id);
    setAgentOpen(true);
    setOpenCompanies((ids) => (ids.includes(id) ? ids : [...ids, id]));
  }

  function openTab(companyId: string, kind: Kind, title: string) {
    goCompany(companyId);
    setTabs((all) => {
      const list = all[companyId] || [];
      const found = list.find((tab) => tab.kind === kind && (kind !== "page" || tab.title === title));
      if (found) {
        setActive((map) => ({ ...map, [companyId]: found.id }));
        return all;
      }
      const tab = { id: uid(), kind, title };
      setActive((map) => ({ ...map, [companyId]: tab.id }));
      return { ...all, [companyId]: [...list, tab] };
    });
  }

  function closeTab(companyId: string, id: string) {
    setTabs((all) => {
      const list = (all[companyId] || []).filter((tab) => tab.id !== id);
      const next = list.length ? list : [{ id: uid(), kind: "overview" as Kind, title: "Overview" }];
      setActive((map) => ({ ...map, [companyId]: map[companyId] === id ? next[next.length - 1].id : map[companyId] }));
      return { ...all, [companyId]: next };
    });
  }

  const commands = useMemo(() => {
    const rows: { label: string; run: () => void }[] = [];
    if (query.trim()) {
      rows.push({
        label: `Ask the agent: ${query.trim()}`,
        run: () => {
          const text = query.trim();
          if (screen === "home") {
            setDraft(text);
            setAgentOpen(false);
          } else {
            setAgentOpen(true);
            setAgentDraft(text);
          }
        },
      });
    }
    for (const item of companies) {
      if (!query || item.name.toLowerCase().includes(query.toLowerCase()) || item.ticker.toLowerCase().includes(query.toLowerCase())) {
        rows.push({ label: item.name, run: () => goCompany(item.id) });
      }
    }
    for (const tab of Object.values(tabs).flat()) {
      if (query && tab.title.toLowerCase().includes(query.toLowerCase())) {
        const owner = Object.entries(tabs).find(([, list]) => list.includes(tab))?.[0];
        if (owner) rows.push({ label: tab.title, run: () => openTab(owner, tab.kind, tab.title) });
      }
    }
    if (!query || "new company".includes(query.toLowerCase())) rows.push({ label: "New company", run: () => goCompany("lyft") });
    return rows;
  }, [query, tabs, screen]);

  function paintSelection() {
    const selection = window.getSelection();
    const text = selection?.toString().replace(/\s+/g, " ").trim() || "";
    if (!selection || selection.rangeCount === 0 || text.length < 2) return;
    const range = selection.getRangeAt(0);
    const mark = document.createElement("mark");
    mark.className = "hl";
    mark.title = comment;
    try {
      range.surroundContents(mark);
    } catch {
      return;
    }
    selection.removeAllRanges();
    setToolbar(null);
  }

  const list = company ? tabs[company.id] || [] : [];
  const current = company ? active[company.id] : "";
  const companyNotes = notes.filter((note) => note.companyId === company?.id && (filter === "All" || note.tag === filter));

  return (
    <div className="shell" data-side={sideOpen ? "open" : "closed"} data-agent={agentOpen ? "open" : "closed"}>
      {sideOpen ? (
        <aside className="side">
          <div className="side-scroll">
            <p className="brand">
              Analyst
              <button className="icon" title="Hide sidebar" onClick={() => setSideOpen(false)}>‹</button>
            </p>
            <input className="search" placeholder="Search" onFocus={() => setPalette(true)} readOnly />
            <button className="nav-btn" data-on={screen === "home"} onClick={goHome}>Home</button>
            <p className="meta">Companies</p>
            {companies.map((item) => (
              <div key={item.id}>
                <button className="nav-btn company-row" data-on={screen === item.id} onClick={() => (openCompanies.includes(item.id) ? goCompany(item.id) : setOpenCompanies((ids) => [...ids, item.id]))}>
                  {openCompanies.includes(item.id) ? "▾" : "▸"} {item.name}
                </button>
                {openCompanies.includes(item.id) && nav.map((entry) => (
                  <button key={entry.kind} className="tree-btn" data-on={screen === item.id && list.find((tab) => tab.id === current)?.kind === entry.kind} onClick={() => openTab(item.id, entry.kind, entry.title)}>
                    {entry.title}
                  </button>
                ))}
              </div>
            ))}
            <button className="add" onClick={() => goCompany("lyft")}>+ Add company</button>
          </div>
          <div className="side-foot">
            {(["system", "light", "dark"] as Theme[]).map((mode) => (
              <button key={mode} className="icon" data-on={theme === mode} title={mode} onClick={() => setTheme(mode)}>{mode[0].toUpperCase()}</button>
            ))}
          </div>
        </aside>
      ) : (
        <div className="rail"><button className="icon" title="Show sidebar" onClick={() => setSideOpen(true)}>›</button></div>
      )}

      <main className="center">
        <div className="top">
          {sideOpen && <button className="icon" title="Hide sidebar" onClick={() => setSideOpen(false)}>‹</button>}
          {screen === "home" ? <h1>Home</h1> : company && (
            <>
              <h1>{company.name}</h1>
              <span className="price">${company.price} · {company.change}</span>
              <input className="address" defaultValue="https://www.sec.gov/Archives/edgar/data/1543151/" aria-label="Address" />
            </>
          )}
          <button className="icon" title={agentOpen ? "Hide agent" : "Show agent"} onClick={() => setAgentOpen((open) => !open)}>{agentOpen ? "›" : "‹"}</button>
        </div>
        {screen === "home" ? (
          <div className="home">
            <div className="cards">
              {companies.map((item) => (
                <button key={item.id} className="card" onClick={() => goCompany(item.id)}>
                  <strong>{item.name}</strong>
                  <span>${item.price} · {item.change}</span>
                </button>
              ))}
            </div>
            <Chat messages={homeChat} draft={draft} setDraft={setDraft} onSend={(text) => {
              setHomeChat((items) => [...items, { role: "user", text }, { role: "assistant", text: "Preview only. The agent is not connected yet." }]);
              setDraft("");
            }} />
          </div>
        ) : company && (
          <>
            <div className="tabs">
              {list.map((tab) => (
                <div key={tab.id} className="tab" data-on={tab.id === current} onMouseDown={(event) => { if (event.button === 1) { event.preventDefault(); closeTab(company.id, tab.id); } }}>
                  <button className="tab" onClick={() => setActive((map) => ({ ...map, [company.id]: tab.id }))}><span>{tab.title}</span></button>
                  <button className="x" onClick={() => closeTab(company.id, tab.id)}>×</button>
                </div>
              ))}
            </div>
            <div className="stage">
              {list.map((tab) => (
                <section key={tab.id} className="pane" data-on={tab.id === current}>
                  {tab.kind === "page" && <Filing onSelect={setToolbar} onMark={(event, mark) => { setPopover({ x: event.clientX, y: event.clientY, mark }); setToolbar(null); }} />}
                  {tab.kind === "sources" && (
                    <div className="paper">
                      <h2>Sources</h2>
                      <button className="row-btn" onClick={() => openTab(company.id, "page", `${company.ticker} 10-K 2025`)}>{company.ticker} 10-K 2025</button>
                    </div>
                  )}
                  {tab.kind === "overview" && <div className="paper"><h2>Overview</h2><p>{stand[company.id]}</p><p className="preview-note">A chart comes later. This is the snapshot.</p></div>}
                  {tab.kind === "notebook" && <Notebook title="Notebook" companyId={company.id} filter={filter} setFilter={setFilter} expanded={expanded} setExpanded={setExpanded} items={companyNotes} />}
                  {tab.kind === "highlights" && <Notebook title="Highlights" companyId={company.id} filter={filter} setFilter={setFilter} expanded={expanded} setExpanded={setExpanded} items={companyNotes.filter((note) => note.tag !== "Question")} />}
                  {tab.kind === "archive" && <div className="paper"><h2>Archive</h2><p>Pinned sources will live here. Nothing is pinned in this preview.</p></div>}
                  {tab.kind === "chats" && <div className="paper"><h2>Chats</h2><p>This company's conversations will be listed here.</p></div>}
                </section>
              ))}
            </div>
          </>
        )}
      </main>

      {agentOpen ? (
        <aside className="agent">
          <div className="agent-scroll">
            <p className="brand">
              Agent
              <button className="icon" title="Hide agent" onClick={() => setAgentOpen(false)}>›</button>
            </p>
            <p className="meta">Opened UBER 10-K 2025</p>
            <Chat
              messages={company ? companyChat[company.id] || [] : homeChat}
              draft={agentDraft}
              setDraft={setAgentDraft}
              onSend={(text) => {
                const reply = { role: "assistant" as const, text: "Preview only. The agent is not connected yet." };
                if (company) setCompanyChat((all) => ({ ...all, [company.id]: [...(all[company.id] || []), { role: "user", text }, reply] }));
                setAgentDraft("");
              }}
            />
          </div>
        </aside>
      ) : (
        <div className="rail"><button className="icon" title="Show agent" onClick={() => setAgentOpen(true)}>‹</button></div>
      )}

      {toolbar && (
        <div className="float" style={{ left: toolbar.x, top: toolbar.y }}>
          <button className="solid" onMouseDown={(event) => event.preventDefault()} onClick={paintSelection}>Highlight</button>
        </div>
      )}
      {popover && (
        <div className="float" style={{ left: popover.x, top: popover.y }}>
          <input value={comment} onChange={(event) => { setComment(event.target.value); popover.mark.title = event.target.value; }} />
          <button className="row-btn" onClick={() => { popover.mark.replaceWith(...popover.mark.childNodes); setPopover(null); }}>Remove</button>
        </div>
      )}
      {palette && (
        <>
          <div className="scrim" onClick={() => setPalette(false)} />
          <div className="palette">
            <input autoFocus placeholder="Search companies, sources, commands" value={query} onChange={(event) => { setQuery(event.target.value); setPick(0); }} onKeyDown={(event) => {
              if (event.key === "ArrowDown") setPick((n) => Math.min(commands.length - 1, n + 1));
              if (event.key === "ArrowUp") setPick((n) => Math.max(0, n - 1));
              if (event.key === "Enter" && commands[pick]) { commands[pick].run(); setPalette(false); }
            }} />
            {commands.slice(0, 8).map((command, index) => (
              <button key={command.label} data-on={index === pick} onClick={() => { command.run(); setPalette(false); }}>{command.label}</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Chat({ messages, draft, setDraft, onSend }: { messages: Bubble[]; draft: string; setDraft: (value: string) => void; onSend: (text: string) => void }) {
  return (
    <div className="chat">
      <div className="transcript">
        {messages.map((message, index) => <p key={index} className={`bubble ${message.role}`}>{message.text}</p>)}
      </div>
      <form className="ask" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) onSend(draft.trim()); }}>
        <textarea value={draft} placeholder="Ask" onChange={(event) => setDraft(event.target.value)} />
        <button className="solid" type="submit">Ask</button>
      </form>
    </div>
  );
}

function Filing({ onSelect, onMark }: { onSelect: (box: { x: number; y: number; text: string } | null) => void; onMark: (event: MouseEvent, mark: HTMLElement) => void }) {
  return (
    <article className="paper reader" onMouseUp={() => {
      const selection = window.getSelection();
      const text = selection?.toString().replace(/\s+/g, " ").trim() || "";
      if (!selection || selection.rangeCount === 0 || text.length < 2) { onSelect(null); return; }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      onSelect({ x: rect.left, y: Math.max(8, rect.top - 40), text });
    }}>
      <p className="preview-note">Preview page, so you can judge the layout. Real filings open in the next step.</p>
      <h2>UBER 10-K 2025</h2>
      {filingBody.map((paragraph) => (
        <p key={paragraph.slice(0, 24)} onClick={(event) => {
          const mark = (event.target as HTMLElement).closest("mark");
          if (mark) onMark(event, mark);
        }}>{paragraph}</p>
      ))}
    </article>
  );
}

function Notebook({ title, companyId, filter, setFilter, expanded, setExpanded, items }: { title: string; companyId: string; filter: string; setFilter: (value: string) => void; expanded: string | null; setExpanded: (id: string | null) => void; items: Note[] }) {
  const tags = ["All", "Evidence", "Risk", "Thesis point", "Question", "Data"];
  return (
    <div className="paper">
      <h2>{title}</h2>
      {title === "Notebook" && <p className="summary">{stand[companyId]}</p>}
      <div className="filters">
        {tags.map((tag) => <button key={tag} className="row-btn" data-on={filter === tag} onClick={() => setFilter(tag)}>{tag}</button>)}
      </div>
      {items.map((note) => (
        <article key={note.id} className="item">
          <button className="line" onClick={() => setExpanded(expanded === note.id ? null : note.id)}>
            <span className="meta">{note.tag} · {note.source}</span>
            <div>{note.line}</div>
          </button>
          {expanded === note.id && <p>{note.detail}</p>}
        </article>
      ))}
    </div>
  );
}
