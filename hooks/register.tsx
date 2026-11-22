import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { FlowNode } from '../types'
import { IDLE_MS, MAIN_ID, ZOOMS, addFile, addMcp, addSkill, drawFlow, friendlyMcp, termRows, termShort, mcpOf, mkMain, mkNode, shortModel } from './flow'

const PANE = 'agent-flow'
// Cambia la etiqueta si cambian los campos de un nodo: descarta lo guardado.
const nodes = atom({ plugin: 'agent-flow', key: 'nodes' } as const, {} as Record<string, FlowNode>, { shape: 'nodes-3' })
const zoom = atom({ plugin: 'agent-flow', key: 'zoom' } as const, 2)

type Patch = Partial<Pick<FlowNode, 'status' | 'tool' | 'desc' | 'model' | 'result'>> & {
  skill?: string
  mcp?: { server: string; tool: string }
  file?: { path: string; mode: 'read' | 'write' }
  error?: string
  isCall?: boolean
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const oneLine = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim()

// "Read foo.ts", "Supabase · apply_migration", "Bash npm test": lo que se ve que hace el agente.
const label = (e: any) => {
  const m = mcpOf(String(e.tool))
  if (m) return `${friendlyMcp(m.server)} · ${m.tool}`
  const arg = String(e.file_path ?? e.path ?? e.pattern ?? e.query ?? e.url ?? e.skill ?? e.command ?? e.description ?? '')
  return arg ? `${e.tool} ${arg.split(/[\\/]/).pop()}` : e.tool
}

// Archivo que toca una herramienta: leído o escrito.
const fileOf = (e: any): Patch['file'] => {
  const path = e.file_path ?? e.notebook_path
  if (typeof path !== 'string' || !path) return undefined
  if (e.tool === 'Read') return { path, mode: 'read' }
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(String(e.tool))) return { path, mode: 'write' }
  return undefined
}

// Cada escritura redibuja el panel entero (y reinicia sus animaciones): los cambios menores
// (herramienta en uso, archivos, modelo) se acumulan y se escriben todos juntos como mucho cada 2 s.
// Estado, skills, MCP, errores, resultados y altas se escriben al momento.
const lastWrite = new Map<string, number>()
const pending = new Map<string, Patch[]>()
let flushing = false

function apply(n: FlowNode, p: Patch, now: number): FlowNode {
  if (p.status) {
    if (p.status === 'active' && n.status !== 'active' && n.status !== 'waiting') n = { ...n, started: now }
    n = { ...n, status: p.status }
  }
  if (p.tool !== undefined) n = { ...n, tool: p.tool }
  if (p.desc) n = { ...n, desc: p.desc }
  if (p.model) n = { ...n, model: p.model }
  if (p.result !== undefined) n = { ...n, result: p.result }
  if (p.isCall) n = { ...n, tools: n.tools + 1 }
  if (p.skill) n = addSkill(n, p.skill, now)
  if (p.mcp) n = addMcp(n, p.mcp.server, p.mcp.tool, now)
  if (p.file) n = addFile(n, p.file.path, p.file.mode, now)
  if (p.error) n = { ...n, errors: n.errors + 1, lastError: p.error }
  return n
}

async function touch($: any, id: string | undefined, p: Patch, spawn?: { parent: string | null; type: string; desc: string }) {
  const key = id ?? MAIN_ID
  const now = await $.clock.now()
  const known = (await read($, nodes))[key]
  const isMinor = known && !spawn && !p.skill && !p.mcp && !p.error && p.result === undefined && (!p.status || p.status === known.status)
  if (isMinor && now - (lastWrite.get(key) ?? 0) < 2000) {
    pending.set(key, [...(pending.get(key) ?? []), p])
    if (!flushing) {
      flushing = true
      $.clock.after(2100, async () => {
        flushing = false
        for (const k of [...pending.keys()]) await touch($, k, {})
      })
    }
    return
  }
  const patches = [...(pending.get(key) ?? []), p]
  pending.delete(key)
  lastWrite.set(key, now)

  let info: { type: string; desc: string; parent: string | null } | null = null
  if (!known && !spawn && key !== MAIN_ID) {
    const a = (await $.agent.list()).find((x: any) => x.id === key)
    info = { type: a?.type ?? 'agente', desc: a?.description ?? '', parent: a?.parentId ?? MAIN_ID }
  }
  await update($, nodes, m => {
    const out = { ...m }
    if (!out[MAIN_ID]) out[MAIN_ID] = mkMain(now)
    let n = out[key]
    if (!n) {
      const s = spawn ?? info ?? { parent: null, type: 'Claude', desc: 'Sesión principal' }
      n = mkNode(key, s.parent, s.type, s.desc, now)
    } else if (spawn) {
      // un evento del subagente pudo llegar antes que su lanzamiento: el lanzamiento trae el padre real
      n = { ...n, parent: spawn.parent, type: spawn.type || n.type, desc: spawn.desc || n.desc }
    }
    n = { ...n, last: now }
    for (const q of patches) n = apply(n, q, now)
    out[key] = n
    // sin tope no crece sin fin: cae lo que lleva el doble de tiempo muerto
    for (const k of Object.keys(out)) if (k !== MAIN_ID && now - out[k].last > IDLE_MS * 2) delete out[k]
    return out
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'flow', description: 'Abre el panel de flujo de agentes' })
    void $.ui.open({ id: PANE, title: 'Flujo de agentes' })

    // Solo se redibuja si hay algo que mostrar y cada 30 s: lo justo para los contadores y el ocultado.
    $.clock.every(30000, async () => {
      const mine = await read($, nodes)
      const list: any[] = await $.agent.list()
      for (const a of list) {
        const cur = mine[a.id]?.status
        if ((cur === 'active' || cur === 'waiting') && ['completed'].includes(a.status)) await touch($, a.id, { status: 'done' })
        if ((cur === 'active' || cur === 'waiting') && ['failed', 'killed'].includes(a.status)) await touch($, a.id, { status: 'failed' })
      }
      if (Object.keys(mine).length) $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  on('command.run', { command: 'flow' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Flujo de agentes' })
    return { text: 'Panel abierto.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) await touch($, r.agentId, { status: 'active', model: shortModel(r.model ?? e.model ?? '') }, { parent: e.parentAgentId ?? MAIN_ID, type: e.subagentType, desc: e.description })
    return r
  })

  // El agente principal lee su modelo al empezar cada turno; los subagentes lo traen del lanzamiento.
  on('turn.start', async ($, e, next) => {
    const model = e.agentId ? undefined : shortModel(String(await $.session.model()))
    await touch($, e.agentId, { status: 'active', model })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    await touch($, e.agentId, {
      status: 'active',
      tool: label(e),
      isCall: true,
      skill: e.tool === 'Skill' ? String((e as any).skill ?? '') || undefined : undefined,
      mcp: mcpOf(String(e.tool)) ?? undefined,
      file: fileOf(e),
    })
    const ran: any = await next(e)
    // ¿falló o se denegó? (el hook nunca cambia el resultado: solo lo mira)
    try {
      if (ran?.deny) await touch($, e.agentId, { error: cut('denegado: ' + oneLine(ran.deny), 90) })
      else if (ran?.isError) await touch($, e.agentId, { error: cut(`${e.tool}: ${oneLine(ran.text) || 'error'}`, 90) })
    } catch {}
    return ran
  })

  // Si el motor va a preguntar a la persona, el agente pasa a "espera permiso" y avisa.
  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    if (r.decision === 'ask') {
      await touch($, e.agentId, { status: 'waiting', tool: label(e) })
      const n = (await read($, nodes))[e.agentId ?? MAIN_ID]
      $.ui.toast(`${n?.type ?? 'Un agente'} espera tu permiso (${e.tool})`)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    // el subagente guarda lo que respondió (el principal no: su respuesta es el propio chat)
    await touch($, e.agentId, e.agentId ? { status: 'done', result: cut(oneLine(e.answer), 140) } : { status: 'idle' })
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Svg, Text, Button } = $.ui.resolve(e)
    const z = await read($, zoom)
    const now = await $.clock.now()
    if (e.surface === 'terminal') {
      const rows = termRows(await read($, nodes), now)
      const { cut: c, base: b, friendly } = termShort
      return (
        <Box flexDirection="column">
          <Box gap={1}>
            <Button key="clear" label="Limpiar" onPress={() => update($, nodes, () => ({}))} />
            <Text dimColor>{rows.filter(x => x.live).length} activos · {rows.length} agentes</Text>
          </Box>
          {rows.length === 0 && <Text dimColor>Sin actividad en los últimos 5 minutos.</Text>}
          {rows.map(x => {
            const n = x.node
            const pad = '  '.repeat(x.depth) + (x.depth ? '└ ' : '')
            return (
              <Box key={n.id} flexDirection="column" marginTop={1}>
                <Text>
                  {pad}
                  <Text color={x.statusColor}>● </Text>
                  <Text bold color={x.color}>{n.type}</Text>
                  <Text dimColor> {x.statusLabel} · {x.age}{n.model ? ' · ' + n.model : ''}</Text>
                </Text>
                <Text dimColor>{'  '.repeat(x.depth)}{x.depth ? '  ' : ''}{c(n.desc || 'sin descripción', 90)}</Text>
                {n.tool ? <Text color={x.live ? x.color : undefined} dimColor={!x.live}>{'  '.repeat(x.depth)}{x.depth ? '  ' : ''}⚙ {c(n.tool, 80)}</Text> : null}
                {n.skills.length ? <Text color="#b197fc">{'  '.repeat(x.depth)}{x.depth ? '  ' : ''}✦ {n.skills.map(s => s.name.replace(/^.*:/, '')).join(', ')}</Text> : null}
                {n.mcp.length ? <Text color="#38d9a9">{'  '.repeat(x.depth)}{x.depth ? '  ' : ''}⛓ {n.mcp.map(m => friendly(m.server) + '·' + m.tool).join(', ')}</Text> : null}
                {n.files.length ? <Text color="#ffa94d">{'  '.repeat(x.depth)}{x.depth ? '  ' : ''}▤ {n.files.map(f => (f.w ? '✎' : '') + b(f.path)).join(', ')}</Text> : null}
                {n.lastError ? <Text color="#ff6b6b">{'  '.repeat(x.depth)}{x.depth ? '  ' : ''}⚠ {c(n.lastError, 90)}</Text> : null}
                {n.result && !x.live ? <Text color="#8fd3b6">{'  '.repeat(x.depth)}{x.depth ? '  ' : ''}↳ {c(n.result, 110)}</Text> : null}
              </Box>
            )
          })}
        </Box>
      )
    }
    const { source, alt, W, H, counts } = drawFlow(await read($, nodes), now, ZOOMS[z] ?? 1)
    const bump = (d: number) => () => update($, zoom, n => Math.min(ZOOMS.length - 1, Math.max(0, n + d)))
    return (
      <Box flexDirection="column" alignItems="flex-start">
        <Box gap={1}>
          <Button key="out" label="−" onPress={bump(-1)} />
          <Button key="in" label="+" onPress={bump(1)} />
          <Button key="clear" label="Limpiar" onPress={() => update($, nodes, () => ({}))} />
          <Text dimColor>
            {counts.active} activos · {counts.total} agentes · {counts.skills} skills · {counts.mcp} MCP · {counts.files} archivos{counts.errors ? ` · ${counts.errors} fallos` : ''} · zoom {Math.round((ZOOMS[z] ?? 1) * 100)}%
          </Text>
        </Box>
        <Svg source={source} alt={alt} width={Math.round(W * (ZOOMS[z] ?? 1))} height={Math.round(H * (ZOOMS[z] ?? 1))} />
      </Box>
    )
  })
}
