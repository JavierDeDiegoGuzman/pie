# Pie: todo son eventos

Lo durable siempre son eventos; lo vivo siempre son efectos que se derivan de
ellos. Diagramas en `docs/arquitectura.html`.

## Dos logs, una base de datos

| Log | Tabla | Qué guarda | Forma |
|---|---|---|---|
| Sesión | `pie_events` | Todo lo que pasa en una sesión: núcleo y plugins | Árbol; la rama actual va de la raíz a `leaf_id` |
| Configuración | `pie_config` | Instantáneas de la carpeta de plugins (`plugins/snapshot`) y marcas de configuración buena (`config/good`) | Lineal |

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
| `run/ended` | `completed`, `failed` o `aborted` (sin límite de turnos: se para con abort) |
| `model/selected` | Cambio de modelo |
| `notice` | Algo que Pie le dice al modelo antes de un paso (cambios de plugins aplicados o rechazados); lo ve como mensaje |

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

## Automodificación y vuelta atrás

**El SDK es fijo; todos los plugins son modificables.** Cada instalación de Pie
tiene un hogar (`.pie`): `pie.db` (sesiones y log de configuración) y
`plugins/`, una carpeta por plugin con su `index.ts` y lo que necesite (el
plugin `web` lleva ahí su `shell.html` y su `ui-sdk.js`). Un hogar nuevo se
siembra desde las plantillas del SDK (`packages/sdk/plugins/`).

Como en pi, el prompt le dice al agente dónde están sus plugins, el SDK (solo
lectura), las plantillas y la documentación. El agente los lee y edita con sus
herramientas normales (`read`, `edit`, `write`). No hay tool para aplicarlos ni
hay que reiniciar: como en OpenCode o el DeepSeek Harness, Pie aplica los
cambios solo, en un momento limpio (antes del siguiente paso de cualquier
sesión, nunca a mitad de una tool):

```
antes de cada llamada al modelo: ¿cambió la carpeta?
  → valida los plugins cambiados en una composición desechable
  → si cargan: plugins/snapshot (la carpeta entera) y se aplican en este proceso
  → si no: no se aplica nada
  → en ambos casos, un evento `notice` en la sesión: el agente lo lee como un
    mensaje de Pie (aplicado, o los errores) y lo ve el chat
```

`plugins.json` fija el orden y los plugins desactivados. Un plugin del host
(`sdk-guard`, fuera de la carpeta) deniega `write`/`edit` dentro del SDK; con
`bash` se podría saltar, así que es una barrera para el camino normal, no un
sandbox.

Formas de volver atrás (todas restauran una instantánea de la carpeta y lo
registran como una instantánea nueva, así que también se pueden deshacer):

| Vía | Cómo | Depende de plugins |
|---|---|---|
| Automática | Tras arrancar bien un rato, o al completar un run, se añade `config/good`. Si el proceso se cae dos veces seguidas nada más arrancar, el supervisor restaura la última buena | No |
| Agente | `pie explain` / `pie rollback` con bash; se aplica antes de su siguiente paso | No (solo bash) |
| Interfaz web | Menú «Plugins y deshacer» y banner de módulo roto («Desactivar») | Sí (`web`) |
| Terminal | `pie explain`, `pie rollback --to N` o `--last-good` (con `--home`) | No |
| Modo seguro | `PIE_SAFE=1`: carga las plantillas del SDK en vez de la carpeta | No |

Los cambios hechos a mano con Pie apagado se registran al arrancar.

## Interfaz web (plugins `web` y `web-chat`)

- El plugin `web` sirve en 127.0.0.1 con token: la página base (huecos
  `header`, `sidebar`, `main`, `panel` y el menú de recuperación), el SDK del
  navegador (`@pie/ui`), Preact + htm sin build, y la API con SSE.
- Cada plugin aporta un módulo de navegador con `ctx.ui(fn)`; `fn` se serializa
  y recibe el SDK. Cada módulo está aislado: si falla, la página lo dice y
  ofrece quitarlo o deshacer. Los cambios llegan a la página en vivo.
- El chat es otro plugin (`web-chat`) y el panel de tareas lo aporta `todo`.
- La página base (cabecera incluida) es `plugins/web/shell.html`: para
  cambiarla se edita ese archivo, no se tapa desde otro plugin con CSS.
- Cómo se hace UI con plugins: `plugins/web/README.md`. Los errores de los módulos en el navegador se guardan en `<home>/web-errors.log`.
- `pie serve --home .pie --cwd .` lanza la app bajo el supervisor.

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
  (Node no descarga ESM); reiniciar Pie de vez en cuando la libera.
- Los módulos de UI no se validan antes de instalarse (no hay navegador en el
  servidor): un error se ve en la página, que ofrece quitarlo o deshacer.
- La interfaz web es para una persona en local: un módulo de UI tiene el mismo
  poder que el agente.
