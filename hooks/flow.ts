import type { FlowNode } from '../types'

export const IDLE_MS = 5 * 60 * 1000 // un agente se oculta tras 5 min sin actividad (él y todo lo que cuelga de él)
export const MAIN_ID = 'main'
export const ZOOMS = [0.6, 0.8, 1, 1.25, 1.5, 2]
const LIVE_USE_MS = 20_000 // un skill, MCP o archivo "se está usando" si se tocó hace menos de esto
const MAX_FILES_SHOWN = 14 // la columna de archivos enseña los más recientes

// ---------- modelo ----------
export const mkNode = (id: string, parent: string | null, type: string, desc: string, now: number): FlowNode => ({
  id,
  parent,
  type,
  desc,
  status: 'active',
  tool: '',
  skills: [],
  mcp: [],
  files: [],
  model: '',
  errors: 0,
  lastError: '',
  result: '',
  tools: 0,
  started: now,
  last: now,
})

export const mkMain = (now: number): FlowNode => ({ ...mkNode(MAIN_ID, null, 'Claude', 'Sesión principal', now), status: 'idle' })

// Los últimos 8 skills usados, sin repetir: usar uno ya visto lo pasa al final y suma un uso.
export const addSkill = (n: FlowNode, name: string, now: number): FlowNode => {
  const old = n.skills.find(s => s.name === name)
  return { ...n, skills: [...n.skills.filter(s => s.name !== name), { name, at: now, n: (old?.n ?? 0) + 1 }].slice(-8) }
}

// Los últimos 8 archivos tocados: cuenta lecturas y escrituras por separado.
export const addFile = (n: FlowNode, path: string, mode: 'read' | 'write', now: number): FlowNode => {
  const old = n.files.find(f => f.path === path)
  const f = { path, r: (old?.r ?? 0) + (mode === 'read' ? 1 : 0), w: (old?.w ?? 0) + (mode === 'write' ? 1 : 0), at: now }
  return { ...n, files: [...n.files.filter(x => x.path !== path), f].slice(-8) }
}

// "mcp__servidor__herramienta" -> { server, tool }. Otra herramienta -> null.
export const mcpOf = (tool: string) => {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  return m ? { server: m[1], tool: m[2] } : null
}

// Claude Desktop nombra a algunos conectores con un identificador (mcp__be10535b-...__herramienta).
// Los que se ven en las sesiones de esta máquina llevan su nombre; añade aquí los demás.
const MCP_ALIASES: Record<string, string> = {
  'be10535b-58d4-428e-9141-d490be59a8d3': 'Supabase',
  '394acc81-d004-41c8-9791-545da6b6974e': 'Vercel',
  'd79af1c1-c7f0-40aa-a65c-a6c4d118fbd3': 'Gmail',
  '1a59c906-04da-521d-bda7-7f71b9f9e01c': 'Claude Docs',
}
// Nombre legible de un servidor MCP: alias conocido, o sin prefijos de plugin, o "MCP" + 8 primeros del identificador.
export const friendlyMcp = (server: string) => {
  const alias = MCP_ALIASES[server]
  if (alias) return alias
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(server)) return 'MCP ' + server.slice(0, 8)
  return server.replace(/^(plugin_[^_]+_|claude_ai_)/, '').replace(/_/g, ' ')
}

export const addMcp = (n: FlowNode, server: string, tool: string, now: number): FlowNode => {
  const old = n.mcp.find(s => s.server === server)
  return { ...n, mcp: [...n.mcp.filter(s => s.server !== server), { server, tool, at: now, n: (old?.n ?? 0) + 1 }].slice(-8) }
}

// "claude-sonnet-5-5-20260301" -> "sonnet 5.5"; "haiku" -> "haiku".
export const shortModel = (m: string) => {
  const x = /(haiku|sonnet|opus|fable)[-\s]?(\d+)?[-.]?(\d+)?/i.exec(m)
  return x ? [x[1].toLowerCase(), x[2] && x[3] && x[3].length < 3 ? `${x[2]}.${x[3]}` : x[2]].filter(Boolean).join(' ') : m.slice(0, 14)
}

// Estado, el que cuelga de quién y qué sigue visible: un agente cuenta como activo
// mientras él o cualquiera de sus descendientes tenga actividad de hace menos de 5 min.
// Padre efectivo: si el registrado no existe como tarjeta, cuelga de la sesión principal,
// así nada queda suelto en la columna del principal.
export const parentOf = (nodes: Record<string, FlowNode>, id: string): string | null => {
  const p = nodes[id].parent
  if (p && p !== id && nodes[p]) return p
  return id !== MAIN_ID && nodes[MAIN_ID] ? MAIN_ID : null
}

export const aliveSet = (nodes: Record<string, FlowNode>, now: number) => {
  const kids = new Map<string, string[]>()
  for (const n of Object.values(nodes)) {
    const p = parentOf(nodes, n.id)
    if (p) kids.set(p, [...(kids.get(p) ?? []), n.id])
  }
  const eff = new Map<string, number>()
  const calc = (id: string, depth: number): number => {
    const known = eff.get(id)
    if (known !== undefined) return known
    let v = nodes[id].last
    if (depth < 30) for (const k of kids.get(id) ?? []) v = Math.max(v, calc(k, depth + 1))
    eff.set(id, v)
    return v
  }
  const ok = new Set<string>()
  for (const id of Object.keys(nodes)) if (now - calc(id, 0) < IDLE_MS) ok.add(id)
  return { ok, kids }
}

// ---------- color ----------
const hash = (s: string) => {
  let x = 7
  for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0
  return x
}
const hsl = (h: number, s: number, l: number) => {
  const a = (s * Math.min(l, 100 - l)) / 10000
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    return Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return '#' + [f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('')
}
const FIXED: Array<[string, string]> = [
  ['claude', '#d97757'],
  ['marketing', '#f76707'],
  ['desarrollo', '#339af0'],
  ['diseno', '#cc5de8'],
  ['finanzas', '#40c057'],
  ['legal', '#9aa5b1'],
  ['operaciones', '#fcc419'],
  ['social-contenido', '#f06595'],
]
// El mismo tipo da siempre el mismo color; los de un plugin ("ruflo-core:...") comparten familia.
export const colorOf = (type: string) => {
  const t = type.toLowerCase()
  const f = FIXED.find(([k]) => t.startsWith(k))
  return f ? f[1] : hsl(hash(t.split(':')[0]) % 360, 66, 62)
}
const SKILL_COLOR = '#b197fc'
const MCP_COLOR = '#38d9a9'
const READ_COLOR = '#4dabf7'
const WRITE_COLOR = '#ffa94d'
const ERR_COLOR = '#ff6b6b'
const MODEL_COLOR = '#c9a7ff'

export const STATUS = {
  active: { color: '#3ddc84', label: 'activo' },
  waiting: { color: '#ffb020', label: 'espera permiso' },
  idle: { color: '#8b93a7', label: 'en reposo' },
  done: { color: '#5aa9ff', label: 'terminó' },
  failed: { color: ERR_COLOR, label: 'falló' },
} as const

// ---------- texto ----------
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
// Fuera los caracteres de control: el SVG no los admite y el panel quedaría sin dibujar.
const esc = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"]/g, c => ESC[c])
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const wrap = (s: string, n: number, lines: number) => {
  const out: string[] = []
  let cur = ''
  for (const w of s.split(/\s+/).filter(Boolean)) {
    if ((cur + ' ' + w).trim().length > n && cur) {
      out.push(cur)
      cur = w
    } else cur = (cur + ' ' + w).trim()
  }
  if (cur) out.push(cur)
  if (out.length > lines) {
    out.length = lines
    out[lines - 1] = cut(out[lines - 1] + '…', n)
  }
  return out.map(l => cut(l, n))
}
export const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const dirOf = (p: string) => p.split(/[\\/]/).filter(Boolean).slice(-3, -1).join('/')

// ---------- dibujo ----------
const CARD_W = 264
const CARD_H = 122
const HGAP = 96
const VGAP = 28
const PAD = 18
const TOP = 66
const RES_W = 206
const RES_H = 52
const RES_GAP = 12
const COLGAP = 74
const SL = CARD_H + VGAP // alto de una fila de la rejilla
const slotY = (slot: number) => TOP + slot * SL
const gutterBelow = (slot: number) => TOP + (slot + 1) * SL - VGAP / 2
const gutterAbove = (slot: number) => TOP + slot * SL - VGAP / 2
const FONT = `font-family="Segoe UI, system-ui, -apple-system, sans-serif"`

const T = (x: number, y: number, size: number, fill: string, txt: string, extra = '') =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${FONT}${extra}>${txt}</text>`

const chip = (x: number, y: number, txt: string, c: string) => {
  const w = Math.round(txt.length * 6.1 + 14)
  return { w, svg: `<rect x="${x}" y="${y}" width="${w}" height="16" rx="8" fill="${c}" fill-opacity=".16" stroke="${c}" stroke-opacity=".6"/>` + T(x + 7, y + 11.5, 10, c, esc(txt), ' font-weight="600"') }
}

const card = (n: FlowNode, x: number, y: number, now: number) => {
  const color = colorOf(n.type)
  const st = STATUS[n.status]
  const live = n.status === 'active' || n.status === 'waiting'
  const hasResult = (n.status === 'done' || n.status === 'failed') && n.result
  const age = n.status === 'active' ? 'activo · ' + fmt(now - n.started) : n.status === 'waiting' ? 'espera tu permiso' : st.label + ' · hace ' + fmt(now - n.last)
  const lines = wrap(n.desc || 'sin descripción', 40, 2)
  let s = ''
  if (live) s += `<rect x="${x - 3}" y="${y - 3}" width="${CARD_W + 6}" height="${CARD_H + 6}" rx="15" fill="none" stroke="${st.color}" stroke-width="2.5" opacity=".2"><animate attributeName="opacity" values=".15;.6;.15" dur="${n.status === 'waiting' ? '0.9s' : '1.8s'}" repeatCount="indefinite"/></rect>`
  s += `<rect x="${x}" y="${y}" width="${CARD_W}" height="${CARD_H}" rx="12" fill="#1a1d2b" stroke="${live || n.status === 'failed' ? st.color : '#2e3350'}" stroke-opacity="${live || n.status === 'failed' ? 0.75 : 1}" stroke-width="1.4"/>`
  s += `<rect x="${x}" y="${y + 10}" width="5" height="${CARD_H - 20}" rx="2.5" fill="${color}"/>`
  s += T(x + 17, y + 23, 13.5, '#f4f6ff', esc(cut(n.type, 24)), ' font-weight="700"')
  s += `<circle cx="${x + CARD_W - 16}" cy="${y + 18}" r="4.5" fill="${st.color}">${live ? `<animate attributeName="r" values="4.5;6;4.5" dur="1.4s" repeatCount="indefinite"/>` : ''}</circle>`
  s += T(x + CARD_W - 28, y + 22, 10, st.color, esc(age), ' text-anchor="end"')
  lines.forEach((l, i) => (s += T(x + 17, y + 42 + i * 14, 11.5, '#b9bfd9', esc(l))))
  // líneas 3 y 4: lo que hace ahora; al terminar, lo que respondió; si hubo un error, cuál
  if (hasResult) {
    const r = wrap(n.result, 40, 2)
    s += T(x + 17, y + 77, 11, n.status === 'failed' ? ERR_COLOR : '#8fd3b6', esc('↳ ' + r[0]), ' font-weight="600"')
    if (r[1]) s += T(x + 29, y + 91, 11, '#8fd3b6', esc(r[1]))
  } else {
    s += T(x + 17, y + 77, 11, n.tool && live ? color : '#6f7694', esc(n.tool ? '⚙ ' + cut(n.tool, 36) : '— sin herramienta'), n.tool && live ? ' font-weight="600"' : '')
    if (n.lastError) s += T(x + 17, y + 91, 10.5, ERR_COLOR, esc('⚠ ' + cut(n.lastError, 42)))
  }
  // resumen en chips: modelo, skills, MCP, archivos y fallos (el detalle está en las columnas de la derecha)
  let cx = x + 17
  const add = (txt: string, c: string) => { const ch = chip(cx, y + 99, txt, c); if (cx + ch.w < x + CARD_W - 8) { s += ch.svg; cx += ch.w + 4 } }
  if (n.model) add('◈ ' + n.model, MODEL_COLOR)
  if (n.skills.length) add(`✦ ${n.skills.length}`, SKILL_COLOR)
  if (n.mcp.length) add(`⛓ ${n.mcp.length}`, MCP_COLOR)
  if (n.files.length) add(`▤ ${n.files.length}`, WRITE_COLOR)
  if (n.errors) add(`⚠ ${n.errors}`, ERR_COLOR)
  const tip = `${n.type} · ${n.desc || 'sin descripción'}\nEstado: ${st.label}\nHerramientas usadas: ${n.tools}`
  return `<g><title>${esc(tip)}</title>${s}</g>`
}

type Pos = { x: number; y: number }
type Use = { id: string; at: number; n: number; tool: string }
type Kind = 'skill' | 'mcp' | 'file'
type Res = { kind: Kind; label: string; color: string; uses: Use[]; at: number; n: number; rd: number; wr: number; y: number; slot: number }

const isLive = (n: FlowNode) => n.status === 'active' || n.status === 'waiting'

export const drawFlow = (nodes: Record<string, FlowNode>, now: number, scale = 1) => {
  const { ok, kids } = aliveSet(nodes, now)
  const ids = [...ok]

  // Posición de los agentes en una rejilla de filas fijas: la columna es la profundidad y cada tarjeta
  // ocupa una fila entera (el primer hijo, la misma que su padre). Así los huecos entre filas están libres
  // en todas las columnas y las conexiones viajan por ellos sin pasar por debajo de ninguna tarjeta.
  const pos = new Map<string, Pos>()
  const seen = new Set<string>()
  let maxDepth = 0
  const place = (id: string, depth: number, r: number): number => {
    seen.add(id)
    maxDepth = Math.max(maxDepth, depth)
    pos.set(id, { x: depth, y: r })
    const ch = (kids.get(id) ?? []).filter(k => ok.has(k) && !seen.has(k)).sort((x, y) => nodes[x].started - nodes[y].started)
    let free = r + 1
    ch.forEach((c, i) => { free = Math.max(free, place(c, depth + 1, i === 0 ? r : free)) })
    return free
  }
  const roots = ids
    .filter(i => { const p = parentOf(nodes, i); return !p || !ok.has(p) })
    .sort((x, y) => (x === MAIN_ID ? -1 : y === MAIN_ID ? 1 : nodes[x].started - nodes[y].started))
  let row = 0
  roots.forEach(r => { if (!seen.has(r)) row = place(r, 0, row) })
  const px = (p: Pos): [number, number] => [PAD + p.x * (CARD_W + HGAP), slotY(p.y)]

  // columnas de recursos: un nodo por skill, servidor MCP o archivo, con todos los agentes que lo usan
  const collect = (kind: Kind): Res[] => {
    const m = new Map<string, Res>()
    for (const id of ids) {
      const n = nodes[id]
      const items =
        kind === 'skill' ? n.skills.map(s => ({ key: s.name, at: s.at, n: s.n, tool: '', rd: 0, wr: 0 }))
        : kind === 'mcp' ? n.mcp.map(s => ({ key: s.server, at: s.at, n: s.n, tool: s.tool, rd: 0, wr: 0 }))
        : n.files.map(f => ({ key: f.path, at: f.at, n: f.r + f.w, tool: '', rd: f.r, wr: f.w }))
      for (const it of items) {
        const r = m.get(it.key) ?? { kind, label: it.key, color: kind === 'skill' ? SKILL_COLOR : MCP_COLOR, uses: [], at: 0, n: 0, rd: 0, wr: 0, y: 0, slot: 0 }
        r.uses.push({ id, at: it.at, n: it.n, tool: it.tool })
        r.at = Math.max(r.at, it.at)
        r.n += it.n
        r.rd += it.rd
        r.wr += it.wr
        m.set(it.key, r)
      }
    }
    const list = [...m.values()]
    for (const r of list) if (r.kind === 'file') r.color = r.wr ? WRITE_COLOR : READ_COLOR
    // los archivos pueden ser muchos: solo los más recientes
    return kind === 'file' ? list.sort((a, b) => b.at - a.at).slice(0, MAX_FILES_SHOWN) : list
  }
  const skillRes = collect('skill')
  const mcpRes = collect('mcp')
  const fileRes = collect('file')
  const agentsRight = ids.length ? PAD + (maxDepth + 1) * CARD_W + maxDepth * HGAP : PAD + 400
  const cols: Array<{ kind: Kind; list: Res[]; x: number; title: string; color: string }> = []
  let nextX = agentsRight + COLGAP
  for (const [kind, list, title, color] of [
    ['skill', skillRes, 'SKILLS', SKILL_COLOR],
    ['mcp', mcpRes, 'MCP', MCP_COLOR],
    ['file', fileRes, 'ARCHIVOS', WRITE_COLOR],
  ] as const) {
    if (!list.length) continue
    cols.push({ kind, list, x: nextX, title, color })
    nextX += RES_W + COLGAP
  }
  const rightEdge = cols.length ? nextX - COLGAP : agentsRight

  // fila de cada recurso: la más cercana a la media de quienes lo usan que esté libre en su columna
  const assign = (list: Res[]) => {
    const used = new Set<number>()
    const want = (r: Res) => r.uses.reduce((acc, u) => acc + pos.get(u.id)!.y, 0) / r.uses.length
    list.sort((x, y) => want(x) - want(y) || x.label.localeCompare(y.label))
    let last = -1
    for (const r of list) {
      const w = Math.max(0, Math.round(want(r)))
      let slot = w
      for (let off = 0; ; off++) {
        if (!used.has(w + off)) { slot = w + off; break }
        if (w - off >= 0 && !used.has(w - off)) { slot = w - off; break }
      }
      used.add(slot)
      r.slot = slot
      r.y = slotY(slot) + (CARD_H - RES_H) / 2
      last = Math.max(last, slot)
    }
    return last + 1
  }
  const resSlots = Math.max(0, ...cols.map(c => assign(c.list)))

  const W = ids.length ? rightEdge + PAD : 560
  const H = ids.length ? TOP + Math.max(row, resSlots) * SL - VGAP + PAD : 150

  const counts = {
    total: ids.length,
    active: ids.filter(i => isLive(nodes[i])).length,
    skills: skillRes.length,
    mcp: mcpRes.length,
    files: fileRes.length,
    errors: ids.reduce((s, i) => s + nodes[i].errors, 0),
  }

  // Conexiones curvas que nunca pasan por debajo de una tarjeta: cada curva en S queda dentro del pasillo
  // vertical entre dos columnas (un trazo suave nunca sale de la caja que forman sus extremos) y el tramo
  // largo va recto por el hueco entre filas.
  const bez = (x0: number, y0: number, x1: number, y1: number) => {
    const mx = x0 + (x1 - x0) / 2
    return `C${mx} ${y0} ${mx} ${y1} ${x1} ${y1}`
  }

  // 1) agente -> skill / MCP / archivo. Si el agente está en la última columna y el recurso en la primera
  //    de recursos, una sola curva basta; si no, sale en curva al hueco entre filas, lo recorre y entra en
  //    curva a su recurso. Solo brillan las que se usan ahora.
  let resEdges = ''
  for (const c of cols) {
    for (const r of c.list) {
      for (const u of r.uses) {
        const n = nodes[u.id]
        const p = pos.get(u.id)!
        const [x, y] = px(p)
        const h = hash(u.id + r.label)
        const sx = x + CARD_W, sy = y + CARD_H / 2
        const ey = r.y + RES_H / 2
        let d: string
        if (c === cols[0] && p.x === maxDepth) {
          d = `M${sx} ${sy} ${bez(sx, sy, c.x, ey)}`
        } else {
          const gy = (r.slot >= p.y ? gutterBelow(p.y) : gutterAbove(p.y)) + (((h >> 3) % 5) - 2) * 2.2
          const x1 = sx + 52 + (h % 3) * 6
          const x2 = c.x - 52 - ((h >> 5) % 3) * 6
          d = `M${sx} ${sy} ${bez(sx, sy, x1, gy)} L${x2} ${gy} ${bez(x2, gy, c.x, ey)}`
        }
        const live = isLive(n) && now - u.at < LIVE_USE_MS
        resEdges += `<path d="${d}" fill="none" stroke="${r.color}" stroke-width="${live ? 2.2 : 1.4}" stroke-opacity="${live ? 0.95 : 0.22}" stroke-linecap="round"/>`
        if (live) {
          resEdges += `<path d="${d}" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="1.3" stroke-dasharray="2 12" stroke-linecap="round"><animate attributeName="stroke-dashoffset" from="14" to="0" dur=".8s" repeatCount="indefinite"/></path>`
          resEdges += `<circle r="3.2" fill="${r.color}" stroke="#fff" stroke-width="1"><animateMotion dur="${Math.max(1.4, 0.0016 * (c.x - sx + 400)).toFixed(2)}s" repeatCount="indefinite" path="${d}"/></circle>`
        }
      }
    }
  }

  // 2) padre -> hijo: una curva entre sus dos columnas; fluye mientras el hijo trabaja
  //    y un pulso vuelve al padre al terminar
  let edges = ''
  for (const id of ids) {
    const n = nodes[id]
    const par = parentOf(nodes, id)
    const pp = par && ok.has(par) ? pos.get(par) : undefined
    const cp = pos.get(id)
    if (!pp || !cp) continue
    const [x1, y1] = px(pp)
    const [x2, y2] = px(cp)
    const sx = x1 + CARD_W, sy = y1 + CARD_H / 2, ex = x2, ey = y2 + CARD_H / 2
    const d = `M${sx} ${sy} ${bez(sx, sy, ex, ey)}`
    const back = `M${ex} ${ey} ${bez(ex, ey, sx, sy)}`
    const c = colorOf(n.type)
    const live = isLive(n)
    const justDone = (n.status === 'done' || n.status === 'failed') && now - n.last < 8000
    edges += `<path d="${d}" fill="none" stroke="${c}" stroke-width="${live ? 7 : 4}" stroke-opacity="${live ? 0.13 : 0.06}" stroke-linecap="round"/>`
    edges += `<path d="${d}" fill="none" stroke="${c}" stroke-width="2.2" stroke-opacity="${live ? 0.95 : 0.4}" stroke-linecap="round"/>`
    if (live) {
      edges += `<path d="${d}" fill="none" stroke="#ffffff" stroke-opacity=".75" stroke-width="1.4" stroke-dasharray="2 14" stroke-linecap="round"><animate attributeName="stroke-dashoffset" from="16" to="0" dur=".9s" repeatCount="indefinite"/></path>`
      edges += [0, 0.7].map(b => `<circle r="3.6" fill="${c}" stroke="#fff" stroke-width="1"><animateMotion dur="1.5s" begin="${b}s" repeatCount="indefinite" path="${d}"/></circle>`).join('')
    }
    if (justDone) edges += `<circle r="3.8" fill="${STATUS[n.status === 'failed' ? 'failed' : 'done'].color}" stroke="#fff" stroke-width="1"><animateMotion dur="1.2s" repeatCount="3" path="${back}"/></circle>`
    edges += `<circle cx="${sx}" cy="${sy}" r="3" fill="${c}"/><circle cx="${ex}" cy="${ey}" r="3" fill="${c}"/>`
  }

  let cards = ''
  for (const id of ids) {
    const p = pos.get(id)
    if (p) cards += card(nodes[id], ...px(p), now)
  }

  // 3) nodos de skills, MCP y archivos
  const resNode = (r: Res, x: number) => {
    const live = r.uses.some(u => isLive(nodes[u.id]) && now - u.at < LIVE_USE_MS)
    const who = r.uses.map(u => nodes[u.id].type).filter((v, i, a) => a.indexOf(v) === i)
    const icon = r.kind === 'skill' ? '✦' : r.kind === 'mcp' ? '⛓' : r.wr ? '✎' : '▤'
    const name = r.kind === 'skill' ? r.label.replace(/^.*:/, '') : r.kind === 'mcp' ? friendlyMcp(r.label) : base(r.label)
    const last = r.uses.reduce((a, b) => (b.at > a.at ? b : a))
    const when = live ? 'en uso' : 'hace ' + fmt(now - r.at)
    const sub =
      r.kind === 'mcp' ? `${cut(last.tool, 18)} · ${r.n}× · ${when}`
      : r.kind === 'file' ? `${r.wr ? `editado ${r.wr}×` : ''}${r.wr && r.rd ? ' · ' : ''}${r.rd ? `leído ${r.rd}×` : ''} · ${when}`
      : `${r.n}× · ${when}`
    const third = r.kind === 'file' ? cut(dirOf(r.label) || r.label, 34) : 'de ' + cut(who.join(', '), 30)
    let s = ''
    if (live) s += `<rect x="${x - 3}" y="${r.y - 3}" width="${RES_W + 6}" height="${RES_H + 6}" rx="13" fill="none" stroke="${r.color}" stroke-width="2.2" opacity=".2"><animate attributeName="opacity" values=".15;.65;.15" dur="1.4s" repeatCount="indefinite"/></rect>`
    s += `<rect x="${x}" y="${r.y}" width="${RES_W}" height="${RES_H}" rx="10" fill="#1a1d2b" stroke="${r.color}" stroke-opacity="${live ? 0.9 : 0.4}" stroke-width="1.3"/>`
    s += `<rect x="${x}" y="${r.y + 8}" width="4" height="${RES_H - 16}" rx="2" fill="${r.color}"/>`
    s += T(x + 14, r.y + 20, 12.5, '#f4f6ff', `<tspan fill="${r.color}">${icon}</tspan> ${esc(cut(name, r.kind === 'file' ? 22 : 24))}`, ' font-weight="700"')
    s += T(x + 14, r.y + 35, 10, live ? r.color : '#8b93a7', esc(sub))
    s += T(x + 14, r.y + 47, 9.5, '#5f6684', esc(third))
    return `<g><title>${esc(`${r.label}\n${r.n} uso(s) por ${who.join(', ')}`)}</title>${s}</g>`
  }
  let resNodes = ''
  for (const c of cols) for (const r of c.list) resNodes += resNode(r, c.x)

  // cabecera con leyenda y rótulos de columna
  const keys = ['active', 'waiting', 'idle', 'done', 'failed'] as const
  const widths = keys.map(k => Math.round(STATUS[k].label.length * 6.3 + 26))
  let lx = W - PAD - widths.reduce((a, b) => a + b, 0)
  const legend = keys
    .map((k, i) => {
      const out = `<circle cx="${lx + 4}" cy="21" r="4" fill="${STATUS[k].color}"/>` + T(lx + 13, 25, 10.5, '#9aa1bf', STATUS[k].label)
      lx += widths[i]
      return out
    })
    .join('')
  const colHead = (x: number, txt: string, c: string) => T(x, TOP - 14, 10, c, txt, ' font-weight="700" letter-spacing="1.4"')
  const head =
    `<rect width="${W}" height="38" fill="#10121b"/>` +
    T(PAD, 25, 13, '#e9ecff', 'FLUJO DE AGENTES', ' font-weight="800" letter-spacing="1.5"') +
    (W > 760 ? legend : '') +
    (ids.length ? colHead(PAD, 'AGENTES Y SUBAGENTES', '#8b93a7') + cols.map(c => colHead(c.x, `${c.title} · ${c.list.length}`, c.color)).join('') : '')
  const empty = ids.length
    ? ''
    : T(W / 2, 92, 13, '#8b93a7', 'Sin actividad en los últimos 5 minutos.', ' text-anchor="middle"') +
      T(W / 2, 114, 11, '#5f6684', 'Cuando un agente, subagente, skill, MCP o archivo se use, aparecerá aquí.', ' text-anchor="middle"')

  return {
    W,
    H,
    counts,
    alt: `Flujo de agentes: ${counts.total} agentes, ${counts.active} activos, ${counts.skills} skills, ${counts.mcp} MCP, ${counts.files} archivos, ${counts.errors} errores`,
    source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${Math.round(W * scale)}" height="${Math.round(H * scale)}"><rect width="${W}" height="${H}" fill="#0d0f17"/>${head}${resEdges}${edges}${cards}${resNodes}${empty}</svg>`,
  }
}

// ---------- versión de texto (terminal / CLI, donde no hay SVG) ----------
export type TermRow = { depth: number; node: FlowNode; live: boolean; color: string; statusColor: string; statusLabel: string; age: string }

export const termRows = (nodes: Record<string, FlowNode>, now: number) => {
  const { ok, kids } = aliveSet(nodes, now)
  const ids = [...ok]
  const rows: TermRow[] = []
  const seen = new Set<string>()
  const walk = (id: string, depth: number) => {
    seen.add(id)
    const n = nodes[id]
    const st = STATUS[n.status]
    rows.push({
      depth,
      node: n,
      live: isLive(n),
      color: colorOf(n.type),
      statusColor: st.color,
      statusLabel: st.label,
      age: n.status === 'active' ? fmt(now - n.started) : n.status === 'waiting' ? 'espera tu permiso' : 'hace ' + fmt(now - n.last),
    })
    for (const k of (kids.get(id) ?? []).filter(x => ok.has(x) && !seen.has(x)).sort((a, b) => nodes[a].started - nodes[b].started)) walk(k, depth + 1)
  }
  ids
    .filter(i => { const p = parentOf(nodes, i); return !p || !ok.has(p) })
    .sort((a, b) => (a === MAIN_ID ? -1 : b === MAIN_ID ? 1 : nodes[a].started - nodes[b].started))
    .forEach(r => { if (!seen.has(r)) walk(r, 0) })
  return rows
}
export const termShort = { cut, base, friendly: friendlyMcp }
