# Pie: núcleo fijo y plugins

Regla: si algo puede ser plugin, es plugin. El núcleo es lo que el agente usa
pero no puede modificar, porque de ello depende poder recuperarse de una
automodificación defectuosa.

## Núcleo (fijo)

| Pieza | Archivo | Estado |
|---|---|---|
| `State`: registro reconstruido reaplicando transformaciones ordenadas | `core/State.ts` | hecho |
| `Composition`: agrupa reconstrucciones y versiona la composición | `core/State.ts` | hecho |
| `Registries`: tools, modelos, fragmentos de prompt, hooks | `core/Registry.ts` | hecho |
| `PluginHost`: load / replace transaccional / unload por `Scope` | `core/PluginHost.ts` | hecho |
| `PluginLoader`: sincroniza un directorio de plugins, con marcha atrás | `core/PluginLoader.ts` | hecho |
| `AgentRun`: bucle durable (Workflow + actividades) | `core/AgentRun.ts` | hecho |
| `SessionStore`: árbol de entradas, colas, marcas de tool, aborts | `core/Session.ts` | hecho |
| Persistencia: `Storage.memory`, `Storage.sqlite` | `core/Storage.ts` | hecho (Postgres pendiente) |
| Eventos en vivo | `core/Events.ts` | hecho |
| Abort cooperativo (marca durable + señal en memoria) | `core/AbortSignals.ts` | hecho |
| Foto de la composición por llamada al LLM | `llm/<turno>` en `AgentRun.ts` | hecho |
| API pública `Pie` / `Session` | `Pie.ts` | hecho (falta navegar/fork, compactar, aprobaciones) |

## Plugins (incluidos, desactivables, reemplazables)

| Plugin | Estado |
|---|---|
| `opencode-go`: modelos de OpenCode Go | hecho |
| `coding-tools`: read, write, edit, bash, grep, find, ls (parámetros y límites de pi) | hecho |
| `system-prompt`: prompt base + entorno de la sesión | hecho |
| `context-files`: `~/.pie/AGENTS.md` y `AGENTS.md`/`CLAUDE.md` de la raíz al cwd | hecho |
| `self`: plugin_list, plugin_write, plugin_remove + guía para escribir plugins | hecho |
| Skills | pendiente |
| Compactación | pendiente |
| Aprobaciones (hook + `DurableDeferred`) | pendiente |
| Otros proveedores | pendiente |

`Pie.builtins` = opencode-go, system-prompt, context-files, coding-tools. `self`
se carga solo si hay `pluginDirectories` (el primero es donde escribe el agente).
Los plugins escritos por el agente pueden importar `effect` y `@pie/sdk` desde
cualquier carpeta: `core/ModuleResolution.ts` los resuelve a las copias de Pie
(hooks síncronos de Node, `module.registerHooks`).

## Garantías ya probadas

`packages/sdk/test/core.test.ts`:

- Cada transformación se aplica exactamente una vez por reconstrucción y en orden estable.
- Una transformación que lanza se salta y se informa; el resto se aplica.
- Un plugin cuyo `setup` falla no deja nada registrado.
- `replace` es atómico (un solo cambio observable), conserva la posición del
  plugin y, si la versión nueva falla, la anterior sigue funcionando.
- Al descargar un plugin se cierran sus finalizadores y fibras.
- Desde archivos: alta, edición, error de sintaxis (se mantiene la versión
  anterior) y borrado.

`packages/sdk/test/agent.test.ts` (motor en memoria, modelo falso):

- prompt → tool → resultado → respuesta, todo guardado como entradas.
- Un segundo prompt con un run activo falla; un followUp se absorbe en el mismo run.
- steer se entrega después de las tools y antes de la siguiente llamada.
- Tool inexistente y hook que deniega llegan al modelo como errores.
- Automodificación: una tool instala un plugin y la siguiente llamada ya ofrece su tool.
- abort corta una tool bloqueada y deja la sesión libre y reutilizable.

`packages/sdk/test/durability.test.ts` (SQLite, proceso real matado con SIGKILL):

- El turno del LLM ya respondido no se vuelve a pedir.
- La tool idempotente se vuelve a ejecutar; la no idempotente no, y el modelo
  recibe «outcome unknown».
- El run termina `completed` en el proceso nuevo.

`packages/sdk/test/coding-tools.test.ts`: límites de read, write con directorios,
edit único/ambiguo/inexistente y convergente al repetirse, bash (salida, código,
timeout, muerte del grupo de procesos al interrumpir), grep/find/ls, AGENTS.md.

`packages/sdk/test/self-modify.test.ts` (proceso Node real, plugins fuera del
repo): un plugin roto se rechaza con su error, uno válido carga y su tool se usa
en el mismo run.

`packages/sdk/test/OpenCodeGo.live.test.ts` (solo con `PIE_LIVE=1`): DeepSeek
v4.1 Flash recorre el bucle completo con una tool de un plugin.

Diagramas: `docs/arquitectura.html` (fuentes Mermaid en `docs/diagramas/*.mmd`,
regenerables con `mmdc -c docs/diagramas/mermaid-config.json`).

Prueba manual en vivo con todos los plugins:
`node --no-warnings packages/sdk/test/support/live-run.ts <cwd> "<prompt>"`.
Probado con DeepSeek v4.1 Flash: se escribe un plugin `reverse_text` y lo usa;
corrige un bug con read → edit → bash.
