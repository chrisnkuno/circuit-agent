import { useEffect, useState } from "react";
import { addMemory, forgetMemory, listMemories, type MemoryEntry } from "../lib/ipc";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

const KINDS: MemoryEntry["kind"][] = ["fact", "preference", "convention", "decision", "lesson"];

/** Visible, editable durable memory shared with the CLI's `/memory` command. */
export function MemoryPanel(props: { open: boolean; onClose: () => void; tabId?: string }) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [files, setFiles] = useState<{ project: string; user: string } | null>(null);
  const [scope, setScope] = useState<MemoryEntry["scope"]>("project");
  const [kind, setKind] = useState<MemoryEntry["kind"]>("fact");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (!props.tabId) return;
    const result = await listMemories(props.tabId);
    setEntries(result.entries);
    setFiles(result.files);
  };

  useEffect(() => {
    if (!props.open || !props.tabId) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    void listMemories(props.tabId)
      .then((result) => { if (!cancelled) { setEntries(result.entries); setFiles(result.files); } })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [props.open, props.tabId]);

  async function remember() {
    if (!props.tabId || !text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await addMemory(scope, text, kind, props.tabId);
      setText("");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function forget(entry: MemoryEntry) {
    if (!props.tabId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await forgetMemory(entry.scope, entry.index, props.tabId);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={(next) => { if (!next) props.onClose(); }}>
      <DialogContent className="memory-modal" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Memory shared with Nova CLI</DialogTitle>
          <DialogClose asChild><button className="btn ghost" type="button">Close</button></DialogClose>
        </DialogHeader>
        <p className="memory-explainer">Only facts you add are stored. Project memory stays with this repository; personal memory follows you across projects.</p>
        <div className="memory-compose">
          <textarea aria-label="Memory text" placeholder="A durable fact Nova should remember…" value={text} onChange={(event) => setText(event.target.value)} maxLength={800} />
          <div className="memory-options">
            <label>Scope<select aria-label="Memory scope" value={scope} onChange={(event) => setScope(event.target.value as MemoryEntry["scope"])}><option value="project">This project</option><option value="user">All my projects</option></select></label>
            <label>Kind<select aria-label="Memory kind" value={kind} onChange={(event) => setKind(event.target.value as MemoryEntry["kind"])}>{KINDS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <Button variant="primary" size="sm" disabled={busy || !text.trim()} onClick={() => void remember()}>Remember</Button>
          </div>
        </div>
        {error ? <p className="notice danger" role="alert">{error}</p> : null}
        <ul className="memory-list">
          {entries.map((entry) => (
            <li key={`${entry.scope}-${entry.index}`}>
              <div><span>{entry.scope}</span><span>{entry.kind}</span>{entry.pinned ? <span>core</span> : null}</div>
              <p>{entry.text}</p>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void forget(entry)}>Forget</Button>
            </li>
          ))}
        </ul>
        {!busy && entries.length === 0 ? <p className="panel-empty">No durable memories yet.</p> : null}
        {files ? <details className="memory-files"><summary>Storage files</summary><code>{files.project}</code><code>{files.user}</code></details> : null}
      </DialogContent>
    </Dialog>
  );
}
