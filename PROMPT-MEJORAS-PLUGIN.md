# Prompt para la sesión de mejoras del plugin

Copia todo lo que hay bajo la línea y pégalo como primer mensaje de una sesión
nueva abierta en `C:\Users\junio\OneDrive\Documentos\ChatGPT\Antigravity-CLI-Skill`.

Los hallazgos salen de usar el plugin en un caso real el 2026-08-28: auditar 250
documentos de otro repositorio (`C:\Glocation\Sistema-Autonomo-QA`) contra su
código. Se completaron 7 auditorías y 13 correcciones, pero costó más pelearse
con el plugin que auditar.

---

Trabaja en este repositorio: el plugin de Antigravity CLI para Claude Code y
Codex. Hay tests en `tests/` y el runtime está en
`plugins/antigravity/skills/antigravity-delegator/scripts/`.

Vengo de usar el plugin en un caso real y me encontré nueve problemas. Varios
son de código, no de documentación. Quiero que los arregles con pruebas, no que
los expliques en un README.

**Antes de tocar nada, reproduce cada problema.** Si alguno no se reproduce,
dímelo y no lo toques: prefiero seis arreglos ciertos que nueve supuestos.

## 1. El modo por defecto no completa tareas (el más grave)

`lib/agy.mjs:12-13`:

```js
const profile = run.accessProfile || "read-only";
args.push("--mode", profile.startsWith("write") ? "accept-edits" : "plan");
```

Sin `accessProfile`, el job va a `--mode plan`. Y `--mode plan` de `agy` **no es
«solo lectura que ejecuta»: es «planifica y espera aprobación»**. Con una tarea
mediana, el modelo devuelve un plan y un «dale Proceed» que en headless no llega
nunca.

Reproducción: delegué tres lotes de 5-6 documentos. Los tres devolvieron un plan
y cero trabajo. Con un solo documento por job sí ejecuta, porque el modelo no ve
motivo para planificar.

Esto convierte el default en una trampa: la protección contra escrituras es
correcta y necesaria, pero se paga con que las tareas grandes no terminan y el
usuario no se entera de por qué.

Lo que quiero decidido y resuelto:

- Un perfil que sea **de verdad solo lectura y ejecute** (si `agy` no lo ofrece
  nativamente, dilo explícitamente y propón la alternativa: allow-list de
  herramientas de lectura, `--sandbox`, o lo que corresponda).
- Que `read-only` deje de significar `plan` a secas, o que al menos el plugin
  **detecte** que el job terminó en un plan sin ejecutar y lo reporte como un
  estado propio (`awaiting-approval`), no como éxito.

## 2. Éxito silencioso con salida vacía

Reportado por Codex en su reproducción, **no verificado por mí**: `agy` devolvió
`status: SUCCESS` con respuesta vacía después de que se le denegara una lectura.

Un job que no produjo nada no puede reportarse como éxito. Verifícalo y, si se
confirma, haz que salida vacía o denegación de permisos den un estado distinto y
un mensaje que diga qué se denegó.

## 3. No se pasa `--add-dir`, y sin él no ve los archivos

`agy` no encuentra los archivos del repositorio aunque el cwd sea correcto.
Comprobado:

```bash
# falla: "The file doesn't exist in your local filesystem"
agy --model claude-opus-4-6-thinking --mode plan --print='Lee qaforge/apps/api/src/utils/internal-token.ts...'

# funciona
agy --model claude-opus-4-6-thinking --mode plan --add-dir "C:/Glocation/Sistema-Autonomo-QA" --print='...'
```

Codex observó además que `agy` buscaba primero en su carpeta scratch y luego
fuera del repositorio. El wrapper hoy no pasa `--add-dir`, así que la visibilidad
del workspace depende de la suerte.

`lib/workspace.mjs` ya calcula el workspace canónico. Pásalo como `--add-dir`.

## 4. El modelo no se fija, y `model-routing.mjs` ya sabe hacerlo

`lib/agy.mjs:8` hace `if (run.model) args.push("--model", run.model)`, y
`lib/model-routing.mjs` implementa rutas (`quality`, `balanced`, `fast`,
`gemini-first`, `third-party-first`). **Pero las skills no lo exponen**, así que
todo cae al default.

Importa para la calidad del resultado. Medido en el caso real:

- Con el modelo por defecto: veredictos correctos con **citas inventadas**. Dos
  brechas (`S-005`, `S-012`) tenían el juicio bueno apuntando a líneas
  equivocadas, y otras dos (`S-003`, `S-022`) se dieron por «no verificable» sin
  abrir el archivo, estando ambas resueltas.
- Con `claude-opus-4-6-thinking`: dos hallazgos, los dos ciertos al comprobarlos.

Expón la selección de modelo o de ruta en la skill `delegate`, y considera que
el default para tareas de auditoría sea `quality`.

## 5. La cuota se agota por modelo y el error llega como texto crudo

`claude-opus-4-6-thinking` se quedó sin cuota tras unas seis auditorías:

```
Error: Individual quota reached. Please upgrade your subscription to increase
your limits. Resets in 4h47m30s.
```

`gemini-3.1-pro-high` seguía teniendo cuota en ese mismo momento, así que **el
límite es por modelo, no por cuenta**. El plugin no lo detecta: el job se marca
como terminado y el error queda dentro del output, donde solo lo ves si lo lees.

Quiero que se detecte, que el estado del job lo refleje, y que el mensaje diga
cuándo se resetea y qué modelos siguen disponibles. Si `model-routing.mjs` puede
reintentar con el siguiente modelo de la ruta, mejor todavía — pero que el
reintento sea explícito en el resultado, nunca silencioso.

## 6. `--effort` rompe con los modelos thinking

```
Error: invalid model selection (--model "claude-opus-4-6-thinking"
--effort "high"): --effort is not supported for model "claude-opus-4-6-thinking"
```

Si el plugin pasa `--effort` de forma incondicional, fallará con todos los
modelos que ya traen razonamiento. Hazlo condicional y añade un test.

## 7. El runner se para a los 3 turnos y gasta los turnos en preámbulos

El subagente `antigravity-runner` se detiene a los 3 turnos. Con tareas de
cierto tamaño no llega: en el primer intento devolvió **30 filas de «NO
VERIFICABLE» sin haber abierto un solo archivo**, y lo admitía en su propio
texto.

El límite es del subagente, no de `agy`: llamando `agy --print` directo desde
bash no existe. Dos cosas:

- Documenta en la skill que el runner es para tareas cortas y acotadas, con un
  criterio claro de cuándo no usarlo.
- Haz que el runner no gaste turnos en anunciar lo que va a hacer. En el caso
  real hubo que mandarle «entrega ya lo que tengas, no abras más archivos» para
  sacarle algo.

## 8. Headless no puede pedir permisos y solo ofrece la salida nuclear

```
jetski: no output produced — a tool required the "command" permission that
headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under
permissions.allow in settings.json (e.g. command(<target>)). Alternatively,
re-run with --dangerously-skip-permissions to auto-approve all tools.
```

Pasó auditando un documento sobre estrategia de ramas, que necesitaba `git`.

**`--dangerously-skip-permissions` no es una opción aceptable** y el plugin no
debería sugerirla. Lo que hace falta es el camino intermedio: una allow-list
mínima por perfil (por ejemplo `git`, `rg`, `ls` para auditorías de solo
lectura), documentada y aplicable sin abrir la mano entera.

## 9. `--print` se come el siguiente argumento

```
Error: --print took "--model" as its prompt, so the intended prompt was left as
an argument and ignored.
```

Hay que escribir `--print='texto'` con `=`. Si el wrapper construye la línea de
comando, asegúrate de que lo hace bien y ponlo en un test de regresión.

## Además: `--json-schema` está sin aprovechar

`agy` lo soporta y el plugin no lo usa. Para tareas de auditoría, forzar la
salida a un esquema fijo acabaría con las tablas mal formadas y haría el
resultado parseable. Hay una carpeta `schemas/` en el skill que parece el sitio.

## Lo que NO quiero

- **No añadas `--dangerously-skip-permissions` en ninguna ruta**, ni como opción
  cómoda ni como sugerencia en un mensaje de error.
- **No debilites la protección contra escrituras.** Que el modo por defecto no
  pueda editar es correcto; el problema es que tampoco ejecuta.
- No conviertas esto en documentación. Si algo se arregla en código, arréglalo en
  código; el README va después.

## Criterios de aceptación

1. Cada problema confirmado tiene su test de regresión en `tests/`.
2. `npm test` (o el runner que use el repo) pasa en verde.
3. Los problemas que no reprodujiste están listados aparte, diciendo qué
   intentaste.
4. La skill `delegate` documenta cómo elegir modelo y qué perfil usar para
   auditorías de solo lectura.
5. Un caso de humo de punta a punta: delegar una auditoría de un archivo real de
   otro repositorio y que vuelva con contenido, no con un plan.

## Notas del entorno

- Windows. `agy` 1.1.22, Node 24.19.
- Estado del delegador:
  `C:\Users\junio\AppData\Local\antigravity-delegator\`
- Se pueden inyectar flags globales sin tocar código:
  `ANTIGRAVITY_AGY_PREFIX_JSON='["--model","claude-opus-4-6-thinking"]'`
  (`antigravity-delegator.mjs:19-25`). Útil para probar, no como solución.
- Repositorio grande para pruebas reales: `C:\Glocation\Sistema-Autonomo-QA`.

## Una cosa que el plugin hace bien y conviene no romper

La protección contra escrituras funciona y es por diseño, no por suerte: durante
toda la sesión real `git status` del repositorio auditado salió vacío. No fue que
los agentes se portaran bien, es que no podían escribir. Mantén esa garantía en
el código, no en el prompt.
