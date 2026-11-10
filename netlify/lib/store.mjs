// Storage wrapper: Netlify Blobs in production; in-memory/injected store for tests.
let override = null;
export function setStoreForTests(s) { override = s; }
export async function getSubStore() {
  if (override) return override;
  const { getStore } = await import('@netlify/blobs');
  const st = getStore('evening-reset');
  return {
    get: (k) => st.get(k, { type: 'json' }),
    set: (k, v) => st.setJSON(k, v),
    del: (k) => st.delete(k),
    list: async () => (await st.list({ prefix: 'sub:' })).blobs.map((b) => b.key),
  };
}
export function memoryStore() {
  const m = new Map();
  return { get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), set: async (k, v) => { m.set(k, JSON.stringify(v)); }, del: async (k) => { m.delete(k); }, list: async () => [...m.keys()].filter((k) => k.startsWith('sub:')) };
}
