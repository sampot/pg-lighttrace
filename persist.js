const KEY = "/api/kv/pg-lighttrace:progress";

export async function loadProgress(fetcher = fetch) {
  try {
    const res = await fetcher(KEY);
    if (!res.ok) return {};
    const text = await res.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export async function saveProgress(data, fetcher = fetch) {
  try {
    await fetcher(KEY, { method: "PUT", body: JSON.stringify(data) });
  } catch {}
  return data;
}
