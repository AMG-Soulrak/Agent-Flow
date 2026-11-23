# agent-flow

Panel informativo en vivo para Claude Code (escritorio y terminal): muestra qué agente está activo, de quién cuelga cada subagente, qué skills, MCP, herramientas y archivos usa, y las líneas de flujo entre ellos.

- Las conexiones se mantienen hasta 5 minutos de inactividad.
- Escribe `/flow` para abrir el panel.
- En Claude Desktop se dibuja como SVG; en la terminal, como árbol de texto.

![Panel completo de agent-flow con la sesión principal, cuatro subagentes y las columnas de skills, MCP, herramientas y archivos](docs/img/panel-completo.png)

## Cómo se lee el panel

El gráfico va de izquierda a derecha: primero los agentes y, a la derecha, todo lo que usan.

![Detalle del panel en directo: la sesión principal activa y un MCP en uso](docs/img/panel-en-vivo.png)

**Columnas**

| Columna | Qué muestra |
|---|---|
| Agentes y subagentes | La sesión principal (`Claude`) y cada subagente que lanza, unidos por una línea al agente del que cuelgan |
| Skills | Las skills que ha cargado cada agente |
| MCP | Los servidores MCP usados y la última herramienta llamada |
| Herramientas | Las herramientas del propio motor (`Read`, `Bash`, `Grep`, `Write`…) con el número de usos y quién las usó |
| Archivos | Los archivos leídos (azul) o editados (naranja) y cuántas veces |

**Tarjeta de agente.** Cada una indica el tipo de agente, su estado, el encargo, la herramienta en uso o, al terminar, lo que respondió. Abajo lleva chips con el modelo y los contadores de skills, MCP, archivos y fallos.

**Estados** (el punto y el borde cambian de color):

| Color | Estado |
|---|---|
| Verde | activo |
| Ámbar | espera permiso: el agente está esperando que aceptes o rechaces una acción |
| Gris | en reposo |
| Azul | terminó |
| Rojo | falló |

**Líneas de flujo.** Brillan y llevan puntos en movimiento mientras el recurso se está usando (los últimos 20 s) y se atenúan después. Las que unen un agente con su subagente fluyen mientras el subagente trabaja, y al terminar vuelve un pulso al padre.

## Línea de tiempo

Debajo del gráfico hay una fila por agente con los últimos 5 minutos: cuándo trabajó, cuándo esperó permiso, cada llamada a una herramienta y cada fallo.

![Línea de tiempo de los últimos 5 minutos con una fila por agente](docs/img/linea-de-tiempo.png)

## Controles

- **− / +**: zoom del gráfico.
- **Pausar / Reanudar**: congela la vista para examinarla con calma; los avisos y el historial siguen su curso.
- **Filtro**: Todos, Activos o por departamento.
- **Encargos**: muestra el texto completo que recibió cada subagente.
- **Historial**: lista de todos los agentes de la sesión, también los que ya salieron del gráfico por inactividad.
- **Limpiar**: vacía el panel.
- **Avisos / Sonido**: aviso emergente (y un pitido opcional) cuando un subagente termina o falla.
- **Guardar historial**: escribe el historial en un archivo (ver Privacidad).
- **Detalle**: al elegir un agente en la lista inferior, se despliega todo lo suyo: encargo, herramientas, skills, MCP, archivos, errores y resultado.

## Privacidad

El panel guarda en el estado de la sesión el encargo de cada subagente (hasta 1200 caracteres) y su resultado. Con **Guardar historial** activado, que es el valor por defecto, además escribe un resumen por sesión en `~/.claude/agent-flow/history/<sesión>.json` con la descripción, el resultado, el último error y las rutas de los archivos de cada agente, pero no el encargo completo. Si no lo quieres, desactiva el botón **Guardar historial** en el panel.

## Instalación

Copia esta carpeta en la carpeta de mods de Claude Code y reinicia la sesión.

## Licencia

MIT. Ver [LICENSE](LICENSE).
