// Thin wrapper over the Origin Private File System.
async function root(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

function parts(path: string): string[] {
  return path.split('/').filter(Boolean);
}

async function dirHandle(dir: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  let h = await root();
  for (const p of parts(dir)) h = await h.getDirectoryHandle(p, { create });
  return h;
}

async function fileHandle(path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const segs = parts(path);
  const name = segs.pop();
  if (!name) throw new Error('opfs: empty path');
  const dir = await dirHandle(segs.join('/'), create);
  return { dir, name };
}

export const opfs = {
  async readText(path: string): Promise<string | null> {
    try {
      const { dir, name } = await fileHandle(path, false);
      const fh = await dir.getFileHandle(name);
      const file = await fh.getFile();
      return await file.text();
    } catch {
      return null;
    }
  },

  async writeText(path: string, text: string): Promise<void> {
    const { dir, name } = await fileHandle(path, true);
    const fh = await dir.getFileHandle(name, { create: true });
    const writable = await fh.createWritable();
    await writable.write(text);
    await writable.close();
  },

  async list(dir: string): Promise<string[]> {
    try {
      const h = await dirHandle(dir, false);
      const names: string[] = [];
      for await (const name of h.keys()) names.push(name);
      return names;
    } catch {
      return [];
    }
  },

  async remove(path: string): Promise<void> {
    try {
      const { dir, name } = await fileHandle(path, false);
      await dir.removeEntry(name, { recursive: true });
    } catch {
      // already gone
    }
  },

  async mkdir(dir: string): Promise<void> {
    await dirHandle(dir, true);
  },
};
