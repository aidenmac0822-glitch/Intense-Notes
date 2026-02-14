import { useEffect, useMemo, useRef, useState } from "react";
import { auth, provider, db } from "./firebase";
import {
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { extractPdfText } from "./lib/pdf";

/* ---------------- helpers ---------------- */
function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}
function normalize(s) {
  return String(s || "").toLowerCase();
}
function ymd(d) {
  const dt = new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addMonths(date, delta) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}
function monthLabel(date) {
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
function buildMonthGrid(date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const startDow = first.getDay(); // Sun=0
  const start = new Date(first);
  start.setDate(first.getDate() - startDow);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const cell = new Date(start);
    cell.setDate(start.getDate() + i);
    cells.push(cell);
  }
  return cells;
}

/* ---------------- App ---------------- */
export default function App() {
  const [user, setUser] = useState(null);

  // 🌗 Theme (persistent)
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("theme");
    return saved === "light" || saved === "dark" ? saved : "dark";
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  // Auth (mobile-safe redirect completion)
  useEffect(() => {
    getRedirectResult(auth).catch(() => {});
  }, []);

  // App data
  const [notes, setNotes] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [cards, setCards] = useState([]);

  const [activeNoteId, setActiveNoteId] = useState(null);
  const activeNote = useMemo(
    () => notes.find((n) => n.id === activeNoteId) || null,
    [notes, activeNoteId]
  );

  // Editor drafts
  const [draftTitle, setDraftTitle] = useState("");
  const [draftClass, setDraftClass] = useState("");
  const [draftBody, setDraftBody] = useState("");

  // Search / folders
  const [noteSearch, setNoteSearch] = useState("");
  const [classFilter, setClassFilter] = useState("ALL");

  // Tasks
  const [taskTitle, setTaskTitle] = useState("");
  const [taskClass, setTaskClass] = useState("");
  const [taskDue, setTaskDue] = useState("");

  // Calendar
  const [calMonth, setCalMonth] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState(null);

  // Flashcards study
  const [studyMode, setStudyMode] = useState(false);
  const [studyIndex, setStudyIndex] = useState(0);
  const [studyFlipped, setStudyFlipped] = useState(false);
  const [studyOnlyThisNote, setStudyOnlyThisNote] = useState(false);

  // Transcript
  const [transcript, setTranscript] = useState("");
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);
  const speechRef = useRef(null);

  // Busy + save status
  const [busy, setBusy] = useState("");
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
  const saveDebounceRef = useRef(null);
  const ignoreAutosaveRef = useRef(false);

  // Auth listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u || null));
    return () => unsub();
  }, []);

  // Firestore live sync
  useEffect(() => {
    if (!user) return;

    const notesQ = query(
      collection(db, "users", user.uid, "notes"),
      orderBy("updatedAt", "desc")
    );
    const tasksQ = query(
      collection(db, "users", user.uid, "tasks"),
      orderBy("due", "asc")
    );
    const cardsQ = query(
      collection(db, "users", user.uid, "flashcards"),
      orderBy("createdAt", "desc")
    );

    const unsubNotes = onSnapshot(notesQ, (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setNotes(list);
      setActiveNoteId((prev) => prev ?? list[0]?.id ?? null);
    });

    const unsubTasks = onSnapshot(tasksQ, (snap) => {
      setTasks(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });

    const unsubCards = onSnapshot(cardsQ, (snap) => {
      setCards(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });

    return () => {
      unsubNotes();
      unsubTasks();
      unsubCards();
    };
  }, [user]);

  // Load drafts when switching notes
  useEffect(() => {
    if (!activeNote) return;

    ignoreAutosaveRef.current = true;
    setDraftTitle(activeNote.title || "");
    setDraftClass(activeNote.className || "");
    setDraftBody(activeNote.body || "");
    setSaveState("idle");

    // allow autosave after state updates settle
    setTimeout(() => {
      ignoreAutosaveRef.current = false;
    }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNoteId]);

  // Speech recognition init
  useEffect(() => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSpeechSupported(false);
      return;
    }
    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";

    rec.onresult = (event) => {
      let finalText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) finalText += event.results[i][0].transcript + " ";
      }
      if (finalText) setTranscript((p) => p + finalText);
    };

    rec.onerror = () => setIsTranscribing(false);
    rec.onend = () => setIsTranscribing(false);

    speechRef.current = rec;
    return () => {
      try {
        rec.stop();
      } catch {}
    };
  }, []);

  // Folder list
  const classFolders = useMemo(() => {
    const set = new Set();
    for (const n of notes) {
      const c = (n.className || "").trim();
      if (c) set.add(c);
    }
    return ["ALL", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [notes]);

  // Filter + sort notes (pinned first, then most recent)
  const filteredNotes = useMemo(() => {
    const q = normalize(noteSearch);
    const cf = classFilter;

    const list = notes.filter((n) => {
      const matchesClass =
        cf === "ALL" ? true : (n.className || "").trim() === cf;

      if (!q) return matchesClass;

      const hay = normalize(`${n.title} ${n.className} ${n.body}`);
      return matchesClass && hay.includes(q);
    });

    return list.sort((a, b) => {
      const ap = !!a.pinned;
      const bp = !!b.pinned;
      if (ap !== bp) return ap ? -1 : 1;

      const at = a.updatedAt?.seconds ? a.updatedAt.seconds : 0;
      const bt = b.updatedAt?.seconds ? b.updatedAt.seconds : 0;
      return bt - at;
    });
  }, [notes, noteSearch, classFilter]);

  // Calendar map
  const tasksByDate = useMemo(() => {
    const map = new Map();
    for (const t of tasks) {
      if (!t?.due) continue;
      if (!map.has(t.due)) map.set(t.due, []);
      map.get(t.due).push(t);
    }
    return map;
  }, [tasks]);

  // Study deck
  const studyDeck = useMemo(() => {
    return studyOnlyThisNote && activeNoteId
      ? cards.filter((c) => c.noteId === activeNoteId)
      : cards;
  }, [cards, studyOnlyThisNote, activeNoteId]);

  /* ---------------- actions ---------------- */

  async function login() {
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      // Mobile fallback
      await signInWithRedirect(auth, provider);
    }
  }
  async function logout() {
    await signOut(auth);
  }

  async function createNote() {
    if (!user) return;
    const id = uid();
    await setDoc(doc(db, "users", user.uid, "notes", id), {
      title: "New Note",
      className: "",
      body: "",
      pinned: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    setActiveNoteId(id);
  }

  async function saveNote(manual = false) {
    if (!user || !activeNoteId) return;

    if (manual) setBusy("Saving...");
    setSaveState("saving");

    try {
      await setDoc(
        doc(db, "users", user.uid, "notes", activeNoteId),
        {
          title: draftTitle.trim() || "Untitled",
          className: draftClass.trim(),
          body: draftBody,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      setSaveState("saved");
      if (manual) setBusy("");

      window.clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = window.setTimeout(() => setSaveState("idle"), 1200);
    } catch (e) {
      console.error(e);
      setSaveState("error");
      if (manual) setBusy("");
      alert("Save failed: " + (e?.message || e));
    }
  }

  // Autosave debounce: triggers after typing stops
  useEffect(() => {
    if (!user || !activeNoteId) return;
    if (ignoreAutosaveRef.current) return;

    if (saveDebounceRef.current) window.clearTimeout(saveDebounceRef.current);
    setSaveState("saving");

    saveDebounceRef.current = window.setTimeout(() => {
      saveNote(false);
    }, 900);

    return () => {
      if (saveDebounceRef.current) window.clearTimeout(saveDebounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftTitle, draftClass, draftBody]);

  async function deleteNote() {
    if (!user || !activeNoteId) return;
    const ok = confirm("Delete this note? This cannot be undone.");
    if (!ok) return;
    await deleteDoc(doc(db, "users", user.uid, "notes", activeNoteId));
    setActiveNoteId(null);
  }

  async function togglePin(note) {
    if (!user) return;
    await setDoc(
      doc(db, "users", user.uid, "notes", note.id),
      { pinned: !note.pinned, updatedAt: serverTimestamp() },
      { merge: true }
    );
  }

  async function addTask() {
    if (!user) return;
    if (!taskTitle.trim() || !taskDue) {
      alert("Task title and due date required.");
      return;
    }
    const id = uid();
    try {
      await setDoc(doc(db, "users", user.uid, "tasks", id), {
        title: taskTitle.trim(),
        className: taskClass.trim(),
        due: taskDue,
        done: false,
        createdAt: serverTimestamp(),
      });
      setTaskTitle("");
      setTaskClass("");
      setTaskDue("");
    } catch (e) {
      console.error(e);
      alert("Task save failed: " + (e?.message || e));
    }
  }

  async function toggleTask(t) {
    if (!user) return;
    await setDoc(doc(db, "users", user.uid, "tasks", t.id), { done: !t.done }, { merge: true });
  }

  async function deleteTask(t) {
    if (!user) return;
    await deleteDoc(doc(db, "users", user.uid, "tasks", t.id));
  }

  async function importPdf(file) {
    if (!file) return;
    setBusy("Extracting PDF…");
    try {
      const text = await extractPdfText(file);
      setDraftBody((prev) => {
        const header = `--- PDF IMPORT: ${file.name} ---`;
        const block = `\n\n${header}\n${text}\n--- /PDF ---\n`;
        return prev ? prev + block : block.trimStart();
      });
    } catch (e) {
      console.error(e);
      alert("PDF import failed.");
    } finally {
      setBusy("");
    }
  }

  async function summarize() {
    setBusy("Summarizing…");
    try {
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draftBody }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setDraftBody((prev) => `${prev}\n\n=== AI SUMMARY ===\n${data.summary}\n=== /SUMMARY ===\n`);
    } catch (e) {
      console.error(e);
      alert("Summarize failed. (Check /api/summarize + OPENAI_API_KEY)");
    } finally {
      setBusy("");
    }
  }

  async function makeFlashcards() {
    if (!user || !activeNoteId) return;
    setBusy("Generating flashcards…");
    try {
      const res = await fetch("/api/flashcards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draftBody }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();

      const arr = Array.isArray(data.cards) ? data.cards : [];
      if (arr.length === 0) {
        alert("No cards returned.");
        return;
      }

      const toSave = arr.slice(0, 25);
      for (const c of toSave) {
        const id = uid();
        await setDoc(doc(db, "users", user.uid, "flashcards", id), {
          noteId: activeNoteId,
          noteTitle: draftTitle || "Untitled",
          question: String(c.question || "").slice(0, 500),
          answer: String(c.answer || "").slice(0, 1500),
          createdAt: serverTimestamp(),
        });
      }
      alert(`Saved ${toSave.length} flashcards.`);
    } catch (e) {
      console.error(e);
      alert("Flashcards failed. (Check /api/flashcards + OPENAI_API_KEY)");
    } finally {
      setBusy("");
    }
  }

  function timestamp() {
    const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    setDraftBody((prev) => `${prev}\n[${t}] `);
  }

  function startTranscription() {
    if (!speechSupported || !speechRef.current) {
      alert("Transcription not supported here. Try Chrome/Edge.");
      return;
    }
    try {
      speechRef.current.start();
      setIsTranscribing(true);
    } catch {
      setIsTranscribing(true);
    }
  }
  function stopTranscription() {
    try {
      speechRef.current?.stop();
    } finally {
      setIsTranscribing(false);
    }
  }
  function insertTranscriptIntoNote() {
    if (!transcript.trim()) return;
    setDraftBody(
      (prev) =>
        `${prev}\n\n--- TRANSCRIPT ---\n${transcript.trim()}\n--- /TRANSCRIPT ---\n`
    );
  }

  function startStudy() {
    if (studyDeck.length === 0) {
      alert("No flashcards to study yet.");
      return;
    }
    setStudyMode(true);
    setStudyIndex(0);
    setStudyFlipped(false);
  }
  function stopStudy() {
    setStudyMode(false);
    setStudyFlipped(false);
    setStudyIndex(0);
  }
  function nextCard() {
    setStudyFlipped(false);
    setStudyIndex((i) => Math.min(i + 1, Math.max(0, studyDeck.length - 1)));
  }
  function prevCard() {
    setStudyFlipped(false);
    setStudyIndex((i) => Math.max(i - 1, 0));
  }

  /* ---------------- UI ---------------- */

  if (!user) {
    return (
      <div className="layout">
        <div className="card header soft-enter">
          <div>
            <div className="brand">INTENSE NOTES</div>
            <div className="brand-sub">Neon notes • calendar • flashcards • transcript</div>
          </div>

          <div className="row">
            <button onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}>
              {theme === "dark" ? "☀️ Light" : "🌙 Dark"}
            </button>
            <button className="btn-primary" onClick={login}>
              Sign in with Google
            </button>
          </div>
        </div>

        <div className="card panel soft-enter">
          <div className="pill">Tip: once deployed, it syncs across all devices automatically.</div>
          <div className="muted">
            If login opens then reloads, make sure your domain is in Firebase → Auth → Authorized domains.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="layout">
      <div className="card header soft-enter">
        <div>
          <div className="brand">INTENSE NOTES</div>
          <div className="brand-sub">Signed in as {user.email}</div>
        </div>

        <div className="row">
          {busy ? <span className="pill">{busy}</span> : null}
          {saveState !== "idle" ? (
            <span className="pill">
              {saveState === "saving"
                ? "Saving…"
                : saveState === "saved"
                ? "Saved ✓"
                : "Error ⚠️"}
            </span>
          ) : null}
          <button onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}>
            {theme === "dark" ? "☀️ Light" : "🌙 Dark"}
          </button>
          <button className="btn-danger" onClick={logout}>
            Logout
          </button>
        </div>
      </div>

      <div className="cols">
        {/* LEFT: Notes */}
        <section className="card panel soft-enter">
          <div className="panel-head">
            <b>Notes</b>
            <button className="btn-primary" onClick={createNote}>
              + New
            </button>
          </div>

          <div className="row">
            <input
              value={noteSearch}
              onChange={(e) => setNoteSearch(e.target.value)}
              placeholder="Search notes…"
              style={{ flex: 1 }}
            />
            <select
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value)}
              style={{ width: 160 }}
            >
              {classFolders.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="list">
            {filteredNotes.map((n) => {
              const preview = String(n.body || "").trim().slice(0, 90);
              return (
                <div
                  key={n.id}
                  className={`item ${n.id === activeNoteId ? "active" : ""}`}
                  style={{ display: "flex", gap: 10, alignItems: "center" }}
                >
                  <button
                    style={{ flex: 1, textAlign: "left", background: "transparent", border: "none", boxShadow: "none" }}
                    onClick={() => setActiveNoteId(n.id)}
                    title="Open note"
                  >
                    <div style={{ fontWeight: 950 }}>
                      {n.pinned ? "📌 " : ""}
                      {n.title || "Untitled"}
                    </div>
                    <div className="muted">
                      {(n.className || "—") + (preview ? " • " + preview + "…" : "")}
                    </div>
                  </button>

                  <button className={n.pinned ? "btn-ok" : ""} onClick={() => togglePin(n)}>
                    {n.pinned ? "Pinned" : "Pin"}
                  </button>
                </div>
              );
            })}
            {filteredNotes.length === 0 ? <div className="muted">No matches.</div> : null}
          </div>

          <div className="row">
            <button className="btn-danger" onClick={deleteNote} disabled={!activeNoteId}>
              Delete
            </button>
            <div className="spacer" />
            <button className="btn-primary" onClick={() => saveNote(true)} disabled={!activeNoteId}>
              Save now
            </button>
          </div>
        </section>

        {/* CENTER: Editor */}
        <section className="card panel soft-enter">
          <div className="panel-head">
            <b>Editor</b>
            <div className="row">
              <button onClick={timestamp} disabled={!activeNoteId}>
                + Timestamp
              </button>

              <label className="pill" style={{ cursor: "pointer" }}>
                Import PDF
                <input
                  type="file"
                  accept="application/pdf"
                  style={{ display: "none" }}
                  onChange={(e) => importPdf(e.target.files?.[0] || null)}
                />
              </label>

              <button onClick={summarize} disabled={!draftBody.trim()}>
                Summarize
              </button>
              <button onClick={makeFlashcards} disabled={!draftBody.trim() || !activeNoteId}>
                Flashcards
              </button>
            </div>
          </div>

          <div>
            <input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder="Title (renames note)"
              disabled={!activeNoteId}
            />
            <input
              value={draftClass}
              onChange={(e) => setDraftClass(e.target.value)}
              placeholder="Class / Folder"
              disabled={!activeNoteId}
            />
            <textarea
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              placeholder="Write notes…"
              disabled={!activeNoteId}
            />
          </div>

          <div className="panel-head" style={{ marginTop: 2 }}>
            <b>Transcript</b>
            <div className="row">
              <span className="pill">
                {speechSupported ? (isTranscribing ? "LIVE" : "READY") : "UNSUPPORTED"}
              </span>
              <button className="btn-ok" onClick={startTranscription} disabled={!speechSupported || isTranscribing}>
                Start
              </button>
              <button onClick={stopTranscription} disabled={!speechSupported || !isTranscribing}>
                Stop
              </button>
              <button onClick={insertTranscriptIntoNote} disabled={!transcript.trim() || !activeNoteId}>
                Insert
              </button>
              <button onClick={() => setTranscript("")} disabled={!transcript.trim()}>
                Clear
              </button>
            </div>
          </div>

          <textarea
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            placeholder={
              speechSupported
                ? "Transcript appears here…"
                : "This browser doesn’t support live transcription. Try Chrome/Edge."
            }
            style={{ minHeight: 140 }}
          />
        </section>

        {/* RIGHT: Calendar + Tasks + Flashcards */}
        <section className="card panel soft-enter">
          {/* Calendar */}
          <div className="panel-head">
            <b>Calendar</b>
            <span className="pill">{monthLabel(calMonth)}</span>
          </div>

          <div className="row">
            <button onClick={() => setCalMonth((d) => addMonths(d, -1))}>◀</button>
            <button onClick={() => setCalMonth(new Date())}>Today</button>
            <button onClick={() => setCalMonth((d) => addMonths(d, +1))}>▶</button>
          </div>

          <div className="cal-grid">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
              <div key={d} className="cal-dow">
                {d}
              </div>
            ))}

            {buildMonthGrid(calMonth).map((d) => {
              const key = ymd(d);
              const due = tasksByDate.get(key) || [];
              const isThisMonth = d.getMonth() === calMonth.getMonth();
              const isSelected = selectedDay === key;

              const hasUndone = due.some((t) => !t.done);
              const hasAny = due.length > 0;

              return (
                <div
                  key={key}
                  className={`cal-day ${isSelected ? "active" : ""}`}
                  onClick={() => {
                    setSelectedDay(key);
                    setTaskDue(key);
                  }}
                  style={{ opacity: isThisMonth ? 1 : 0.38 }}
                  title={key}
                >
                  <div className="cal-date">{d.getDate()}</div>
                  {hasAny ? <div className={`cal-dot ${hasUndone ? "warn" : "ok"}`} /> : null}
                  <div className="cal-meta">{hasAny ? `${due.length} due` : ""}</div>
                </div>
              );
            })}
          </div>

          {/* Tasks */}
          <div className="panel-head" style={{ marginTop: 6 }}>
            <b>Due Dates</b>
            {selectedDay ? <span className="pill">Selected: {selectedDay}</span> : null}
          </div>

          <div>
            <input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder="Assignment" />
            <input value={taskClass} onChange={(e) => setTaskClass(e.target.value)} placeholder="Class (optional)" />
            <input type="date" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} />
            <button className="btn-primary" onClick={addTask}>
              Add
            </button>
          </div>

          <div className="list">
            {tasks.map((t) => (
              <div key={t.id} className="details-card">
                <div className="row">
                  <button className={t.done ? "btn-ok" : ""} onClick={() => toggleTask(t)}>
                    {t.done ? "✅ Done" : "⬜ Not done"}
                  </button>
                  <div className="spacer" />
                  <button className="btn-danger" onClick={() => deleteTask(t)}>
                    Del
                  </button>
                </div>
                <div style={{ fontWeight: 950, marginTop: 10 }}>{t.title}</div>
                <div className="muted">
                  {t.className || "—"} • {t.due}
                </div>
              </div>
            ))}
            {tasks.length === 0 ? <div className="muted">No assignments yet.</div> : null}
          </div>

          {/* Flashcards */}
          <div className="panel-head" style={{ marginTop: 2 }}>
            <b>Flashcards</b>
            <span className="pill">{cards.length} total</span>
          </div>

          <div className="row">
            <label className="pill" style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={studyOnlyThisNote}
                onChange={(e) => setStudyOnlyThisNote(e.target.checked)}
                style={{ marginRight: 8 }}
              />
              Only this note
            </label>
            <button className="btn-primary" onClick={startStudy}>
              Study
            </button>
          </div>

          {studyMode ? (
            <div className="details-card" style={{ marginTop: 10 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <b>Study Mode</b>
                <button className="btn-danger" onClick={stopStudy}>
                  Exit
                </button>
              </div>

              <div className="muted" style={{ marginTop: 8 }}>
                Card {studyIndex + 1} of {studyDeck.length} • Tap to flip
              </div>

              <div
                className={`details-card flip ${studyFlipped ? "flipped" : ""}`}
                onClick={() => setStudyFlipped((v) => !v)}
                style={{ marginTop: 10, cursor: "pointer", userSelect: "none" }}
                title="Tap to flip"
              >
                <div className="flip-inner">
                  <div className="flip-face">
                    <div className="study-label">Question</div>
                    <div style={{ whiteSpace: "pre-wrap" }}>
                      {studyDeck[studyIndex]?.question || ""}
                    </div>
                    <div className="muted" style={{ marginTop: 10 }}>
                      Tap to flip
                    </div>
                  </div>

                  <div className="flip-face flip-back">
                    <div className="study-label">Answer</div>
                    <div style={{ whiteSpace: "pre-wrap" }}>
                      {studyDeck[studyIndex]?.answer || ""}
                    </div>
                    <div className="muted" style={{ marginTop: 10 }}>
                      Tap to flip
                    </div>
                  </div>
                </div>
              </div>

              <div className="row" style={{ marginTop: 10 }}>
                <button onClick={prevCard} disabled={studyIndex === 0}>
                  ← Prev
                </button>
                <button onClick={() => setStudyFlipped((v) => !v)}>
                  {studyFlipped ? "Show Q" : "Show A"}
                </button>
                <button
                  onClick={() => {
                    if (studyIndex >= studyDeck.length - 1) {
                      alert("Done! 🎉");
                      stopStudy();
                      return;
                    }
                    nextCard();
                  }}
                  disabled={studyDeck.length === 0}
                >
                  Next →
                </button>
              </div>
            </div>
          ) : (
            <div className="list">
              {cards.slice(0, 20).map((c) => (
                <details key={c.id} className="details-card">
                  <summary style={{ cursor: "pointer", fontWeight: 950 }}>
                    {c.question}
                    {c.noteTitle ? <div className="muted">from: {c.noteTitle}</div> : null}
                  </summary>
                  <div style={{ marginTop: 8 }}>{c.answer}</div>
                </details>
              ))}
              {cards.length === 0 ? <div className="muted">No flashcards yet.</div> : null}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}