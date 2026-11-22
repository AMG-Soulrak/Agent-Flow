import type { FlowHist, FlowNode } from '../types'

// ---------- historial ----------
export const MAX_HIST = 300 // agentes que se recuerdan por sesión

// Lo que se guarda de un agente: sin el encargo entero (puede llevar datos que no quieres en un archivo).
export const snap = (n: FlowNode): FlowHist => ({
  id: n.id,
  parent: n.parent,
  type: n.type,
  desc: n.desc,
  status: n.status,
  model: n.model,
  effort: n.effort,
  started: n.started,
  last: n.last,
  tools: n.tools,
  errors: n.errors,
  lastError: n.lastError,
  result: n.result,
  skills: n.skills.map(s => s.name),
  mcp: n.mcp.map(m => `${m.server}·${m.tool}`),
  toolUse: n.toolUse.map(t => `${t.name}×${t.n}`),
  files: n.files.map(f => ({ path: f.path, r: f.r, w: f.w })),
})

// Sin tope crecería sin fin: se quedan los más recientes.
export const trimHist = (h: Record<string, FlowHist>) => {
  const ids = Object.keys(h)
  if (ids.length <= MAX_HIST) return h
  const keep = ids.sort((a, b) => h[b].last - h[a].last).slice(0, MAX_HIST)
  return Object.fromEntries(keep.map(i => [i, h[i] as FlowHist]))
}

export const historyJson = (session: string, savedAt: number, h: Record<string, FlowHist>) =>
  JSON.stringify({ session, saved: new Date(savedAt).toISOString(), agents: Object.values(h).sort((a, b) => a.started - b.started) }, null, 1)

// Lee un archivo de historial anterior (de esta misma sesión, antes de recargar el mod). Lo ilegible se ignora.
export const parseHistory = (text: string): Record<string, FlowHist> => {
  try {
    const j = JSON.parse(text)
    const out: Record<string, FlowHist> = {}
    if (Array.isArray(j?.agents)) for (const a of j.agents) if (a && typeof a.id === 'string' && typeof a.type === 'string' && a.status) out[a.id] = a
    return out
  } catch {
    return {}
  }
}

// ---------- sonido ----------
// Un pitido corto generado aquí (WAV de 8 kHz, 16 bits, mono): no hay que llevar archivos de audio.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const b64 = (b: Uint8Array) => {
  let s = ''
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0)
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=')
  }
  return s
}

export const wav = (notes: Array<[number, number]>, rate = 8000): Uint8Array => {
  const samples: number[] = []
  for (const [hz, ms] of notes) {
    const len = Math.round((rate * ms) / 1000)
    for (let i = 0; i < len; i++) {
      const env = Math.min(1, i / 60, (len - i) / 60) // entra y sale suave: sin chasquidos
      samples.push(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 0.35 * 32767 * env))
    }
  }
  const out = new Uint8Array(44 + samples.length * 2)
  const v = new DataView(out.buffer)
  const str = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  str(8, 'WAVEfmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  samples.forEach((s, i) => v.setInt16(44 + i * 2, s, true))
  return out
}

// Terminó: dos notas que suben. Falló: dos notas graves que bajan.
const SOUNDS = {
  done: [[784, 110], [1047, 160]],
  failed: [[330, 160], [247, 260]],
} as const
const cache: Record<string, string> = {}
export const clip = (kind: 'done' | 'failed') => (cache[kind] ??= b64(wav(SOUNDS[kind].map(([a, b]) => [a, b] as [number, number]))))
