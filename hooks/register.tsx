import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { FlowHist, FlowNode } from '../types'
import { IDLE_MS, MAIN_ID, STATUS, ZOOMS, addFile, addMcp, addSkill, addTool, aliveSet, colorOf, drawFlow, filterNodes, filterOptions, fmt, friendlyMcp, termRows, termShort, mcpOf, mkMain, mkNode, shortModel } from './flow'
import { clip, historyJson, parseHistory, snap, trimHist } from './history'

const PANE = 'agent-flow'
// Cambia la etiqueta si cambian los campos de un nodo: descarta lo guardado.
const nodes = atom({ plugin: 'agent-flow', key: 'nodes' } as const, {} as Record<string, FlowNode>, { shape: 'nodes-4' })
const zoom = atom({ plugin: 'agent-flow', key: 'zoom' } as const, 2)
const briefs = atom({ plugin: 'agent-flow', key: 'briefs' } as const, false)
// Vista congelada (los agentes y la hora del momento de pausar); null = en vivo.
type Frozen = { at: number; nodes: Record<string, FlowNode> } | null
const frozen = atom({ plugin: 'agent-flow', key: 'frozen' } as const, null as Frozen, { shape: 'frozen-1' })
const filter = atom({ plugin: 'agent-flow', key: 'filter' } as const, 'all')
const alerts = atom({ plugin: 'agent-flow', key: 'alerts' } as const, true)
const sound = atom({ plugin: 'agent-flow', key: 'sound' } as const, false)
const selected = atom({ plugin: 'agent-flow', key: 'selected' } as const, '')
const showHistory = atom({ plugin: 'agent-flow', key: 'showHistory' } as const, false)
const historyOn = atom({ plugin: 'agent-flow', key: 'historyOn' } as const, true)
const history = atom({ plugin: 'agent-flow', key: 'history' } as const, {} as Record<string, FlowHist>, { shape: 'history-1' })

type Patch = Partial<Pick<FlowNode, 'status' | 'tool' | 'desc' | 'prompt' | 'ask' | 'model' | 'effort' | 'result'>> & {
  toolName?: string
  // reloj del motor en el momento del evento (las escrituras se agrupan, el evento ocurrió antes)
  at?: number
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

type Span = [number, number]

function apply(n: FlowNode, p: Patch, now: number): FlowNode {
  const at = p.at ?? now
  if (p.status) {
    const was = n.status
    // empieza un tramo de trabajo; si pasa a esperar permiso, empieza una espera; al salir de ella, se cierra
    if (p.status === 'active' && was !== 'active' && was !== 'waiting') n = { ...n, started: now, runs: [...n.runs, [now, now] as Span].slice(-12) }
    if (p.status === 'waiting' && was !== 'waiting') n = { ...n, askAt: now, waits: [...n.waits, [now, 0] as Span].slice(-12) }
    if (was === 'waiting' && p.status !== 'waiting') n = { ...n, waits: n.waits.map((w, i) => (i === n.waits.length - 1 && !w[1] ? ([w[0], now] as Span) : w)) }
    n = { ...n, status: p.status }
    if (p.status !== 'waiting') n = { ...n, ask: '' }
  }
  if (p.ask) n = { ...n, ask: p.ask }
  if (p.tool !== undefined) n = { ...n, tool: p.tool }
  if (p.desc) n = { ...n, desc: p.desc }
  if (p.prompt) n = { ...n, prompt: p.prompt }
  if (p.model) n = { ...n, model: p.model }
  if (p.effort) n = { ...n, effort: p.effort }
  if (p.result !== undefined) n = { ...n, result: p.result }
  if (p.isCall) n = { ...n, tools: n.tools + 1, marks: [...n.marks.filter(t => t > at - IDLE_MS), at].slice(-60) }
  if (p.toolName) n = addTool(n, p.toolName, now)
  if (p.skill) n = addSkill(n, p.skill, now)
  if (p.mcp) n = addMcp(n, p.mcp.server, p.mcp.tool, now)
  if (p.file) n = addFile(n, p.file.path, p.file.mode, now)
  if (p.error) n = { ...n, errors: n.errors + 1, lastError: p.error, errAt: [...n.errAt.filter(t => t > at - IDLE_MS), at].slice(-30) }
  // mientras trabaja o espera, el tramo abierto llega hasta ahora
  if ((n.status === 'active' || n.status === 'waiting') && n.runs.length) {
    const r = n.runs.slice()
    r[r.length - 1] = [r[r.length - 1][0], now]
    n = { ...n, runs: r }
  }
  return n
}

async function touch($: any, id: string | undefined, p: Patch, spawn?: { parent: string | null; type: string; desc: string }) {
  const key = id ?? MAIN_ID
  const now = await $.clock.now()
  p = { ...p, at: now }
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
  dirty.add(key)
}

// ---------- avisos ----------
// Un subagente terminó o falló: aviso emergente y, si se activó, un pitido. El sonido puede no oírse
// (el motor no reproduce audio en todas las terminales): un fallo ahí nunca debe romper nada.
async function notifyEnd($: any, n: FlowNode | undefined, kind: 'done' | 'failed') {
  if (!n || n.id === MAIN_ID) return
  try {
    if (await read($, alerts)) {
      const txt = kind === 'done' ? `✓ ${n.type} terminó${n.result ? ': ' + cut(n.result, 90) : ''}` : `✗ ${n.type} falló${n.lastError ? ': ' + cut(n.lastError, 90) : ''}`
      $.ui.toast(txt, { timeoutMs: kind === 'failed' ? 9000 : 5000 })
    }
    if (await read($, sound)) await Promise.resolve($.audio.play({ base64: clip(kind), mime: 'audio/wav' }, { gain: 0.6 })).catch(() => {})
  } catch {}
}

// ---------- historial ----------
// Cada agente que se toca se anota (resumen, sin el encargo entero) en un atom y, si está activado,
// en un archivo por sesión en la carpeta del usuario, no en la del proyecto (no acaba en un commit).
const dirty = new Set<string>()
let histLoaded = false
let histPath = ''

async function flushHistory($: any, force = false) {
  const ids = [...dirty]
  dirty.clear()
  if (!ids.length && !force) return
  const live = ids.length ? await read($, nodes) : {}
  await update($, history, h => {
    const out = { ...h }
    for (const id of ids) if (id !== MAIN_ID && live[id]) out[id] = snap(live[id])
    return trimHist(out)
  })
  if (!(await read($, historyOn))) return
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) return
  const sid = String(await $.session.id()).replace(/[^\w-]/g, '') || 'sesion'
  const path = `${String(home).replace(/\\/g, '/')}/.claude/agent-flow/history/${sid}.json`
  // al recargar el mod en plena sesión, lo ya guardado se recupera en lugar de pisarse
  if (!histLoaded) {
    histLoaded = true
    const old = parseHistory(await Promise.resolve($.fs.read(path)).catch(() => ''))
    if (Object.keys(old).length) await update($, history, h => trimHist({ ...old, ...h }))
  }
  await $.fs.write(path, historyJson(sid, await $.clock.now(), await read($, history)))
  histPath = path
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'flow', description: 'Abre el panel de flujo de agentes' })
    void $.ui.open({ id: PANE, title: 'Flujo de agentes' })

    // Solo se redibuja si hay algo que mostrar: cada 30 s para los contadores y el ocultado, y cada 10 s mientras
    // algún agente espera tu permiso (para que su cronómetro avance sin que el resto parpadee de más).
    // En pausa no se redibuja nada, pero los avisos y el historial siguen su curso.
    let tick = 0
    $.clock.every(10000, async () => {
      const mine = await read($, nodes)
      const list: any[] = await $.agent.list()
      for (const a of list) {
        const cur = mine[a.id]?.status
        const isLive = cur === 'active' || cur === 'waiting'
        if (isLive && a.status === 'completed') {
          await touch($, a.id, { status: 'done' })
          await notifyEnd($, (await read($, nodes))[a.id], 'done')
        }
        if (isLive && ['failed', 'killed'].includes(a.status)) {
          await touch($, a.id, { status: 'failed' })
          await notifyEnd($, (await read($, nodes))[a.id], 'failed')
        }
      }
      await flushHistory($).catch(() => {})
      const waiting = Object.values(mine).some(n => n.status === 'waiting')
      if (Object.keys(mine).length && (waiting || ++tick % 3 === 0) && !(await read($, frozen))) $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  on('command.run', { command: 'flow' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Flujo de agentes' })
    return { text: 'Panel abierto.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const row = r.agentId ? (await Promise.resolve($.agent.list()).catch(() => [])).find((x: any) => x.id === r.agentId) : undefined
    const effort = row?.effort ?? (e as any).effort
    if (r.agentId) await touch($, r.agentId, { status: 'active', model: shortModel(r.model ?? e.model ?? ''), effort: effort == null ? undefined : String(effort), prompt: cut(String((e as any).prompt ?? '').trim(), 1200) }, { parent: e.parentAgentId ?? MAIN_ID, type: e.subagentType, desc: e.description })
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
      // las herramientas con columna propia (MCP, skills) no se repiten en la de herramientas
      toolName: e.tool !== 'Skill' && !mcpOf(String(e.tool)) ? String(e.tool) : undefined,
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
      // qué pide, completo (el comando entero en Bash, la ruta en Edit…)
      const what = oneLine(`${e.tool} ${(e as any).command ?? (e as any).file_path ?? (e as any).path ?? (e as any).url ?? (e as any).pattern ?? ''}`)
      await touch($, e.agentId, { status: 'waiting', tool: label(e), ask: cut(what, 160) })
      const n = (await read($, nodes))[e.agentId ?? MAIN_ID]
      $.ui.toast(`${n?.type ?? 'Un agente'} espera tu permiso (${e.tool})`)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    // el subagente guarda lo que respondió (el principal no: su respuesta es el propio chat)
    const prev = e.agentId ? (await read($, nodes))[e.agentId]?.status : undefined
    await touch($, e.agentId, e.agentId ? { status: 'done', result: cut(oneLine(e.answer), 140) } : { status: 'idle' })
    if (e.agentId && prev !== 'done' && prev !== 'failed') await notifyEnd($, (await read($, nodes))[e.agentId], 'done')
    return next(e)
  })

  // Al cerrar la sesión se guarda lo último (el límite de tiempo es corto: un fallo no debe retrasar la salida).
  on('session.end', async ($, e, next) => {
    await flushHistory($, true).catch(() => {})
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Svg, Text, Button } = $.ui.resolve(e)
    const z = await read($, zoom)
    const real = await $.clock.now()
    const fz = await read($, frozen)
    const now = fz ? fz.at : real
    // En pausa no se lee la lista viva: lo que pase mientras tanto no redibuja nada.
    const all0 = fz ? fz.nodes : await read($, nodes)
    const flt = await read($, filter)
    const all = filterNodes(all0, now, flt)
    const opts = filterOptions(all0, now)
    const nextFlt = opts[(Math.max(0, opts.findIndex(o => o.id === flt)) + 1) % opts.length]
    const fltLabel = flt === 'all' ? 'Todos' : flt === 'active' ? 'Activos' : flt.replace(/^dept:/, '')
    const showBriefs = await read($, briefs)
    const alertsOn = await read($, alerts)
    const soundOn = await read($, sound)
    const histOn = await read($, historyOn)
    const viewHist = await read($, showHistory)
    const sel = await read($, selected)
    const histMap = viewHist ? await read($, history) : {}

    const rows = termRows(all, now)
    const selNode = sel ? all0[sel] : undefined
    const alive = aliveSet(all, now).ok
    const briefList = Object.values(all)
      .filter(n => n.id !== MAIN_ID && alive.has(n.id) && (n.prompt || n.desc))
      .sort((a, b) => a.started - b.started)

    const bump = (d: number) => () => update($, zoom, n => Math.min(ZOOMS.length - 1, Math.max(0, n + d)))
    const togglePause = async () => {
      if (fz) return update($, frozen, () => null)
      const snapNodes = await read($, nodes)
      const at = await $.clock.now()
      return update($, frozen, () => ({ at, nodes: snapNodes }))
    }

    const toolbar = (withZoom: boolean) => (
      <Box flexDirection="column">
        <Box flexWrap="wrap" columnGap={1}>
          {withZoom ? <Button key="out" label="−" onPress={bump(-1)} /> : null}
          {withZoom ? <Button key="in" label="+" onPress={bump(1)} /> : null}
          <Button key="pause" label={fz ? '▶ Reanudar' : '⏸ Pausar'} onPress={togglePause} />
          <Button key="filter" label={`Filtro: ${fltLabel}`} onPress={() => update($, filter, () => nextFlt.id)} />
          <Button key="briefs" label={showBriefs ? 'Ocultar encargos' : 'Encargos'} onPress={() => update($, briefs, v => !v)} />
          <Button key="hist" label={viewHist ? 'Ver gráfico' : 'Historial'} onPress={() => update($, showHistory, v => !v)} />
          <Button key="clear" label="Limpiar" onPress={() => update($, nodes, () => ({}))} />
        </Box>
        <Box flexWrap="wrap" columnGap={1}>
          <Button key="alerts" label={`Avisos: ${alertsOn ? 'sí' : 'no'}`} onPress={() => update($, alerts, v => !v)} />
          <Button key="sound" label={`Sonido: ${soundOn ? 'sí' : 'no'}`} onPress={() => update($, sound, v => !v)} />
          <Button key="save" label={`Guardar historial: ${histOn ? 'sí' : 'no'}`} onPress={() => update($, historyOn, v => !v)} />
        </Box>
        {fz ? <Text color="#ffb020">⏸ Vista congelada hace {fmt(real - fz.at)}. Los avisos y el historial siguen. Pulsa Reanudar para volver al directo.</Text> : null}
        {flt !== 'all' ? <Text dimColor>Filtro «{fltLabel}»: {rows.length} de {Object.keys(all0).length} agentes</Text> : null}
      </Box>
    )

    // Panel de detalle: todo de un agente, desplegable (el encargo y el resultado pueden llevar datos sensibles).
    const detail = (n: FlowNode) => {
      const st = STATUS[n.status]
      const when = n.status === 'active' ? 'activo desde hace ' + fmt(now - n.started) : n.status === 'waiting' ? 'espera permiso desde hace ' + fmt(now - (n.askAt || n.last)) : st.label + ' hace ' + fmt(now - n.last)
      return (
        <Box key={`d-${n.id}`} flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
          <Text>
            <Text bold color={colorOf(n.type)}>{n.type}</Text>
            <Text color={st.color}> ● {st.label}</Text>
            <Text dimColor> · {when}{n.model ? ' · ' + n.model + (n.effort ? ' · ' + n.effort : '') : ''} · {n.tools} llamadas</Text>
          </Text>
          {n.desc ? <Text>{n.desc}</Text> : null}
          {n.prompt ? <Text dimColor>{n.prompt}</Text> : null}
          {n.status === 'waiting' && n.ask ? <Text color="#ffb020">⏸ Pide permiso: {n.ask}</Text> : null}
          {n.skills.length ? <Text color="#b197fc">✦ Skills: {n.skills.map(s => s.name + ' ×' + s.n).join(', ')}</Text> : null}
          {n.mcp.length ? <Text color="#38d9a9">⛓ MCP: {n.mcp.map(m => friendlyMcp(m.server) + '·' + m.tool + ' ×' + m.n).join(', ')}</Text> : null}
          {n.toolUse.length ? <Text color="#ffe066">≡ Herramientas: {n.toolUse.map(t => t.name + ' ×' + t.n).join(', ')}</Text> : null}
          {n.files.map(f => (
            <Text key={f.path} color="#ffa94d">
              {f.w ? '✎' : '▤'} {f.path}
              <Text dimColor> ({f.w ? `editado ${f.w}×` : ''}{f.w && f.r ? ' · ' : ''}{f.r ? `leído ${f.r}×` : ''})</Text>
            </Text>
          ))}
          {n.errors ? <Text color="#ff6b6b">⚠ {n.errors} fallo{n.errors > 1 ? 's' : ''}. Último: {n.lastError}</Text> : null}
          {n.result ? <Text color="#8fd3b6">↳ {n.result}</Text> : null}
          <Button key="close" label="Cerrar detalle" onPress={() => update($, selected, () => '')} />
        </Box>
      )
    }
    const picker = (
      <Box flexDirection="column" marginTop={1}>
        <Text bold dimColor>DETALLE · elige un agente</Text>
        {rows.length === 0 ? <Text dimColor>Ningún agente visible.</Text> : null}
        <Box flexWrap="wrap" columnGap={1}>
          {rows.map(x => (
            <Button key={`sel-${x.node.id}`} label={`${x.node.id === sel ? '▶ ' : ''}${'· '.repeat(x.depth)}${x.node.type}`} onPress={() => update($, selected, v => (v === x.node.id ? '' : x.node.id))} />
          ))}
        </Box>
        {selNode ? detail(selNode) : sel ? <Text dimColor>Ese agente ya no está visible.</Text> : null}
      </Box>
    )

    // Historial: todos los agentes de la sesión, también los que ya salieron del gráfico por inactividad.
    const histRows = Object.values(histMap).filter(r => r.id !== MAIN_ID).sort((a, b) => b.last - a.last)
    const historyView = (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>HISTORIAL DE ESTA SESIÓN · {histRows.length} agentes</Text>
        <Text dimColor>{histOn ? (histPath ? `Guardado en ${histPath}` : 'Se guarda en la carpeta .claude/agent-flow/history de tu usuario') : 'Guardar en archivo está desactivado (el historial de aquí sigue en memoria)'}</Text>
        {histRows.length === 0 ? <Text dimColor>Todavía no hay agentes en el historial.</Text> : null}
        {histRows.map(r => {
          const st = STATUS[r.status]
          return (
            <Box key={r.id} flexDirection="column" marginTop={1}>
              <Text>
                <Text color={st.color}>● </Text>
                <Text bold color={colorOf(r.type)}>{r.type}</Text>
                <Text dimColor> {st.label} · duró {fmt(r.last - r.started)} · hace {fmt(real - r.last)} · {r.tools} llamadas{r.errors ? ` · ${r.errors} fallos` : ''}{r.model ? ' · ' + r.model + (r.effort ? ' · ' + r.effort : '') : ''}</Text>
              </Text>
              {r.desc ? <Text dimColor>{cut(r.desc, 140)}</Text> : null}
              {r.result ? <Text color="#8fd3b6">↳ {r.result}</Text> : null}
              {r.lastError ? <Text color="#ff6b6b">⚠ {r.lastError}</Text> : null}
              {r.files.length ? <Text color="#ffa94d">▤ {r.files.map(f => (f.w ? '✎' : '') + f.path.split(/[\\/]/).pop()).join(', ')}</Text> : null}
            </Box>
          )
        })}
        <Button key="histclear" label="Borrar historial" onPress={() => update($, history, () => ({}))} />
      </Box>
    )

    if (e.surface === 'terminal') {
      const { cut: c, base: b, friendly } = termShort
      return (
        <Box flexDirection="column">
          {toolbar(false)}
          <Text dimColor>{rows.filter(x => x.live).length} activos · {rows.length} agentes</Text>
          {viewHist ? (
            historyView
          ) : (
            <Box flexDirection="column">
              {rows.length === 0 && <Text dimColor>Sin actividad en los últimos 5 minutos.</Text>}
              {rows.length > 0 && picker}
              {rows.length > 0 && <Text dimColor>⏱ últimos 5 min, 10 s por casilla: ▃ trabaja · █ herramienta · ▒ espera permiso · ✖ fallo</Text>}
              {rows.map(x => {
                const n = x.node
                const pad = '  '.repeat(x.depth) + (x.depth ? '└ ' : '')
                const ind = '  '.repeat(x.depth) + (x.depth ? '  ' : '')
                return (
                  <Box key={n.id} flexDirection="column" marginTop={1}>
                    <Text>
                      {pad}
                      <Text color={x.statusColor}>● </Text>
                      <Text bold color={x.color}>{n.type}</Text>
                      <Text dimColor> {x.statusLabel} · {x.age}{n.model ? ' · ' + n.model + (n.effort ? ' · ' + n.effort : '') : ''}</Text>
                    </Text>
                    <Text dimColor>{ind}{c(n.desc || 'sin descripción', 90)}</Text>
                    {showBriefs && n.prompt ? <Text dimColor>{ind}“{n.prompt}”</Text> : null}
                    {n.status === 'waiting' && n.ask ? <Text color="#ffb020">{ind}⏸ pide permiso: {c(n.ask, 120)}</Text> : null}
                    {n.tool ? <Text color={x.live ? x.color : undefined} dimColor={!x.live}>{ind}⚙ {c(n.tool, 80)}</Text> : null}
                    {n.toolUse.length ? <Text color="#ffe066">{ind}≡ {n.toolUse.map(t => t.name + '×' + t.n).join(', ')}</Text> : null}
                    {n.skills.length ? <Text color="#b197fc">{ind}✦ {n.skills.map(s => s.name.replace(/^.*:/, '')).join(', ')}</Text> : null}
                    {n.mcp.length ? <Text color="#38d9a9">{ind}⛓ {n.mcp.map(m => friendly(m.server) + '·' + m.tool).join(', ')}</Text> : null}
                    {n.files.length ? <Text color="#ffa94d">{ind}▤ {n.files.map(f => (f.w ? '✎' : '') + b(f.path)).join(', ')}</Text> : null}
                    {n.lastError ? <Text color="#ff6b6b">{ind}⚠ {c(n.lastError, 90)}</Text> : null}
                    {n.result && !x.live ? <Text color="#8fd3b6">{ind}↳ {c(n.result, 110)}</Text> : null}
                    <Text>{ind}<Text dimColor>⏱ </Text>{x.line.map((seg, i) => <Text key={i} color={seg[1]} dimColor={!seg[1]}>{seg[0]}</Text>)}</Text>
                  </Box>
                )
              })}
            </Box>
          )}
        </Box>
      )
    }

    const { source, alt, W, H, counts } = drawFlow(all, now, ZOOMS[z] ?? 1, !!fz)
    return (
      <Box flexDirection="column" alignItems="flex-start">
        {toolbar(true)}
        <Text dimColor>
          {counts.active} activos · {counts.total} agentes · {counts.skills} skills · {counts.mcp} MCP · {counts.tools} herramientas · {counts.files} archivos{counts.errors ? ` · ${counts.errors} fallos` : ''} · zoom {Math.round((ZOOMS[z] ?? 1) * 100)}%
        </Text>
        {viewHist ? (
          historyView
        ) : (
          <Box flexDirection="column" alignItems="flex-start">
            <Svg source={source} alt={alt} width={Math.round(W * (ZOOMS[z] ?? 1))} height={Math.round(H * (ZOOMS[z] ?? 1))} />
            {picker}
            {showBriefs && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>ENCARGOS</Text>
                {briefList.length === 0 && <Text dimColor>Ningún subagente visible.</Text>}
                {briefList.map(n => (
                  <Box key={n.id} flexDirection="column" marginTop={1}>
                    <Text bold color={colorOf(n.type)}>{n.type}{n.desc ? ' · ' + n.desc : ''}</Text>
                    <Text dimColor>{n.prompt || 'Sin texto de encargo.'}</Text>
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
