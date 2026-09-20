// Lists models served by a local Ollama instance (native API, not the OpenAI-compat surface,
// since /api/show is needed for vision capability flags).
export async function listOllamaModels(baseUrl: string): Promise<Array<{ id: string; vision: boolean }>> {
  const origin = baseUrl.replace(/\/v1\/?$/, '');
  let res: Response;
  try {
    res = await fetch(`${origin}/api/tags`);
  } catch {
    throw new Error('Cannot reach Ollama. Is it running, and is OLLAMA_ORIGINS set to allow this site?');
  }
  if (!res.ok) throw new Error(`Ollama returned ${res.status} listing models.`);
  const json = (await res.json()) as { models?: Array<{ name: string }> };
  const models = (json.models ?? []).slice(0, 20); // sequential /api/show calls below, keep it bounded

  const out: Array<{ id: string; vision: boolean }> = [];
  for (const m of models) {
    out.push({ id: m.name, vision: await isVisionModel(origin, m.name) });
  }
  return out;
}

async function isVisionModel(origin: string, model: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) return false;
    const show = (await res.json()) as { capabilities?: string[]; details?: { families?: string[] } };
    const families = show.details?.families ?? [];
    return !!show.capabilities?.includes('vision') || families.includes('clip') || families.includes('mllama');
  } catch {
    return false;
  }
}
