# Pruebas headless de la app (Playwright: Chromium, y WebKit para las del iPad)

Pruebas de extremo a extremo de `index.html` sin Supabase real: se intercepta `/rest/v1/*`
con respuestas simuladas y se carga la app en un navegador headless (Chromium por defecto;
viewport de iPad en `app_ipad.js`). Cubren lo que más duele si se rompe: que no se pierda lo
escrito, que los guardados sean parciales (no pisan a otros dispositivos), labs/WinLab,
importación de censo, No olvidar/procedimientos sin red y atajos.

```bash
cd tests/headless
npm ci && npx playwright install chromium   # una sola vez; Playwright fijado en package.json (1.56.1)
npm run all                            # todas las suites (= bash run_all.sh ../..)
npm run suite -- app_sync app_ipad     # solo algunas
npm run webkit                         # las suites del iPad en WebKit, el motor de Safari (ver abajo)
node app_sync.js                       # una suite suelta, con el repo servido en 127.0.0.1:8771 (ver Puertos)
node syncheck.js ../../index.html      # sintaxis de los 7 <script> inline
```

`package.json` fija la versión exacta de Playwright (`devDependencies` + `package-lock.json`): la
misma en cada máquina y en CI, sin `npm i -g playwright` que cambia de versión sola. Las suites hacen
`require('playwright')` y Node lo resuelve desde `tests/headless/node_modules` (lo crea `npm ci`); un
Playwright instalado global **no** lo encuentran por sí solas, porque Node no busca en la carpeta
global de npm. Si solo tienes la versión global, exporta `NODE_PATH=$(npm root -g)` antes de correrlas.

## Puertos

`run_all.sh` ya no usa puertos fijos ni mata procesos (`fuser -k`): en cada corrida pide al sistema
tres puertos libres, sirve el directorio indicado en los tres y se los pasa a las suites por variables
de entorno, así dos baterías (o la batería y un servidor tuyo) conviven en la misma máquina:

| Variable | Quién la usa | Si no está definida |
|---|---|---|
| `PL_BASE_URL` (= `http://127.0.0.1:$PL_PORT_C`) | todas las suites `app_*` | `http://127.0.0.1:8771` |
| `PL_BASE_URL_A` (= `http://127.0.0.1:$PL_PORT_A`) | `mock.js` | `http://127.0.0.1:8766` |
| `PL_BASE_URL_B` (= `http://127.0.0.1:$PL_PORT_B`) | `noCdn.js` | `http://127.0.0.1:8767` |

Una suite suelta (`node app_sync.js`) funciona igual que antes: sirve el repo en su puerto de siempre
(`python3 -m http.server 8771 --bind 127.0.0.1` desde la raíz) o apunta `PL_BASE_URL` a otro
servidor. `app_cxocr.js` y `app_pencil.js` no usan puerto (sirven el repo desde `page.route`).
`mock.js` y `noCdn.js` nacieron con puertos propios aunque sirvan el mismo directorio (no hay una razón
técnica documentada); se conservan tres puertos por si algún día dos suites necesitan servirse con
configuraciones distintas.

## Motor: Chromium o WebKit (Safari)

Las suites lanzan el navegador con `_browser.js`, que lee `BROWSER` (`chromium` por defecto, `webkit`
o `firefox`). «iPad Pro 11» en Chromium solo simula tamaño, touch y UA; el motor de Safari es WebKit,
así que las suites del iPad (`app_ipad`, `app_pen`, `app_pencil`, `app_offline`, `app_cajas`) conviene
correrlas también ahí:

```bash
npx playwright install --with-deps webkit   # una sola vez (en Linux instala también sus librerías del sistema)
npm run webkit                              # = BROWSER=webkit bash run_all.sh ../.. app_ipad app_pen app_pencil app_offline app_cajas
BROWSER=webkit node app_cajas.js            # una suite suelta
```

Ni WebKit ni Chromium sustituyen la prueba en un iPad real: el Apple Pencil y Scribble no se pueden
simular.

## En CI

`.github/workflows/ci.yml` corre en cada pull request (y antes de publicar la app) toda la batería en
Chromium (`npm run all`) con la versión de Playwright fijada aquí (`npm ci` en `tests/headless`), y
las suites del iPad en WebKit (`npm run webkit`) como aviso: aparecen en el PR pero no lo bloquean
hasta que pasen en WebKit. Un PR con una suite de Chromium en rojo no se fusiona.

| Suite | Qué cubre |
|---|---|
| `noCdn.js` | la app arranca aunque no cargue supabase-js (aviso en el login, sin errores) |
| `app_hoja.js` | Modo Hoja de visita: cuadrícula con todas las cajas abiertas (recordado por dispositivo), ⚙ Cajas, pase matutino con fecha e historial por día, ➕ Hoy en IC/Cultivos/Entrega/Recibo, impresión una hoja por cama |
| `app_fotos.js` | Fotos en cirugías y cultivos (reducción, Storage con URL firmada, inline sin red + reintento, quitar con Regresar), ✍️ → 📌 A la caja (PNG del trazo), autor por caja (chips, iniciales en ➕ Hoy y Tomar guardia, meta conservada al sincronizar) |
| `app_pen.js` | ✍️ Lápiz. **Regla unificada en iPad** (`window.__pl_force_ipad`): en Scribble la app NO intercepta el lápiz en NINGUNA caja (vitales FC/TA/DxTx/balance, gasto y sitio de drenajes, dieta, días ATB, mL/h del vasopresor, labs, sangrado, modal, textareas con y sin data-key: pointerdown/touchstart no cancelados, sin sesión, sin aviso; «95» a mano sobre FC no hace nada); ✍️ Tinta solo intercepta las cajas grandes de la ficha (textarea con data-key: tinta en `checklist.__ink`, toque = cursor) y lo demás sigue en Scribble con aviso una vez; el botón cicla Scribble ↔ Tinta (nunca → Texto); un `pl_pen_mode` "2" guardado se migra a "0" al leerlo y al cargar (recarga con initScript); un "1" (Tinta) heredado se baja a Scribble UNA sola vez (marca `pl_pen_ipad_v2`) y la Tinta elegida después con ✍️ se respeta. **Fuera del iPad** nada cambia: tres estados (Scribble, → Texto, Tinta); modo Tinta (capa por caja solo para el Apple Pencil; tachadura borra lo que toca; toque = cursor; dedo/ratón no pintan; la caja crece; menú ✍️; reescala; remontaje por MutationObserver); **escritura directa sin recuadro** sobre un cristal a pantalla completa: los NÚMEROS los reconoce la app al instante (`PEN_OCR` dígitos; valor al soltar 0.9 s por la vía del teclado; verde y se desvanece; cambio de campo por lejanía o toque; tachar borra; aprende la letra) y el TEXTO va por **IA** con lectura PROVISIONAL (morada, nunca guardada; la IA decide; si falla o no hay worker la caja vuelve a lo que tenía; lotes seguidos en la misma caja se encadenan en orden; el teclado "suelta" la caja y lo tecleado nunca se mezcla con el provisional; la tarjeta repintada por Realtime conserva el lote); cajas de modales; `PEN_OCR` a fondo (palabras/cifras en tres tamaños, renglones, perturbados ≥ 90 %, dígitos ≥ 93 %, < 400 ms); vista iPad (tira de camas en la barra, riel oculto < 1340 px, sin botones flotantes, ⋯ Más → Importar y respaldo) |
| `app_entrega.js` | Entrega de guardia que RESUME (quirófano, atención, gastos, labs puntuales, lo nuevo del día, pendientes): `buildEntregaResumen`, botón ✨ Resumen idempotente (no toca lo escrito a mano), vista 📤 Entrega con SOLO Diagnóstico, signos vitales (o los del último día del pase, con fecha), gastos, laboratorios puntuales, cultivos y estudios de imagen ("sin registro" si falta); 📽 Modo Proyector: empieza en la cama 150 con el orden del tablero, «Ir a cama», ficha encuadrada y TODOS los laboratorios (E6); INR siempre visible (estimado TP ÷ testigo cuando WinLab no lo reporta: alias `tp_testigo`, tabla de foco, celda de lista, línea de pase, nota); novedades automáticas de labs solo con valores críticos |
| `app_labkeep.js` | 🧪 Labs que nunca se pierden: un guardado con copia vieja (solo 1 fecha) sube TODAS las fechas que ya están en la nube y la pantalla las recupera sin perder la edición (K1); sin red para esa consulta el guardado sigue (K2); «Eliminar labs» sí quita la fecha, viaja en `checklist.__lab_deleted` y ningún guardado posterior la regresa (K3); respaldo en segundo plano `_winlabBackfillOlder` repone fechas del robot de hace > 4 días solo de este internamiento (ingreso − 5 días), suelta las filas viejas de memoria y corre una vez por dispositivo (K4); una fecha borrada no regresa con los mismos valores del robot pero sí con un resultado nuevo (K5); encabezado de WinLab con menos nombres que el censo entra solo con `__target`, nunca otra persona ni 2 nombres (K6); el botón de Labs refresca sin «Error» (K7) |
| `app_cajas.js` | 📏 Todo el texto cabe en su cuadro (iPad horizontal, vertical, Hoja de visita e iPhone): Cirugías con procedimiento y hallazgos que crecen a todo su texto y sangrado/cirujano con espacio; drenajes, sondas y estomas con el gasto completo y legible (≥ 12 px; 4-5 cifras a 16 px), en dos renglones si el panel es angosto; nada cortado aunque la sección se abra después (K1-K2); al enfocar un cuadro reducido vuelve a 16 px para que iOS no haga zoom y al soltarlo se ajusta (K3); un valor puesto por código se ajusta al instante (K4) |
| `app_cxocr.js` | 📷 Cámara de Cirugías y 🤖 nota postquirúrgica (sin puertos): la foto sobrevive a un evento Realtime durante la subida; el 📷 abre UN selector global (multiple); la IA recibe la(s) foto(s) en JPEG y llena SOLO los campos vacíos (lo escrito nunca se pisa), con ↩ Regresar y aviso; «📷 Nota postquirúrgica» no crea fila si se cancela y con 2 páginas crea 1 fila; error 500 → foto intacta, en cola y se procesa al volver la red; subida lenta → inline pendiente y luego Storage; visor dentro de la app con URL firmada 1 h |
| `app_pencil.js` | ✍️ Apple Pencil en las tarjetas y 🗂️ Misceláneo (sin puertos): en iPad + Scribble cero oyentes táctiles no pasivos en document (el lápiz escribe, no «solo selecciona»); Tinta los vuelve a poner y de regreso se quitan; en 📌 Tablero pasar de una nota a otra no destruye la nota en la que se escribe; tocar la cabecera de la ficha no pliega la tarjeta; la caja se llama Misceláneo y lo escrito sobrevive al cambiar de tarjeta y, sin red, al ocultar la app (localStorage + cola) |
| `app_expdup.js` | 🪪 Expediente repetido en el censo (dos personas con el mismo número por error de captura; el sync ya sube a las dos): aparecen las dos con claves distintas (X1); la imagen del RIS se atribuye por el paciente que asignó el robot (`patient_id`) o, en filas viejas, por nombre, y el estudio sin nombre a nadie (X2); un estudio asignado a otro paciente activo no sale aunque el exp sea único (X16); la entrega automática no guarda en una nota el estudio de la otra (X3); la caja Cultivos (lab) no se muestra con gemelos y, con exp único, no muestra cultivos de otra persona que tuvo ese exp (`busqueda`, X4); la guarda de nombre de los labs es exclusiva (X5) y la fila más nueva de la otra persona no le quita a nadie la suya (X11); un nombre con solo apellidos que encaja con dos personas no recibe datos de ninguna (X15); la línea del robot avisa en las dos y no muestra resultado ni sugerencias de la otra persona (X6); no cuentan como duplicado (X7); ✏️ Editar no se bloquea, agregar ese exp pide confirmar (X8) y dos personas con nombre y apellido en común nunca se «mueven» una sobre otra (X13); misma persona = todas las palabras o parecido sin contradicción de edad/sexo, y JUAN/JULIAN o ANA/ADRIANA no son «casi iguales» (X12); el Excel empareja por nombre (X9), el gemelo cuya cama toma el otro sale en «no encontrados» (X14a) y el reingreso acepta HDEZ≈HERNANDEZ pero no a otra persona ni a un nombre parecido con otra edad (X14b-c) |
| `app_guardia.js` | 🕘 Historial por caja (botón en cada caja; modal con versiones anteriores desde la función SQL `pl_historial_caja_v2` —texto plano, `fmt`— con respaldo a `pl_historial_caja` si la base no la tiene (404) y decodificación de las sub-llaves del checklist guardadas como texto JSON; marca «recortada» a 6000 letras; autor, dispositivo, hora, letras; restaurar pasa por updateField/updateCkText, sube y queda en ↩ Regresar; selector de caja incl. sub-llaves del checklist y Entrega; fallo de red visible), sección 🔄 Guardia (encabezado único con «📥 Recibir guardia», Recibido de solo lectura con ✏️ Corregir, etiquetas nuevas), 👤 autor y hora en Procedimientos del día (se conserva al editar) |
| `app_vp.js` | Vasopresores (norepinefrina / vasopresina: dosis con peso, dilución 4 mg/100 mL y mL/h en mcg/kg/h con el equivalente en mcg/kg/min; ⚖️ peso en la misma fila; meta en mcg/kg/h → mL/h; avisos de dosis alta y SSC), ventilador ampliado (Pplat, Pmedia, I:E, peso predicho, VT mL/kg, presión de distensión), texto en la nota, 🤖 Nota IA en un clic (borrador + contexto al worker, limpieza, encabezado y firma garantizados, notas previas, si falla → borrador), ↗ Pasar a la página de notas (URL en configuración, portapapeles) |
| `app_admin.js` | Cuentas con administrador: cabeceras X-PL-Device / X-PL-User en cada petición, perfil al entrar (nombre de la cuenta, último acceso, botón 👥 solo admin), cuenta bloqueada → fuera con aviso, ¿Olvidaste tu contraseña?, enlace de recuperación (#type=recovery → contraseña nueva), panel 👥 Usuarios (lista, crear cuenta con contraseña temporal, bloquear, rol, nombre, contraseña temporal, enlace, borrar; sin bloquearse a sí mismo), 🕵️ Actividad (quién, desde dónde, de → a, filtros), 👤 Mi cuenta (nombre, dispositivo, cambiar contraseña) |
| `app_robot.js` | 🤖 Robot WinLab por paciente: aviso cuando no lo encontró (qué buscó, nombres parecidos tocables), ✏️ Nombre en WinLab (alias en la nota, con Regresar y autor), 🔎 Buscar ahora (corrida dirigida {exp} al worker; en cola; sin internet), vigilancia hasta que llega el resultado («encontrado como …») |
| `app_offline.js` | abrir sin red: service worker con la app y `vendor/` en caché, ningún script externo, sesión guardada sin red, lo escrito sin red queda en el dispositivo y en la cola con su campo, recarga sin red, al volver la red lo remoto no pisa lo escrito, ↩ Regresar / ↪ Rehacer; cama cambiada sin red en ✏️ Editar: sobrevive a la recarga, Realtime y la fila remota no la pisan, sube con la cama nueva y su marca `cama_app_ts` (también al abrir la app con red) |
| `mock.js`, `app_p0.js` | arranque, persistencia, outbox, re-clavado de ids |
| `app_sync.js` | línea base + diff (sin campos sucios solo viaja lo que cambió), campos en vuelo al ocultar la app, outbox con reintento, sin push masivo tras carga fallida, modal que no pisa Realtime, unidades mg/dL, snapshot con sangre, DELETE no suprimido |
| `app_ipad.js` | Hb crítica visible, ocultar la app conserva texto/Dx, repintado suave sin robar foco; tira de camas: deslizarla o el lápiz no cambian de paciente, conserva su desplazamiento entre repintados y se centra al cambiar de cama (S0–S8); con ✏️ Editar abierto o escribiendo en una caja el dedo no hojea pacientes (S9); ventana de calma de repintados entre caja y caja, scroll y secciones abiertas conservados (I5–I9) |
| `app_import.js` | importación: PATCH de movidos, papelera antes de borrar, fantasmas |
| `app_winlab.js` | mapeo WinLab → labHistory (BH/EGO/cultivos), sync idempotente, Realtime |
| `app_misc.js` | No olvidar y procedimientos sin red |
| `app_ui.js` | togglePtReminder, upsert parcial de checklist, atajos Ctrl/Cmd, ficha compacta (saltos, secciones plegables), drenajes personalizables, cirugías con fechas + Entrega/Recibo de guardia |
| `app_ind.js` | Indicaciones automáticas desde el Google Doc (`indicaciones_doc`): parseo, cruce cama+nombre, aviso por nombre distinto, Realtime, 🔄 |
| `app_nota.js` | Cultivos WinLab (formatos reales: POSITIVO/NO DESARROLLO/NEGATIVO A n DÍAS), novedades automáticas con fecha en la entrega de guardia (labs alterados, RIS, cultivos; idempotente), nota de evolución completa, paciente que reaparece (nota restaurada antes de mostrar la tarjeta + labs WinLab sin ventana), vista de cultivos acotada |

`run_all.sh` levanta servidores HTTP locales (tres puertos libres, ver Puertos) sobre el directorio
indicado, deja el log de cada suite en `$TMPDIR/suite_<nombre>.log` y apaga los servidores al
terminar o si se interrumpe.
