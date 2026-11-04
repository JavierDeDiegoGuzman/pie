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
| Gestor de plugins: carpeta + host, siembra, validación, aplicar antes de cada paso, instantáneas, rollback, modo seguro, obligatorios | `core/Plugins.ts`, `core/PluginFolder.ts` |
| Recuperación sin plugins (CLI y supervisor) | `core/Recovery.ts`, `cli.ts` |
| `State` y `Composition`: registros que se reconstruyen | `core/State.ts` |
| Registros: tools, modelos, prompt, hooks, tipos de evento, proyecciones, reacciones | `core/Registry.ts` |
| `PluginHost` (load / replace / unload por `Scope`), `PluginLoader` (directorios) | `core/PluginHost.ts`, `core/PluginLoader.ts` |
| Motor de workflows de Effect sobre la base de datos | `core/LogWorkflowEngine.ts` |
| Eventos en vivo, abort en memoria, resolución de módulos, almacenamiento | `core/Events.ts`, `core/AbortSignals.ts`, `core/ModuleResolution.ts`, `core/Storage.ts` |
| API pública y supervisor | `Pie.ts`, `Supervisor.ts` |

## Plugins

Como pi, el modelo ve pocas tools (read, write, edit y bash) y hace el resto con bash. Los cambios en la carpeta de plugins se aplican solos antes del siguiente paso. Cómo escribir un plugin: `docs/PLUGINS.md`.

Viven en `<home>/plugins/<id>/` (editables por el agente; se aplican solos
antes del siguiente paso). Un hogar nuevo se siembra desde `packages/sdk/plugins/<id>/`.

| Plantilla | Sembrada por defecto | Qué hace |
|---|---|---|
| `opencode-go` | Sí | Modelos de OpenCode Go |
| `system-prompt` | Sí | Prompt base y entorno de la sesión |
| `context-files` | Sí | `~/.pie/AGENTS.md` y `AGENTS.md`/`CLAUDE.md` de la raíz al cwd |
| `coding-tools` | Sí | Las tools del modelo, como pi: read, write, edit y bash (300 s por defecto) |
| `self` | Sí | Sin tools: la guía con las rutas (plugins, SDK, docs) y cómo ver o deshacer cambios con la CLI `pie` |
| `todo` | No (plantilla de ejemplo) | Lista de tareas como eventos, con proyección, vista y panel web |
| `web` | La app | Servidor local con token, API, SSE, `shell.html` con huecos y menú de recuperación; guía en su `README.md` |
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
| `test/agent.test.ts` | Bucle sobre el log: tools, busy, followUp, steer, nulls, ids repetidos, tool inexistente, hook que deniega, reintentos del modelo, abort; `todo` con bifurcación y adds paralelos; reacciones; automodificación (editar la carpeta + `restart`, rechazo de plugin roto, escritura en el SDK denegada) |
| `test/coding-tools.test.ts` | read, write, edit, bash y `AGENTS.md` |
| `test/durability.test.ts` | SIGKILL con SQLite en un proceso real: sin repetir el modelo, tool idempotente repetida, no idempotente «outcome unknown» |
| `test/self-modify.test.ts` | Proceso real, plugins fuera del repo: un cambio roto se rechaza y uno válido se usa en el mismo run, sin reiniciar |
| `test/recovery.test.ts` | Instantáneas, rollback y deshacerlo, modo seguro, obligatorios, cambios hechos con Pie apagado; el supervisor revierte solo un plugin que tumba el arranque; la CLI ve y deshace |
| `test/web.test.ts` | Token, API, prompt de punta a punta, SSE, proyecciones, añadir un plugin de UI, editar `web/shell.html`, y deshacer ambos |
| `test/workflow.test.ts` | Workflow de Effect con SIGKILL: actividades no repetidas, reloj que mantiene su hora, aprobación, resultado guardado |
| `test/OpenCodeGo.live.test.ts` | Solo con `PIE_LIVE=1`: DeepSeek v4.1 Flash real |

Prueba manual: `node --no-warnings packages/sdk/test/support/live-run.ts <cwd> "<prompt>"`.
