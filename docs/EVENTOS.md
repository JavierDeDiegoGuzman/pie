# Pie: todo son eventos

Lo durable siempre son eventos; lo vivo siempre son efectos que se derivan de
ellos. Diagramas en `docs/arquitectura.html`.

## Dos logs, una base de datos

| Log | Tabla | Qué guarda | Forma |
|---|---|---|---|
| Sesión | `pie_events` | Todo lo que pasa en una sesión: núcleo y plugins | Árbol; la rama actual va de la raíz a `leaf_id` |
| Configuración | `pie_config` | Plugins instalados por el agente (con su código), quitados, desactivados, reactivados | Lineal |

Cada evento tiene un id determinista y se añade de forma idempotente: repetir un
paso tras un reinicio nunca duplica nada.

## El agente como programa Elm (`core/Agent.ts`)

```
evolve(estado, evento) → estado      puro
decide(estado, ahora)  → comandos    puro
```

Eventos del núcleo:

| Evento | Qué significa |
|---|---|
| `run/started`, `user` | Empieza un run con el prompt |
| `input/queued` | steer o followUp en espera; `decide` los entrega en su momento como `user` |
| `model/requested` | Qué se envió al modelo: prompt del sistema y tools ofrecidas («model-visible means logged»); los mensajes son la rama anterior |
| `model/responded` / `model/failed` | Respuesta completa, o fallo con hora de reintento |
| `tool/started` / `tool/finished` | Una tool empezó / terminó |
| `abort/requested` | Abort durable |
| `run/ended` | `completed`, `failed`, `aborted` o `turn_limit` |
| `model/selected` | Cambio de modelo |

Comandos que devuelve `decide`: `CallModel`, `RunTool`, `Deliver`, `EndRun` y
`WakeAt` (no hay nada que hacer hasta una hora: el runtime programa un
despertador; así funcionan los reintentos con backoff).

Las reglas de durabilidad salen del propio log:

| Situación tras un reinicio | Lo que ve `decide` | Qué pasa |
|---|---|---|
| Llamada al modelo sin respuesta | `model/requested` sin `model/responded` | Se repite la llamada (se paga otra vez) |
| Tool idempotente a medias | `tool/started` sin `tool/finished` | Se repite |
| Tool no idempotente a medias | Lo mismo | No se repite: «outcome unknown» |
| Fallo del modelo con reintento pendiente | `model/failed` con `retryAt` | Se espera a esa hora |
| Abort pedido con el proceso caído | `abort/requested` | Se cierra lo pendiente y se termina `aborted` |

## El tick (`core/Runtime.ts`)

```
tick(sesión) = plegar la rama → decide → ejecutar lo pendiente → los resultados vuelven como eventos
```

Se dispara al añadir un evento, al vencer un `WakeAt` y al arrancar el proceso
(se reanudan todos los runs abiertos). Es *level-triggered*: lo que está en
curso se sigue en memoria y cada evento tiene id determinista, así que repetir
un tick nunca duplica trabajo. Un bloqueo en la base de datos (`pie_lock`)
garantiza un solo runtime por base de datos.

## Plugins: efectos que registran funciones sobre eventos

Un plugin es un `Effect` con su `Scope`. Lo que registra se va con él; los
eventos que emitió se quedan en el log.

| Nivel | API | Qué hace | ¿Puede cambiar lo que hace el núcleo? |
|---|---|---|---|
| extend | `ctx.events({ added: schema })` | Tipos de evento propios (`<plugin>/added`) | No |
| derive | `ctx.projection({ id, initial, on })` | Estado como pliegue de la rama; se recalcula, nunca se guarda | No |
| react | `ctx.react({ id, on, run })` | Actúa después de que el evento está en el log; cursor durable por sesión | No |
| view | `ctx.hook("context", …)` | Lo que añade al contexto del modelo | No |
| política | `ctx.hook("tool.before", …)` | Permitir o denegar una tool | Sí: solo plugins de confianza |

Las tools emiten con `tool.emit(type, data)`; las reacciones, con `r.emit`. Los
eventos registran **hechos**, no valores calculados del estado: las tools de un
mismo paso corren en paralelo, así que ids, contadores y totales se derivan en
la proyección (el plugin `todo` es el ejemplo).

## Automodificación y vuelta atrás (`core/Plugins.ts`, `plugins/self.ts`)

Todo lo que está por encima del núcleo es modificable por el agente, incluidos
los plugins de serie, `self` y la interfaz web. La red de seguridad no son las
protecciones (no hay ninguna por defecto) sino poder volver atrás siempre.

```
plugin_install(source) → validar en una composición desechable → plugin/installed (con el código)
plugin_try(source)     → solo en este proceso; plugin_keep(id) lo hace permanente
plugin_rollback(#n)    → config/reset: la composición de justo después del cambio #n (se puede deshacer)
```

Formas de volver atrás, de más a menos automática:

| Vía | Cómo | Depende de plugins |
|---|---|---|
| Automática | Tras arrancar bien un rato, o al completar un run, se añade `config/good`. Si el proceso se cae dos veces seguidas nada más arrancar, el supervisor vuelve a la última buena | No |
| Interfaz web | Menú «Plugins y deshacer»: deshacer el último cambio, volver a la última buena o a cualquier punto; banner con «quitar» cuando un módulo de UI falla | Sí (el plugin `web`) |
| Terminal | `pie explain --db …`, `pie rollback --db … --to N` o `--last-good` | No |
| Modo seguro | `PIE_SAFE=1`: solo los plugins de serie, ignorando los cambios del agente | No |

Opciones: `required` (plugins que deben cargar o el arranque falla, y el
supervisor hace rollback), `protected` (ids que el agente no puede cambiar),
`reload: "hot" | "restart"`.

## Interfaz web (`plugins/web.ts`, `plugins/web-chat.ts`, `web/`)

- El plugin `web` sirve en 127.0.0.1 con token: la página base (huecos
  `header`, `sidebar`, `main`, `panel` y el menú de recuperación), el SDK del
  navegador (`@pie/ui`), Preact + htm sin build, y la API con SSE.
- Cada plugin aporta un módulo de navegador con `ctx.ui(fn)`; `fn` se serializa
  y recibe el SDK. Cada módulo está aislado: si falla, la página lo dice y
  ofrece quitarlo o deshacer. Los cambios llegan a la página en vivo.
- El chat es otro plugin (`web-chat`) y el panel de tareas lo aporta `todo`.
- El agente usa `web_inspect` antes de cambiar la UI.
- `pie serve --db pie.db --cwd .` lanza la app bajo el supervisor.

## Workflows de Effect sobre la misma base de datos (`core/LogWorkflowEngine.ts`)

Para procesos de varios pasos escritos como código (`Activity`,
`DurableDeferred`, `DurableClock`): es el motor en memoria de Effect más un
journal (`pie_workflow`) de ejecuciones, resultados de actividades, deferreds,
relojes y resultados finales. Al registrar un workflow se reanudan sus
ejecuciones pendientes; un reloj mantiene su hora original tras un reinicio.

## Límites conocidos

- El journal de workflows no es parte del árbol de la sesión: bifurcar una
  sesión no bifurca los workflows que lanzó.
- Postgres/MySQL: falta el cliente y adaptar `INSERT OR IGNORE`.
- Proyecciones: se recalculan plegando la rama entera en cada lectura; para
  sesiones muy largas harán falta instantáneas.
- Recargar en caliente deja en memoria las versiones antiguas de los módulos
  (Node no descarga ESM); el modo `restart` no tiene ese problema.
- Los módulos de UI no se validan antes de instalarse (no hay navegador en el
  servidor): un error se ve en la página, que ofrece quitarlo o deshacer.
- La interfaz web es para una persona en local: un módulo de UI tiene el mismo
  poder que el agente.
