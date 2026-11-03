# Pie: núcleo fijo y plugins

Regla: si algo puede ser plugin, es plugin. El núcleo es lo que el agente usa
pero no puede modificar: de él depende recuperarse de una automodificación
defectuosa. El modelo de datos está en `docs/EVENTOS.md`.

## Núcleo (fijo)

| Pieza | Archivo |
|---|---|
| Log de sesión en árbol (única fuente de verdad) | `core/Log.ts` |
| Programa del agente: eventos, `evolve`, `decide`, vista para el modelo | `core/Agent.ts` |
| Runtime: tick, ejecución de comandos, reacciones, bloqueo por base de datos, drenaje | `core/Runtime.ts` |
| Log de configuración de plugins | `core/ConfigLog.ts` |
| Gestor de plugins: carpeta + host, siembra, validación, instantáneas, restart, rollback, modo seguro, obligatorios | `core/Plugins.ts`, `core/PluginFolder.ts` |
| Recuperación sin plugins (CLI y supervisor) | `core/Recovery.ts`, `cli.ts` |
| `State` y `Composition`: registros que se reconstruyen | `core/State.ts` |
| Registros: tools, modelos, prompt, hooks, tipos de evento, proyecciones, reacciones | `core/Registry.ts` |
| `PluginHost` (load / replace / unload por `Scope`), `PluginLoader` (directorios) | `core/PluginHost.ts`, `core/PluginLoader.ts` |
| Motor de workflows de Effect sobre la base de datos | `core/LogWorkflowEngine.ts` |
| Eventos en vivo, abort en memoria, resolución de módulos, almacenamiento | `core/Events.ts`, `core/AbortSignals.ts`, `core/ModuleResolution.ts`, `core/Storage.ts` |
| API pública y supervisor | `Pie.ts`, `Supervisor.ts` |

## Plugins

Viven en `<home>/plugins/<id>/` (editables por el agente; se aplican con
`restart`). Un hogar nuevo se siembra desde `packages/sdk/plugins/<id>/`.

| Plantilla | Sembrada por defecto | Qué hace |
|---|---|---|
| `opencode-go` | Sí | Modelos de OpenCode Go |
| `system-prompt` | Sí | Prompt base y entorno de la sesión |
| `context-files` | Sí | `~/.pie/AGENTS.md` y `AGENTS.md`/`CLAUDE.md` de la raíz al cwd |
| `coding-tools` | Sí | read, write, edit, bash (300 s por defecto), grep, find, ls |
| `self` | Sí | restart, plugin_explain, plugin_rollback y la guía con las rutas |
| `todo` | La app | Lista de tareas como eventos, con proyección, vista y panel web |
| `web` | La app | Servidor local con token, API, SSE, `shell.html` con huecos y menú de recuperación, `web_inspect` |
| `web-chat` | La app | El chat de la interfaz web |

Plugins del host (en memoria, no editables desde la carpeta): `sdk-guard` y los
que pase quien embebe Pie (`Pie.layer({ plugins })`, p. ej. modelos falsos en
los tests). App lista para usar: `pie serve --home .pie --cwd .`.

## Pendiente

Compactación, aprobaciones (el motor ya tiene `DurableDeferred`), skills,
subagentes (workflows hijos), eventos de reintento visibles, Postgres,
instantáneas de proyecciones.

## Pruebas

| Archivo | Qué prueba |
|---|---|
| `test/core.test.ts` | `State`, `PluginHost`, carga desde archivos |
| `test/agent.test.ts` | Bucle sobre el log: tools, busy, followUp, steer, nulls, ids repetidos, tool inexistente, hook que deniega, reintentos del modelo, abort; `todo` con bifurcación y adds paralelos; reacciones; automodificación (rechazo de plugin roto y de punto de política) |
| `test/coding-tools.test.ts` | Las 7 tools y `AGENTS.md` |
| `test/durability.test.ts` | SIGKILL con SQLite en un proceso real: sin repetir el modelo, tool idempotente repetida, no idempotente «outcome unknown» |
| `test/self-modify.test.ts` | Proceso real, plugins fuera del repo, modos hot y restart con supervisor |
| `test/recovery.test.ts` | Rollback y deshacer el rollback, modo seguro, obligatorios, try/keep, reemplazar un plugin de serie; el supervisor revierte solo un plugin que tumba el arranque; la CLI ve y deshace |
| `test/web.test.ts` | Token, API, prompt de punta a punta, SSE, proyecciones, instalar un plugin de UI y deshacerlo |
| `test/workflow.test.ts` | Workflow de Effect con SIGKILL: actividades no repetidas, reloj que mantiene su hora, aprobación, resultado guardado |
| `test/OpenCodeGo.live.test.ts` | Solo con `PIE_LIVE=1`: DeepSeek v4.1 Flash real |

Prueba manual: `node --no-warnings packages/sdk/test/support/live-run.ts <cwd> "<prompt>"`.
