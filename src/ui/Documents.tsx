import { useEffect, useRef, useState } from 'preact/hooks';
import { bus } from '../core/bus';
import { documents } from '../tools/documents';
import { Button, Card } from './components';

interface DocRow {
  id: string;
  name: string;
  chars: number;
  addedAt: string;
}

export function Documents() {
  const [list, setList] = useState<DocRow[]>([]);
  const [viewing, setViewing] = useState<{ name: string; content: string } | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{ id: string; name: string; snippet: string }> | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  function refresh() {
    documents.list().then(setList).catch(() => {});
  }
  useEffect(refresh, []);

  async function addFiles(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      try {
        await documents.add(file);
      } catch (err) {
        bus.emit({ type: 'toast', level: 'error', text: `Could not add ${file.name}: ${(err as Error).message}` });
      }
    }
    refresh();
  }

  async function view(row: DocRow) {
    const content = await documents.get(row.id);
    setViewing({ name: row.name, content });
  }

  async function remove(id: string) {
    await documents.remove(id);
    refresh();
  }

  async function search() {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    setResults(await documents.search(query.trim()));
  }

  return (
    <div>
      <h1>Documents</h1>
      <div
        class={`dropzone ${dragOver ? 'drag' : ''}`}
        onClick={() => fileInput.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer?.files ?? null);
        }}
      >
        Drop files here, or click to choose
        <input ref={fileInput} type="file" multiple style={{ display: 'none' }} onChange={(e) => addFiles((e.target as HTMLInputElement).files)} />
      </div>

      <div class="row">
        <input class="input" placeholder="Search documents…" value={query} onChange={(e) => setQuery((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
        <Button variant="ghost" onClick={search}>
          Search
        </Button>
      </div>

      {results && (
        <Card>
          <h3>Search results</h3>
          <ul class="doc-list">
            {results.map((r) => (
              <li key={r.id}>
                <strong>{r.name}</strong>: {r.snippet}
              </li>
            ))}
            {results.length === 0 && <li>No matches.</li>}
          </ul>
        </Card>
      )}

      <ul class="doc-list">
        {list.map((d) => (
          <li key={d.id}>
            <span>
              <strong>{d.name}</strong> — {d.chars.toLocaleString()} chars — {new Date(d.addedAt).toLocaleString()}
            </span>
            <div class="row">
              <Button variant="ghost" onClick={() => view(d)}>
                View
              </Button>
              <Button variant="danger" onClick={() => remove(d.id)}>
                Delete
              </Button>
            </div>
          </li>
        ))}
        {list.length === 0 && <li>No documents yet.</li>}
      </ul>

      {viewing && (
        <Card>
          <div class="row" style={{ justifyContent: 'space-between' }}>
            <h3>{viewing.name}</h3>
            <Button variant="ghost" onClick={() => setViewing(null)}>
              Close
            </Button>
          </div>
          <pre class="doc-view">{viewing.content}</pre>
        </Card>
      )}
    </div>
  );
}
