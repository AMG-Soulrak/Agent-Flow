export type FlowSkill = { name: string; at: number; n: number }
export type FlowMcp = { server: string; tool: string; at: number; n: number }
// r = veces leído, w = veces editado o escrito
export type FlowFile = { path: string; r: number; w: number; at: number }

export type FlowNode = {
  id: string
  // null = raíz (la sesión principal)
  parent: string | null
  // tipo de agente: "Claude", "marketing-lead", "ruflo-core:coder"...
  type: string
  // trabajo encargado (la descripción del subagente)
  desc: string
  status: 'active' | 'waiting' | 'idle' | 'done' | 'failed'
  // herramienta en uso o la última: "Read foo.ts"
  tool: string
  skills: FlowSkill[]
  mcp: FlowMcp[]
  files: FlowFile[]
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
  // ms del reloj del motor
  started: number
  last: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-flow': {
      nodes: Shaped<Record<string, FlowNode>>
      // índice en la lista de niveles de zoom
      zoom: number
    }
  }
}
