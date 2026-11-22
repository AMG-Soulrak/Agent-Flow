export type FlowSkill = { name: string; at: number; n: number }
export type FlowMcp = { server: string; tool: string; at: number; n: number }
// r = veces leído, w = veces editado o escrito
export type FlowFile = { path: string; r: number; w: number; at: number }
// herramienta propia del motor (Bash, Read, WebSearch…) y las veces que la usó
export type FlowTool = { name: string; at: number; n: number }

export type FlowNode = {
  id: string
  // null = raíz (la sesión principal)
  parent: string | null
  // tipo de agente: "Claude", "marketing-lead", "ruflo-core:coder"...
  type: string
  // trabajo encargado (la descripción del subagente)
  desc: string
  // el encargo completo, tal como se le dio al subagente (recortado a 1200 caracteres)
  prompt: string
  status: 'active' | 'waiting' | 'idle' | 'done' | 'failed'
  // herramienta en uso o la última: "Read foo.ts"
  tool: string
  skills: FlowSkill[]
  mcp: FlowMcp[]
  files: FlowFile[]
  toolUse: FlowTool[]
  // modelo corto: "sonnet 5.5", "haiku"
  model: string
  // esfuerzo del subagente ("low", "high"…); no lo da el motor para la sesión principal
  effort?: string
  // herramientas que fallaron y el último mensaje de error
  errors: number
  lastError: string
  // lo que respondió al terminar (solo subagentes)
  result: string
  tools: number
  // mientras espera permiso: qué pide y desde cuándo (ms del reloj del motor)
  ask: string
  askAt: number
  // línea de tiempo de los últimos 5 min (ms del reloj del motor):
  // llamadas a herramientas, fallos, esperas de permiso [desde, hasta; 0 = sigue] y tramos de trabajo [desde, hasta]
  marks: number[]
  errAt: number[]
  waits: Array<[number, number]>
  runs: Array<[number, number]>
  // ms del reloj del motor
  started: number
  last: number
}

// Resumen de un agente para el historial: lo que cabe en un archivo y se puede compartir sin enseñar el encargo entero
export type FlowHist = {
  id: string
  parent: string | null
  type: string
  desc: string
  status: FlowNode['status']
  model: string
  effort?: string
  started: number
  last: number
  tools: number
  errors: number
  lastError: string
  result: string
  skills: string[]
  mcp: string[]
  toolUse: string[]
  files: Array<{ path: string; r: number; w: number }>
}

declare module 'claude-code' {
  interface PluginState {
    'agent-flow': {
      nodes: Shaped<Record<string, FlowNode>>
      // índice en la lista de niveles de zoom
      zoom: number
      // si se ve la lista de encargos completos bajo el gráfico
      briefs: boolean
      // vista congelada: los agentes tal como estaban y la hora; null = en vivo
      frozen: Shaped<{ at: number; nodes: Record<string, FlowNode> } | null>
      // "all", "active" o "dept:<departamento>"
      filter: string
      // aviso emergente al terminar o fallar un subagente, y su sonido
      alerts: boolean
      sound: boolean
      // agente elegido para el panel de detalle ('' = ninguno)
      selected: string
      // si se ve el historial en lugar del gráfico
      showHistory: boolean
      // si se guarda el historial en un archivo
      historyOn: boolean
      history: Shaped<Record<string, FlowHist>>
    }
  }
}
