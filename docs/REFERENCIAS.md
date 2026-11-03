# Referencias: cómo reparten núcleo y extensiones pi, OpenCode 2.0 y DeepSeek Harness

Revisado el 2026-11-03 sobre el código fuente: pi-coding-agent 0.73 (npm),
OpenCode `anomalyco/opencode@79c80c7`, DeepSeek Harness
`deepseek-ai/deepseek-harness@8bd0733` (0.2.1-rc.5).

## pi: núcleo mínimo, todo lo demás son extensiones o paquetes

- Núcleo: bucle del agente, sesión en árbol (JSONL, entradas propias con
  `appendEntry`), 7 tools, compactación, skills, plantillas de prompt,
  registro de modelos, ajustes.
- Extensiones: módulos TS que se suscriben a eventos del ciclo de vida
  (`tool_call` para bloquear o modificar, `context`, `before_provider_request`,
  `session_before_compact`, `session_before_fork`/`_tree`, `input`,
  `model_select`…) y registran tools, comandos, proveedores, atajos y flags.
  Recarga con `/reload`.
- Fuera del núcleo a propósito: MCP, subagentes, permisos, plan mode, to-dos y
  bash en segundo plano. Se hacen con extensiones o paquetes (hay ejemplos:
  `permission-gate`, `plan-mode`, `subagent`, `todo`, `custom-compaction`,
  `git-checkpoint`, `protected-paths`, `sandbox`…).

## OpenCode 2.0: servicios en el núcleo, 80+ plugins internos

- Núcleo = servicios con estado, persistencia o control: bucle de sesión,
  ejecución de la compactación, motor de permisos, trabajos de subagentes,
  programación, shell/PTY, snapshots, worktrees, MCP, bus, almacenamiento.
- Plugins internos: cada tool, cada proveedor y el catálogo de modelos, los
  agentes (plan, goal), el prompt del sistema, los comandos y **toda la carga de
  configuración** (cada sección de `opencode.json` es un plugin que alimenta un
  servicio vía `transform`).
- Los servicios exponen `State` (`transform`/`reload`). Las tools aplican la
  política llamando al servicio del núcleo (`permission.assert`).
- Plugins protegidos: la política y la conexión con OpenCode no se pueden quitar
  desde la configuración del repo.

## DeepSeek Harness: «no hay núcleo privilegiado» (sobre Cordis)

- Todo es un plugin de Cordis, incluidos el adaptador del LLM, el registro de
  tools, el log de sesión y el propio bucle del agente (`dsh-agent-loop` es
  intercambiable). Hay una «columna vertebral» de paquetes `core/*`, pero cada
  uno es reemplazable desde la configuración.
- **Capability seams**: cada capacidad tiene definición del servicio, proveedor
  y consumidor (normalmente una tool). Los consumidores dependen de la
  definición, nunca del proveedor. Cambiar el proveedor de filesystem y
  subprocesos (por ejemplo a un sandbox remoto) mueve bash, PTY y LSP a la vez.
- **«Model-visible means logged»**: la sesión es un log de eventos de solo
  añadir (`turn/*`, `step/*`, `system/message`, `user/message`,
  `assistant/message`, `assistant/attempt`, `tool/*`). Toda petición al modelo
  se puede reconstruir desde el log; la compactación deja el contenido original
  en el log y el rejuego reproduce el mismo contexto.
- Composición: perfiles formados por capas de bundles más parches YAML; presets
  por sesión.
- Automodificación por niveles: tools de solo lectura para inspeccionar el
  runtime; definiciones dinámicas locales al proceso (en `node:vm`, se pierden
  al reiniciar); cambios persistentes vía Plugin Manager con recarga en caliente.
- Familias de capacidades destacables: compactación con varios backends (resumen,
  poda de resultados de tools, descarga de imágenes); guard (aviso de llamadas
  repetidas, timeouts); interaction (aprobación `ask`/`never` que falla cerrada y
  queda auditada, presets de permisos, `ask_user`); sandbox (bwrap, Landlock,
  Seatbelt); spill (resultados grandes a almacenamiento con un localizador); PTC
  (el modelo escribe un programa que llama a tools); `workflow` (script con
  `agent()`, `parallel()`, `pipeline()`, `phase()` que reparte trabajo a
  subagentes); team (tablero de tareas compartido); goal (objetivo durable con
  continuación automática); jobs, schedule y búsqueda en sesiones (SQLite FTS).

## Qué se lleva Pie de cada uno

| Idea | De | Para Pie |
|---|---|---|
| Núcleo mínimo; MCP, subagentes, permisos, plan y to-dos como extensiones | pi | Igual: se hacen como plugins |
| Eventos del ciclo de vida ricos (input, tool_call, context, compactación, fork) | pi | Ampliar los hooks actuales |
| Servicios del núcleo con `State`; plugins internos; configuración cargada por plugins | OpenCode | Ya está el `State`; falta configuración y plugins protegidos |
| Seams: definición / proveedor / consumidor | DeepSeek | `fs`, `subprocess`, `sandbox`, `llm`, compactación, aprobación como seams |
| «Model-visible means logged» | DeepSeek | Registrar en la sesión lo que se envió al modelo, no solo la respuesta |
| Automodificación por niveles (inspeccionar / experimentar / persistir) | DeepSeek | Separar `plugin_write` en probar y persistir |
| Bucle intercambiable | DeepSeek | No: en Pie el bucle es el Workflow durable y queda fijo |

## Cómo persiste estado un plugin

- **pi**: dos vías. `pi.appendEntry(customType, data)` guarda una entrada propia
  en la sesión que no va al modelo. El ejemplo `todo` guarda el estado completo
  en los `details` del resultado de su tool y lo reconstruye recorriendo **la
  rama actual** en `session_start` y `session_tree`, así que tras bifurcar o
  navegar el estado es el de esa rama.
- **DeepSeek Harness**: «estado durable de sesión = extender `SessionEventMap`»
  y renderizar y rejugar desde el log; proyecciones registradas que pliegan
  eventos ya confirmados (`ctx.sessionProjections`).
- **canica** (diseño en los hilos «Artifacts de Doconda y Canica» y su fork
  «YepCode», octubre de 2026): comandos, modelos como máquinas de estados, eventos
  que salen de las transiciones, `_log` de solo añadir, `_outbox`/`_inbox` y
  dedupe por `commandId`. Un plugin solo añade, con una escalera de poder:
  `ui`, `derive` (campos calculados al leer), `extend` (campos propios con
  namespace, guardados aparte, y comandos propios que solo tocan esos campos),
  `react` (después del commit) y `warn` (avisa, nunca bloquea). Quedan fuera
  `override`, `guard` y `enrich`: lo que bloquea es del núcleo, en «puntos de
  política» que el núcleo declara. Todo lo que añade un plugin es conmutativo;
  al quitarlo, sus datos se archivan, no se borran. El log no se migra nunca.
