# Piso Libro — Manual de operación (explicado fácil)

Este documento explica, paso a paso y sin tecnicismos, cómo está armada la app
y qué hacer cuando algo falla. Si solo tienes 1 minuto: lee "¿Qué hace cada
pieza?" y "Si los laboratorios no llegan".

## ¿Qué hace cada pieza?

Imagina una fábrica con cuatro máquinas que trabajan solas:

1. **La app** (lo que abres en el navegador): https://pisolibro.pages.dev
   Cada vez que alguien fusiona un cambio en la rama `main` de GitHub, la app
   se vuelve a publicar sola en menos de un minuto.
2. **La hoja del censo** (Google Sheets). Un pequeño programa (Apps Script)
   la lee cada 5 minutos y copia los pacientes a la base de datos. Si cambias
   una cama en la hoja, en 5 minutos la app lo refleja, con su nota intacta.
3. **El robot de laboratorios** (GitHub Actions, carpeta `rpa/`). Tres veces al
   día entra a WinLab, busca a cada paciente del censo, descarga sus
   laboratorios y los guarda en la base de datos. Horarios (hora de León):
   05:00, 12:30 y 20:07. Quien lo despierta a la hora exacta es la base de
   datos (Supabase, tarea programada `winlab-scrape-*`), porque el reloj de
   GitHub llega con 3 a 9 horas de retraso; el de GitHub queda como respaldo.
   Para ver si despertó: tabla `winlab_dispatch_log` en Supabase (una fila por
   intento, con la respuesta del worker). Detalle en
   `scripts/supabase_pg_cron_dispatch.sql`.
4. **La base de datos** (Supabase). Guarda pacientes, notas, laboratorios y la
   papelera. Solo se puede entrar con usuario y contraseña de la app.

## Una sola dirección para todos

Todo el equipo debe usar **https://pisolibro.pages.dev**. Es la única
dirección que publica el repositorio (cada fusión en `main` la actualiza
después de pasar las pruebas). Las otras direcciones que existieron **no deben
usarse**:

- **https://pisocirugiahgl.netlify.app** hoy sirve una versión vieja (de días
  atrás, sin las librerías para trabajar sin red) y el ayudante de IA rechaza
  lo que llega desde ahí; escribe en los mismos pacientes con reglas viejas.
  Alinearla con la principal queda **pendiente en otro lote**; hasta entonces
  no es respaldo de nada. Cuando se alinee, se anotará aquí y en "Abrir la app
  desde el celular".
- **GitHub Pages** (gerardofdz1540.github.io) sirve versiones antiguas que
  borran datos de los laboratorios.

Si alguien tiene la app "instalada" en el teléfono o el iPad desde otra
dirección, que la borre y la vuelva a instalar desde la principal.

## Paso a paso: actualizar el programa de la hoja (Apps Script)

Hay que hacerlo **cada vez** que cambie el archivo `apps-script/censo-sync.gs`
en GitHub (el aviso lo da el PR). Son 2 minutos:

1. Abre en GitHub el archivo
   `https://github.com/Gerardofdz1540/piso-libro/blob/main/apps-script/censo-sync.gs`.
2. Pulsa el botón **Raw** (arriba a la derecha del archivo). Se abre texto
   plano. Selecciona todo (`Ctrl+A`) y copia (`Ctrl+C`).
3. Abre https://script.google.com (con tu cuenta) y entra al proyecto del censo: es el que se llama
   **«Proyecto sin título»** (el censo de Drive es un `.xlsx`, así que el programa no cuelga del menú
   Extensiones de la hoja; es un proyecto aparte). El otro proyecto, «Registro de pacientes», es el
   registro de investigación y se actualiza igual con `apps-script/registro-pacientes.gs`.
4. Se abre el editor.
5. En la lista de la izquierda pulsa `Código.gs`. En el cuadro grande
   selecciona todo (`Ctrl+A`), borra, y pega (`Ctrl+V`) lo que copiaste.
6. Pulsa el icono de **guardar** (disquete) o `Ctrl+S`.
7. Arriba, en el selector de función (dice `doSync` o similar), elige
   **`createTriggers`** y pulsa **▶ Ejecutar**. Si Google pide permisos:
   **Revisar permisos → tu cuenta → Permitir**.
8. Para comprobar: elige **`checkLabsFreshness`**, pulsa **▶ Ejecutar** y
   abre **Ver → Registros**. Debe decir la hora del último laboratorio
   descargado.

Listo. A partir de ahora, si el robot de laboratorios se detiene más de un
día, recibes un correo con las instrucciones para reactivarlo.

## Paso a paso: borrar ramas viejas en GitHub

Las ramas son "copias de trabajo" que ya se fusionaron y solo estorban.

1. Entra a https://github.com/Gerardofdz1540/piso-libro/branches
2. En cada rama de la lista de abajo, pulsa el icono de **bote de basura**
   que está a la derecha:
   - `claude/unify-trunk`
   - `claude/app-p0-quickwins`
   - `claude/scraper-p0-incremental`
   - `claude/apps-script-archive-move`
   - `claude/app-winlab-labs`
   - `claude/scraper-age-guard`
   - `feature/winlab-auto-sync` (solo después del paso de Cloudflare de abajo)
3. No borres `main`.

## Cloudflare Pages: `main` es la rama de producción (hecho el 14-oct-2026)

Cloudflare publica como **producción** solo los deploys cuya etiqueta de rama
coincide con la "Production branch" del proyecto. Desde el 14 de octubre de 2026
esa rama es `main` en ambos lados:

- En Cloudflare: **Workers & Pages → pisolibro → Settings → Builds & deployments
  → Production branch = `main`**.
- En el repo: `.github/workflows/deploy-pages.yml` publica con `--branch=main`.

Si alguna vez cambias la Production branch en Cloudflare, cambia también esa
línea del workflow: si no coinciden, cada push a `main` se publica como
*preview* y la app en producción se queda congelada sin ningún aviso. La rama
vieja `feature/winlab-auto-sync` ya no hace falta para publicar; puedes borrarla
cuando quieras.

## Regresar a la versión anterior (si una publicación sale mal)

Desde octubre de 2026 **cada publicación corre las pruebas antes** (`ci.yml`,
llamado desde `deploy-pages.yml`): si alguna falla, no se publica y los iPads
siguen con la versión anterior. Aun así, si una versión publicada falla en el
piso, cualquiera con acceso a Cloudflare la regresa en un minuto:

1. Cloudflare → **Workers & Pages → pisolibro → Deployments**.
2. En la lista, busca la publicación anterior que sí funcionaba (por fecha y
   hora; la de arriba es la actual). Pulsa los tres puntos **⋯** de esa fila →
   **Rollback to this deployment** → confirmar.
3. En los iPads basta con cerrar la app del todo y volver a abrirla con red:
   toma la versión publicada.
4. **Después**, para que el cambio malo no se vuelva a publicar en la siguiente
   fusión: en GitHub, abre el PR que lo trajo → botón **Revert** → crea el PR
   de reversión y fusiónalo en `main` (o `git revert <commit>` desde la
   computadora y PR). Eso publica otra vez la versión buena, con pruebas. Sin
   este paso, el rollback solo dura hasta la próxima publicación.
5. Avisa en el grupo qué versión quedó y mándame el síntoma (sin pacientes).

## 🔄 Aviso de versión nueva (20 de octubre de 2026)

Había equipos trabajando con versiones viejas de la app sin saberlo (un iPad o una PC que se quedan abiertos días no
se recargan nunca). Ahora cada equipo revisa si hay otra versión publicada: a los 15 segundos de abrir, cada 3 minutos
mientras la app está a la vista y al volver a la app (como mucho una revisión por minuto). Si la hay, abajo a la
izquierda sale una barra pequeña: **«🔄 Hay una versión nueva de la app · Actualizar»** (en la Mac, laptop o pantalla
ancha sale abajo a la derecha, para no tapar la lista de camas de la izquierda).

**Qué hacer ante el aviso:**

- **Toca «Actualizar»** cuando termines lo que estás escribiendo. La app sube primero lo pendiente (espera hasta unos
  8 segundos) y se recarga con la versión nueva. Si algo no alcanzó a subirse lo avisa: se quedó guardado en el
  equipo y se sube solo al abrir la app con red. Si la versión nueva cambia también el service worker, espera unos
  segundos más a que se instale antes de recargar (así el iPad no se queda a medias). Si a los ~15 segundos no se
  recargó, la barra vuelve a «Hay una versión nueva»: tócala otra vez o cierra y abre la app.
- La app **nunca se recarga sola**. La **✕** esconde la barra hasta la siguiente revisión (3 minutos como máximo).
- Mientras escribes la barra se esconde (para no tapar el teclado del iPad) y regresa al soltar la caja.
- La barra queda **debajo** de las ventanas de la app (✏️ Editar, Pase de visita, cirugías…): no tapa sus botones.
  Si tienes una ventana abierta, «Actualizar» no recarga y te pide guardarla o cerrarla primero.
- Sin red no sale nada (no hay con qué comparar).
- También sale tras un regreso a la versión anterior (rollback): tocar «Actualizar» deja el equipo en la que quedó
  publicada.

**Una sola vez, a mano:** los equipos que siguen con una versión anterior a este aviso no lo tienen. **Ciérralos del
todo y ábrelos una vez con red** (en el iPad, deslizar la app hacia arriba para cerrarla; en la PC, cerrar la pestaña o
el navegador) — desde ahí avisan solos. Si sospechas que un equipo trae una versión vieja y la barra no aparece, haz lo
mismo. En una PC con Chrome que usa `gerardofdz1540.github.io`: GitHub Pages deja la página guardada 10 minutos en el
navegador, así que si la abriste hace menos de 10 minutos, cerrar y abrir puede seguir mostrando la versión anterior;
**recarga con F5 (o Ctrl+R)** con la app abierta, o espera 10 minutos. En el iPad y en `pisolibro.pages.dev` no pasa.

**Cómo funciona y qué hacer en cada cambio de `index.html`:** la app se publica tal cual, sin paso de construcción
(GitHub Pages sirve la raíz de `main`; Cloudflare Pages con `deploy-pages.yml` y el espejo de Netlify con
`netlify.toml` copian los archivos), así que la versión va escrita a mano en dos lugares que deben ser iguales:

1. En `index.html`: `const PL_BUILD = "2026.10.20-1";`
2. En `version.json` (raíz del repositorio): `{"v":"2026.10.20-1"}`

En **cada** PR que cambie `index.html`, sube las dos con un valor nuevo: la fecha y un consecutivo del día
(`2026.10.20-1` → `2026.10.20-2` → `2026.10.21-1`). Las pruebas lo vigilan: `tests/headless/version_check.js` falla si
los dos valores no son iguales, y en el PR el paso «version.json acompaña a index.html» de `ci.yml` falla si
`index.html` cambió y `version.json` no (o trae el mismo valor). Si se olvidara, los equipos con la versión anterior
no verían el aviso; si los dos valores no coincidieran, todos lo verían siempre. El service worker (`sw.js`, versión
`pisolibro-v12`) nunca guarda `version.json`: siempre lo pide a la red; y al instalarse baja la app del servidor sin
usar la copia que el navegador tenga guardada.

**Dos PR abiertos a la vez que cambian `index.html`:** los dos suben la versión al mismo valor siguiente (p. ej.
`-1` → `-2`), el paso pasa en cada PR y GitHub los fusiona sin conflicto; `main` queda con los cambios del segundo y la
`"v"` del primero, y los equipos que ya tenían la del primero nunca verían el aviso del segundo. Para que no pase:
en GitHub → Settings → Branches → `main`, activa **«Require branches to be up to date before merging»** (obliga a
traer `main` al PR y vuelve a correr el paso, que entonces falla hasta que subas la versión otra vez). Si aun así se
cuela, la publicación lo detecta: en cada push a `main` el mismo paso compara con el commit anterior de `main`, falla y
**Cloudflare no se publica** (GitHub Pages y Netlify sí); sube la versión otra vez (las dos) en un PR nuevo y se publica.

## Cómo moverse por la ficha del paciente (iPad)

- La barra oscura de arriba de la ficha queda pegada al desplazar. Tiene las
  flechas ← → para cambiar de paciente, el botón **Pase / Completo** y una fila
  de saltos: **Dx · Labs · Manejo · Plan · Pase · Entrega · Historia · IC·Cult ·
  Sug. · Indic. · Estudios · Diagrama · No olvidar**. Un toque lleva a ese bloque
  (y lo abre si estaba plegado). Los numeritos indican pendientes abiertos,
  sugerencias críticas, estudios y recordatorios; en Labs sale "hoy" o los días
  sin laboratorios.
- Al bajar por la ficha, el lema y la barra de botones de arriba se esconden
  para ganar pantalla; vuelven al subir al principio.
- Los bloques secundarios (Historia APP/Qx/PA, MIPs/R1, Interconsultas·Cultivos,
  Sugerencias, Indicaciones, Estudios, No olvidar) son chips plegables. Lo que
  abras o cierres se recuerda por separado en modo Pase y en modo Completo.
- En iPad horizontal la ficha va en dos columnas (clínica a la izquierda,
  exploración y checklist a la derecha). Las tablas de labs se parten en dos
  mitades lado a lado; las fechas anteriores siguen en 📈 Gráficas.
- Dieta, Ayuno, ATB y TVP se cambian con un toque en la primera fila del
  checklist (antes solo desde el modal de editar).

## 🔎 Filtrar las camas (28 de octubre de 2026)

En la pestaña **🏥 Piso Libro** (una cama a la vez) la barra de búsqueda de arriba no se ve. El botón **🔎 Filtrar camas**
(borde amarillo, en la barra oscura de la ficha, junto a 📊 Planes) abre una fila con:

- **Cama o nombre** (28 oct 2026): escribe «3-15» (camas 3-150 a 3-159), «UCI», un apellido o un expediente; la lista se
  ajusta al dejar de escribir y el cursor se queda en el campo. «✕» la quita.
- **Residente** (además de adscrito).
- **Especialidad** (CG, CCR, URO…), **Adscrito** y **Servicio**: el servicio es la sala del censo donde está el
  paciente (Piso, UCIA, Pediatría, Medicina Interna, Oncología/Ginecología…). Cada opción dice cuántos pacientes
  tiene. Un paciente agregado a mano, sin sala del censo, toma el servicio de su cama (UCI → UCIA, 3-xxx → Piso).
- **🆕 Ingresos**: los que ingresaron hoy o ayer.
- **🛏 Libres**: en lugar de las fichas muestra las camas libres agrupadas por servicio, cada una con
  «+ Agregar paciente» (abre el alta con la cama puesta; al guardar, el tablero regresa a las fichas y abre al
  paciente nuevo). Respeta el filtro de servicio (p. ej. solo las camas libres de UCIA). «✕ Ver pacientes» regresa.
  La lista de camas se cambia en «⚙️ Configurar camas».
- **✕ Quitar filtros** deja todo como estaba. El botón dice cuántos filtros hay puestos para que no
  se olviden («🔎 Filtrar camas · 2»; se pone ámbar): con filtros, las flechas ← → y el carril de camas recorren solo los
  pacientes filtrados.

Los filtros son de cada dispositivo, no cambian datos y también aplican al Censo y a la impresión (son los mismos que
el Censo ya tenía para residente y adscrito). Si con los filtros no queda nadie, la pantalla lo dice y los filtros
siguen a la mano. Si «🩺 Solo míos» está prendido aparece en la fila para poder apagarlo.

Si no ves «🔎 Filtrar camas», ese dispositivo tiene una versión vieja de la app: toca «Actualizar» en el aviso de versión
nueva o recarga la página (el administrador lo ve en 👥 Usuarios → 📱 Versiones).

## ✏️ Corregir un laboratorio mal transcrito (28 de octubre de 2026)

En la tabla de labs de la ficha, **✏️ Corregir** abre todos los analitos de una fecha (botones de fecha arriba;
«＋» para otra fecha). Se cambia solo lo que está mal y **💾 Guardar correcciones**:

- El valor corregido se queda: el siguiente sync del robot de WinLab ya no lo cambia (tampoco regresa un valor que se
  borró a propósito dejando la casilla vacía). Lo demás de esa fecha sí se sigue actualizando.
- En la tabla, el valor corregido lleva **✎**; al tocarlo dice quién lo corrigió y qué decía antes.
- Si el número está fuera de lo posible (K 44.3, Na 1330…) pregunta por el punto decimal antes de guardar.
- **↩ Regresar** de la tarjeta deshace la corrección.
- Sin labs (el robot no encontró al paciente) el botón dice **✏️ Capturar** y sirve para escribirlos a mano.

## 💧 Índice urinario (28 de octubre de 2026)

En el **Pase Matutino**, junto a **Uresis**, la casilla **Horas** y el **Índice urinario** calculado como en el
servicio: uresis total (mL) ÷ peso (kg) ÷ horas = mL/kg/h. Horas vacías = 24 h (o las que diga la uresis, p. ej.
«900/12 h»); la uresis puede ir en litros («1.5 L») o con comas («1,200»). El peso es el de la fila Clínico (el mismo
del vasopresor); sin peso dice «⚖️ falta el peso». Colores KDIGO: verde ≥ 0.5, ámbar < 0.5 (oliguria), rojo < 0.3.
El índice sale en la nota de evolución y en el resumen de gastos; **no se escribe en ninguna caja**. Las horas pasan
al historial del pase con la uresis de ese día.

## 💡 Sugerencias clínicas: solo lo que cambia el manejo (28 de octubre de 2026)

Antes la caja proponía «Agregar al dx: Leucocitosis severa» o «PCR elevada severa»: un hallazgo de laboratorio no es
un diagnóstico, y se quitó. La caja ya no toca el DX. Ahora cruza los labs con las **indicaciones del Doc**, la tarjeta
(ATB, TVP, NPT, ayuno, peso, edad, sexo, vitales, uresis) y los **cultivos de WinLab**, y solo sugiere ajustes de
manejo:

| Tipo | Qué revisa |
|---|---|
| 🦠 Antibiograma | El antibiótico en uso contra el antibiograma: **RESISTENTE** o intermedio (urgente si es hemocultivo o muestra estéril), no probado, resistencia natural que el antibiograma no muestra (Enterococcus con cefalosporinas, Pseudomonas con ceftriaxona, BLEE, SAMR, carbapenemasa), S. aureus sensible con vancomicina, BLEE con piperacilina/tazobactam (MERINO), desescalar cuando hay opciones de menor espectro, cultivo positivo sin tratamiento, Candida en orina (colonización) y posible contaminante en un hemocultivo. Siempre dice a qué es sensible. |
| 🩸 Transfusión | Hb contra el umbral que le toca (7 g/dL la mayoría; 8 con cardiopatía o cirugía ortopédica/cardiaca; síndrome coronario agudo hasta 10 — AABB 2023, MINT 2023), edad, sangrado activo o choque (decisión clínica), cruce vigente y CE estimados con el peso. Caída de Hb ≥ 2 g/dL en ≤ 3 días (buscar sangrado, anticoagulante en uso). Plaquetas < 10 k, < 50 k con heparina o sangrado, caída ≥ 50 % con heparina (TIH, escala 4T), linezolid. |
| ⚡ Electrolitos | Hipo/hiperkalemia (vía y velocidad, Mg primero, fármacos que lo bajan o suben, KCl en soluciones), hipo/hipernatremia (límite de corrección, Na corregido por glucosa, soluciones hipotónicas, déficit de agua libre con el peso), Mg, Ca corregido por albúmina, fósforo y síndrome de realimentación con NPT, acidosis con brecha aniónica (SS 0.9 % → Hartmann), lactato. |
| 💉 Insulina | En diabéticos: hipoglucemia (y sulfonilurea), glucosa < 100 con basal, glucosas > 180 sin insulina, solo con esquema de corrección o con basal insuficiente (subir 10-20 %), ayuno con prandial, esteroide, NPT; dosis inicial en U/kg (ADA 2025) con el peso. Metformina con función renal baja o lactato alto; iSGLT2 en ayuno o cirugía. Usa la glucosa del laboratorio y el Dxtx del pase (de hoy y ayer). |
| 💊 Interacciones | AINE + anticoagulante (con enoxaparina profiláctica, sin plaquetas bajas ni sangrado, queda como «baja»: es frecuente en el POP), anticoagulante + antiagregante, serotoninérgicos (tramadol, linezolid + ISRS), carbapenémico + ácido valproico, warfarina/acenocumarol + fármacos que suben el INR, clopidogrel + omeprazol, vancomicina + piperacilina/tazobactam, dos nefrotóxicos, opioide + benzodiacepina, nalbufina/buprenorfina + otro opioide, varios fármacos que prolongan el QT (más grave con K o Mg bajos). |
| ♻️ Duplicados | Dos IBP, IBP + anti-H2, dos AINE, dos anticoagulantes, dos betalactámicos, doble cobertura anaerobia (metronidazol con pip/tazo o carbapenémico), dos quinolonas o aminoglucósidos, el mismo fármaco dos veces (paracetamol: máx. 4 g/día). |
| 🫘 Riñón | Lesión renal aguda KDIGO (creatinina de la última semana contra la basal) nombrando los nefrotóxicos en uso; oliguria por índice urinario; ClCr (Cockcroft-Gault con edad, peso y sexo; sin peso, CKD-EPI) < 50 con fármacos que requieren ajuste. Con ERC o diálisis no sugiere LRA. |
| Otras | PCR ≥ 150 en el POP día 3-5 (buscar fuga o colección), PCT baja con antibiótico (valorar suspender), ayuno ≥ 5 días sin nutrición, indicaciones sin profilaxis de TVP. |

- Cada sugerencia dice **«Por qué»**: los datos y de dónde salieron (p. ej. «indicaciones del 28 oct», «ATB de la
  tarjeta», el cultivo y su fecha). Si las indicaciones del Doc no coinciden con certeza con el paciente, no se usan.
- Los labs que se usan son de hoy o ayer (los cultivos, de los últimos 14 días): no se sugiere sobre un potasio de hace
  una semana. Un renglón de indicaciones con «SUSPENDER» o «SUSP.» no cuenta como fármaco en uso.
- **➕ A pendientes** agrega un renglón «• …» al final de ⚠️ Pendientes / Plan, solo si la persona lo toca (no lo
  repite y ↩ Regresar lo quita). **🔇 Ignorar** la oculta hasta que cambien los datos.
- Son para **considerar**: la app no conoce alergias, peso real ni todo el contexto. Las cifras son de guías citadas
  (umbrales de Hb, límites de corrección, U/kg de la ADA, déficit de agua); no escribe dosis de fármacos.
- Se ven 6 (las urgentes primero); «Ver las N» muestra el resto.

## Indicaciones del Google Doc en cada tarjeta

Las indicaciones se escriben donde siempre, en el Doc "INDICACIONES HOSPITALIZACION". La base de
datos (Supabase) descarga el Doc cada 5 minutos por su enlace de "compartir" y, si cambió, lo
guarda; la app lo recibe al instante y cada tarjeta muestra su bloque en **Indicaciones** (Dieta,
Soluciones, Medicamentos, Antibióticos, Medidas generales). No hay que hacer nada: solo mantener
el Doc compartido como "cualquiera con el enlace puede ver". Si algún día se restringe, el
programa de la hoja (Apps Script, `syncIndicaciones`) hace el mismo trabajo con tu cuenta de Google.

- El cruce es por **cama + nombre**. Si un paciente cambió de cama, lo encuentra por nombre. Si en
  el Doc hay varias fechas del mismo paciente, muestra la más reciente.
- **Pestañas del Doc** (24 oct 2026): el Doc tiene varias pestañas. La descarga de la base trae
  todas. El respaldo de Apps Script antes leía solo la primera y, al subirla, tapaba el texto
  completo: en la app quedaban tres bloques para todo el piso. Ya lee todas las pestañas y sus
  subpestañas. Si algún día vuelve a faltar una cama que en el Doc sí está, ejecuta
  `testIndicacionesOnly` en Apps Script: dice cuántas letras, bloques y camas ve.
- Si en el Doc la cama tiene indicaciones a nombre de **otra persona** (el paciente anterior),
  la tarjeta avisa en rojo y no las muestra como propias hasta que toques "Ver de todos modos".
- En la cabecera del bloque: 📄 abre el Doc; 🔄 lo trae ahora mismo sin esperar los 5 minutos.
  "Doc editado hace X" dice cuándo se modificó el Doc por última vez.
- Opcional (respaldo): pegar el `censo-sync.gs` nuevo en Apps Script y ejecutar `createTriggers`
  hace que también tu cuenta de Google suba el Doc; solo hace falta si el enlace deja de ser
  público.

## Drenajes, sondas y estomas por paciente

En el checklist de la tarjeta, la fila **Drenajes y sondas** es una lista libre: botones rápidos
(+ SNG, + Saratoga D, + Saratoga I, + SEP, + CMP, + Estoma, + Fístula mucosa) y un selector
"+ más…" con el catálogo (Penrose, JP, Blake, Hemovac, Drenovac, Foley, cistostomía, CVC, catéter
de HD, ileostomía, colostomía, yeyunostomía, gastrostomía, TPN, Otro = nombre libre). Cada
dispositivo tiene su renglón: tocar el nombre cambia el lado (D / I / sin lado), y lleva sitio,
gasto en mL/24 h, características (seroso, fecal, fuga…), día de colocación (📅) y ✕ para
retirarlo. Lo que registres aparece resumido en la línea de pase de la cabecera y en la hoja de
entrega. Los chips antiguos (SNG, PRS 1-3, Estoma, SEP) se convirtieron solos a esta lista.

## Estudios de imagen (tomografías, ultrasonidos, rayos X) en cada tarjeta

Un robot (`.github/workflows/ris-scraper.yml`) entra cada 2 horas al visor radiológico
(consultas-pisos), lee el censo completo (también NCX, URO, CT y los pacientes que no son
nuestros), pide los estudios en ventanas de 14 días desde hoy hasta el ingreso más antiguo del
censo (hasta 5 ventanas = 70 días) y cruza cada uno por nombre (y edad) con el censo; si dos
pacientes del censo se parecen, decide la edad, y el alias «✏️ Nombre en WinLab» también sirve
para identificarlo. En la tarjeta, dentro de **Estudios de imagen**, aparece el bloque "Estudios
del visor (RIS)": fecha y hora, modalidad (CT, US, RX…), nombre del estudio, sede, marca de caso
crítico, enlace 🖼 al visor y, cuando ya existe el reporte, el **reporte transcrito** (plegable).
Si el RIS aún no lo transcribió dice "Sin reporte todavía · estudio realizado"; si el reporte ya
está en el visor pero el robot no pudo bajarlo (sesión caducada, presupuesto de la corrida) dice
"Reporte disponible en el visor · el robot lo descarga en la siguiente pasada" y lo reintenta
cada 2 horas: nunca se da por perdido. Al llegar un estudio o reporte nuevo, la tarjeta se
actualiza al instante con un aviso. Las credenciales del visor viven en la tabla `rpa_config` de
Supabase (no en el código); si cambian, se actualizan ahí. Para lanzarlo a mano: Actions → "RIS
Imagen" → Run workflow.

- **Fechas y orden** (26 oct 2026): el visor da la fecha como DD/MM/AAAA y la app la comparaba
  como texto: el orden se revolvía entre meses, la Entrega y el Proyector dejaban fuera los estudios
  del día 1 al 20 y las líneas automáticas salían con la fecha de hoy. Ahora la app la convierte al
  recibirla: el estudio más reciente va arriba y cada línea lleva la fecha del estudio.
- Si el robot corrige el expediente de un estudio o el visor lo borra, la tarjeta se ajusta sola
  (antes quedaba una copia en el paciente anterior hasta recargar). Las pasadas del robot sin
  cambios ya no repintan ni avisan.
- Solo se abren enlaces `http`/`https`; cualquier otro (p. ej. `javascript:`) se muestra como
  texto, en el bloque del visor y en la caja Imagen manual.

## Alertas y laboratorios en el tablero

La hoja de labs críticos, labs nuevos y "sin laboratorios de hoy" ya no ocupa la parte de arriba:
está en el botón **🔔** de la barra del paciente (muestra los contadores: rojo = críticos,
🧪 = labs nuevos, 📭 = sin labs de hoy). Se abre como panel lateral; tocar un renglón cierra el
panel y abre la tarjeta de ese paciente, resaltada. En el carril de camas, un punto rojo marca
labs críticos sin reconocer y uno ámbar labs atrasados.

## A quién se le asigna cada laboratorio (26 oct 2026)

- **Expediente repetido** (p. ej. 3-159 y 3-160): el robot guarda una fila por expediente y fecha,
  así que junta a los dos pacientes en la misma fila. La app ahora separa cada reporte por el
  encabezado de su paciente: cada cama recibe solo lo suyo. Antes la segunda cama nunca recibía
  labs y, con WinLab en italiano, la primera recibía también los de la otra. Si la fila no trae
  encabezados no se asigna a ninguna de las dos.
- WinLab en **italiano** (NOME/COGNOME): los encabezados ya se reconocen; antes se tiraban labs de
  NCX/URO pedidos por Cirugía General.
- El encabezado de WinLab se coteja con el nombre del censo **y** con el «✏️ Nombre en WinLab»
  (apellido de casada, etc.). Los reportes que el robot descartó (homónimo, edad que no cuadra) no
  entran nunca, y otra persona con los mismos apellidos tampoco aunque el robot la marque.
- **FCO./FCA.** del censo = FRANCISCO/FRANCISCA; ANTONIO y ANTONIA son personas distintas.
- Al tocar otra fecha de labs, la flecha de tendencia, las sugerencias y el INR estimado son los
  de esa fecha (antes se quedaban los de la fecha anterior).

## Si los laboratorios no llegan

1. Abre https://github.com/Gerardofdz1540/piso-libro/actions/workflows/winlab-scraper.yml
2. Mira la lista de corridas. Cada día debe haber tres (05:00, 12:30 y 20:07
   hora de León). Un círculo verde es éxito; rojo es error.
3. Si arriba aparece un aviso amarillo que dice **"This scheduled workflow is
   disabled"**: pulsa **Enable workflow**. (GitHub apaga el robot si el
   repositorio pasa 60 días sin cambios; el robot ya se "mantiene despierto"
   solo, pero por si acaso.)
4. Para lanzarlo a mano: botón **Run workflow** (a la derecha) → **Run
   workflow**. Tarda 30–60 minutos. En la app, el botón "Labs" también lo
   dispara con clic derecho.
5. Si la corrida está en rojo, abre la corrida, pulsa el paso rojo y copia las
   últimas líneas del registro; mándamelas y lo reviso. Nunca pegues ahí
   nombres de pacientes en mensajes públicos.

## Si el robot no puede entrar (plan B)

Los dos robots (labs e imagen) corren en computadoras de GitHub fuera del hospital y entran a
WinLab y al visor por internet. Si Informática cierra ese acceso, cambia la dirección o bloquea
esas conexiones, las corridas fallan al iniciar sesión (en Actions, el paso rojo dice que no pudo
entrar) y nada automático llega. Qué hacer:

**Ese mismo día**

1. **Avisar** en el grupo del servicio que los labs y los estudios no llegarán solos, y al
   responsable de la app (mándale el nombre de la corrida en rojo, sin pacientes).
2. **Descartar que sea la contraseña**: lista "Login fallido" en "Cuentas que usan los robots". Si
   la cuenta entra a mano desde una PC del hospital pero el robot no, es bloqueo de red: sigue.
3. **Labs de todo el piso con el marcador manual**, desde una PC del hospital con WinLab:
   - En la app (con tu sesión, en esa PC): ⚙️ Config → botón del marcador de WinLab → arrastra el
     botón a la barra de marcadores del navegador. El marcador ya lleva dentro el censo de ese
     momento: no pide llaves ni consulta nada.
   - En WinLab: Reportes → "Ir" (reportes de hoy) → clic en el marcador: palomea solo a los
     pacientes del censo, página por página → **Imprime Reportes** → se baja un PDF.
   - En la app: **📦 Labs Masivo** (barra del tablero) → suelta el PDF → revisa a quién se asignó
     cada hoja y confirma.
   - El reparto es por **nombre, contra todo el censo** (24 oct 2026: antes solo miraba Cirugía
     General y sus subespecialidades, así que los pacientes de Neurocirugía y demás nunca se
     identificaban). Los nombres se comparan igual en los dos lados: «MA.» es MARIA, «FCO.» es
     FRANCISCO, y «DE»/«LA» no cuentan. Para asignar siguen haciendo falta **todos** los nombres
     del lado más corto, así que una hoja de alguien que no está en el censo queda **sin asignar**
     en vez de caer en la tarjeta equivocada.
   - Al terminar, **borra el marcador** de esa PC: contiene los nombres de los pacientes. Al día
     siguiente se genera otro (el censo cambia).
4. **Un paciente suelto**: en su tarjeta, sección de labs, 📄 PDF / 📷 Foto lee la hoja impresa o
   la pantalla con IA, como siempre.
5. **Imagen**: los estudios y reportes se consultan directo en el visor; cuando el robot vuelva,
   repone lo que falte en las siguientes pasadas.

**Para dejar de depender de internet: un "runner" propio en una PC del servicio**

Un runner es una computadora que GitHub usa para correr los robots en vez de las suyas. Si está
dentro del hospital, entra a WinLab y al visor como cualquier PC del piso. Preparación (la hace el
responsable; una tarde):

1. Hablar con Informática: avisar que el robot correrá desde una PC del servicio y preguntar si lo
   prefieren así.
2. Una PC del servicio **siempre encendida y con cable de red**, con usuario propio y código de
   bloqueo, que nadie use para otra cosa. Mejor Linux (Ubuntu): los workflows usan comandos de
   Linux.
3. En GitHub: repo → **Settings → Actions → Runners → New self-hosted runner** → elegir el sistema
   de la PC → seguir los pasos que GitHub muestra en pantalla (descargar, configurar con el código
   que aparece ahí, instalar como servicio para que arranque sola). Ponerle la etiqueta `hospital`.
4. En esa PC instalar Node 22 y el navegador del robot (`npx playwright install --with-deps
   chromium` dentro de `rpa/`).
5. En el repo, cambiar en `winlab-scraper.yml`, `winlab-dryrun.yml` y `ris-scraper.yml` la línea
   `runs-on: ubuntu-latest` por `runs-on: [self-hosted, hospital]` (PR normal; pasa por pruebas).
6. Probar con Actions → **"WinLab corrida en seco" → Run workflow**: debe entrar y recorrer WinLab
   sin escribir nada.

Las contraseñas siguen guardadas en GitHub y en Supabase, no en la PC. Las capturas de pantalla de
corridas fallidas sí se quedan en la carpeta del runner: borrarlas cada semana. Mientras no exista
el runner, GitHub sigue usando sus computadoras.

## Cuentas que usan los robots

Cada robot entra al sistema del hospital con la cuenta de **una persona**, no con una cuenta del
servicio. Para WinLab y el visor, cada búsqueda del robot la hizo esa persona (también las de
homónimos de otros servicios). Por eso hay que saber de quién es, que Informática lo sepa y qué
hacer cuando cambie la contraseña.

| Robot | Sistema | Cuenta de (llenar) | Contraseña vence (llenar) | Dónde vive la contraseña | Dónde se cambia |
|---|---|---|---|---|---|
| Labs | WinLab | ____________ | ____________ | GitHub → Settings → Secrets and variables → Actions → `WINLAB_USER` / `WINLAB_PASS` | Ahí mismo: `WINLAB_PASS` → Update secret |
| Imagen | Visor radiológico (RIS) | ____________ | ____________ | Supabase → Table Editor → tabla `rpa_config` → filas `RIS_USER` / `RIS_PASS` | Ahí mismo: `value` de `RIS_PASS` → Save |

- Pedir por escrito a Informática una cuenta de **solo consulta** a nombre del Servicio de Cirugía
  General para el robot. Mientras no exista, que el dueño de la cuenta y la jefatura dejen por
  escrito que se usa así, y revisarlo en cada cambio de rotación.
- Si el dueño de la cuenta rota, egresa o el hospital le pide cambiar la contraseña: **el mismo
  día** cambiarla en GitHub (`WINLAB_PASS`) o en `rpa_config` (`RIS_PASS`) y lanzar la corrida de
  prueba (paso 4 de abajo). Si no, los robots se detienen y los labs dejan de llegar hasta que
  alguien se dé cuenta.

**Lista "Login fallido"** (la corrida en rojo dice que no pudo iniciar sesión):

1. Entra a mano en una PC del hospital con el mismo usuario y contraseña. ¿No entra? La contraseña
   cambió, venció o la cuenta está bloqueada: arréglalo en WinLab o en el visor, actualiza el
   secreto o `rpa_config` y lanza la prueba del paso 4.
2. ¿Entra a mano pero el robot no? WinLab o el visor cambiaron algo (idioma, pantalla, aviso al
   entrar) o la red del hospital cerró el acceso desde fuera. Mándale al responsable el nombre de
   la corrida y el paso rojo (sin pacientes) y sigue "Si el robot no puede entrar (plan B)".
3. ¿No hay corrida a la hora esperada? Entonces no es la cuenta: revisa "Si los laboratorios no
   llegan" y la tabla `winlab_dispatch_log`.
4. Prueba después de cambiar algo: Actions → **"WinLab corrida en seco" → Run workflow** (entra y
   recorre sin escribir) o **"RIS Imagen" → Run workflow** con `dry_run` marcado. Verde = listo.

## Abrir la app desde el celular, con datos móviles o sin conexión

Desde octubre de 2026 la app ya no depende de internet para abrir:

- Todas las librerías que necesita vienen dentro de la app (carpeta `vendor/`). Antes se bajaban
  de servidores externos (unpkg, cdnjs, jsdelivr) y en redes móviles que los bloquean la página se
  quedaba en blanco o pedía login con el aviso "CDN bloqueado".
- La primera vez que abras la app **con internet** (Wi-Fi del hospital), el navegador guarda una
  copia completa en el dispositivo. A partir de ahí abre siempre, aunque no haya red o la red
  corte la dirección: si el servidor no responde en 4 segundos, se usa la copia guardada.
- La sesión también se guarda: sin red no vuelve a pedir contraseña.
- Para instalarla como app: en iPhone/iPad, Safari → **Compartir → Agregar a inicio**; en
  Android, Chrome → menú ⋮ → **Instalar aplicación**.
- Por ahora **no hay segunda dirección**: la copia de Netlify está atrasada y no debe usarse (ver
  "Una sola dirección para todos"). Si la principal no abre desde tu operador, la copia guardada en
  el dispositivo sigue funcionando sin red y lo escrito se sube al volver al Wi-Fi del hospital.

**Sin conexión** se puede leer y escribir todo. Lo que escribas se guarda en el dispositivo y en
una cola de envío; el estado abajo dice "Sin conexión". En cuanto vuelve una red que llega a
Supabase, la app sube la cola y descarga lo nuevo de los demás. Si cierras la app sin red, al
reabrirla sigue ahí lo que escribiste y se sube cuando haya red. Los laboratorios automáticos,
el Doc de indicaciones y las imágenes solo llegan con red.

Si tu operador bloquea también a Supabase (la app abre, pero el estado se queda en "Sin conexión"
aunque tengas datos), prueba desde el celular abrir
https://vkxplmrzyqlamxpbtmes.supabase.co/auth/v1/health : si no carga, esa red no sirve para
sincronizar y hay que esperar al Wi-Fi del hospital; lo escrito no se pierde.

## Botones ↩ Regresar y ↪ Rehacer

En la cabecera de cada tarjeta aparece **↩ Regresar** cuando hay algo que deshacer. Cada cambio
que puede doler guarda antes una copia de la tarjeta: texto de una caja al terminar de escribir,
quitar una cirugía, un drenaje, unos labs o un estudio, "Recibir guardia", auto-llenar, órdenes
rápidas. Regresar vuelve un paso; tocarlo otra vez vuelve otro paso
más (hasta 20 por paciente) y cada regreso se sube como cualquier edición.

Si el regreso fue el error, aparece **↪ Rehacer**: vuelve a dejar la tarjeta como estaba antes
de regresar. Si en vez de rehacer escribes algo nuevo, lo que habías dejado atrás no se pierde:
queda como un paso más de Regresar ("como estaba antes de regresar…").

Los pasos se guardan en el dispositivo y sobreviven a cerrar la app (también sin red). Un
paciente dado de alta por error se recupera desde la **Papelera** (☁️ Cargar desde nube →
↩ Restaurar).

## Modo Hoja de visita (octubre 2026)

Es la ficha vista como la hoja de GoodNotes: una cuadrícula fija con **todas las cajas abiertas
a la vez**, sin plegables. En la barra de arriba de la ficha, el botón **🗂 Tarjeta / 📑 Hoja**
cambia entre los dos modos y se recuerda en cada dispositivo.

Orden de la hoja: DX · Labs · APP/PA | Cirugías · IC/Cultivos | Imagen | Pendientes · Entrega |
Recibo · Pase matutino (dieta, ATB, vitales, drenajes) · Manejo | MIPs/R1 · Sugerencias |
Indicaciones | Diagrama | No olvidar. En iPad vertical se acomoda en dos columnas; en celular en
una. Son las mismas cajas con los mismos botones: solo cambia dónde se pintan.

- **⚙ Cajas** (aparece en modo Hoja): quita de la hoja lo que no uses (Labs, Manejo, MIPs/R1,
  Imagen, Sugerencias, Indicaciones, Diagrama, No olvidar). Es por dispositivo y no borra nada.
- **🖨 Imprimir hoja** (dentro de ⚙ Cajas) o imprimir desde el navegador: en modo Hoja sale
  **una hoja por cama**, sin barras ni botones.
- **➕ Hoy** en Interconsultas, Cultivos, Entrega y Recibo anota la fecha de hoy (`dd/mm: `) al
  final de la caja, como la fecha que se escribe a mano antes de cada renglón. Pendientes ya lo
  tenía (ahí va al inicio).
- **Pase matutino con fecha**: los vitales llevan el día en que se tomaron. Si son de ayer, el
  chip dice "de 13 Oct" en ámbar. Al escribir el primer dato de hoy, los de ayer pasan al
  historial (renglón gris debajo, últimos 3 días a la vista, 14 guardados) y la fila queda limpia
  para el pase de hoy. Si te arrepientes, ↩ Regresar lo deshace.

## Fotos, trazos a mano y autor por caja (octubre 2026)

Tres cosas que la hoja de GoodNotes hacía y la app no:

- **📷 Fotos en Cirugías y Cultivos**: cada cirugía y la caja de Cultivos tienen un botón 📷
  (cámara o galería, varias a la vez). La foto se reduce (JPEG, máximo 1600 px) y se guarda en
  Supabase Storage (bucket privado `pl-fotos`, se muestra con enlace firmado); en la tarjeta
  queda una miniatura, tocarla la abre en grande, ✕ la quita (con confirmación y ↩ Regresar).
  **Sin red** la foto se guarda en el dispositivo marcada con borde punteado y se sube sola al
  volver la red (o al abrir la app con red). Los PDFs de labs usan el bucket `lab-sources`, que
  también se creó hoy: antes no existía y todo quedaba inline en la nota.
- **✍️ → 📌 A la caja**: el lápiz de cada caja (incluye ahora Interconsultas, Cultivos y Recibo)
  tiene un botón nuevo para dejar el trazo como imagen dentro de la caja, recortado al dibujo.
  Se ve en la hoja, en la impresión y en los demás dispositivos. 🤖 Transcribir sigue igual.
- **Autor por caja**: cada caja de texto muestra un chip con las iniciales de quien hizo el último
  cambio, la fecha y la hora, con un color fijo por persona (el nombre que pusiste al entrar).
  ➕ Hoy anota `dd/mm GF: ` y Recibir guardia sella `— Recibido dd/mm hh:mm GF —`.

## Las cajas de la ficha (octubre 2026)

Cada caja tiene un color propio para ubicarla de un vistazo. Columna principal, de arriba abajo:

- **🔴 DX / Motivo de ingreso** (rojo). Debajo (28 oct 2026, para el registro):
  - **🩺 Dx principal**: un menú con la lista corta del servicio (apendicitis, colecistitis, pancreatitis, oclusión,
    hernia, cáncer colorrectal…) y su grupo CIE-10. El DX de arriba no cambia. Si el DX lo dice, aparece un botón
    **«¿Apendicitis aguda?»**: tocarlo lo elige. **Nada se elige solo**. ↩ Regresar lo quita.
  - **📋 Falta para el registro**: una línea gris con lo que le falta a la tarjeta (APP, peso, talla, sexo, dx principal,
    cirugías sin urgencia/abordaje/Clavien). No bloquea nada y desaparece cuando está completo. No sale al imprimir.
- **🧪 Laboratorios**.
- **🔪 Cirugías / Procedimientos** (morado). Una fila por intervención con su **fecha** (calendario),
  **PO día N** calculado solo, procedimiento, hallazgos, **sangrado** y cirujano. Botón
  **+ Agregar cirugía** para pacientes con varias intervenciones; la más reciente arriba. Esta caja
  sustituye a las antiguas "Qx / Procedimiento", "Drenajes" y "Sangrado": el texto que ya existía se
  convirtió solo a la lista (una fila por línea con fecha; el sangrado quedó en la cirugía más
  reciente). La fecha POP del menú "⋯ Más" ahora es la de la última cirugía.
  - **Urgencia / electiva, abordaje y complicación** (28 oct 2026): tres menús bajo cada cirugía. Abordaje: abierta,
    laparoscópica, laparoscópica convertida a abierta, endoscópica / percutánea u otro. Complicación: la escala de
    **Clavien-Dindo** con el grado más alto hasta hoy (sin complicación, I, II, IIIa, IIIb, IVa, IVb, V). Si hubo
    complicación aparece **«¿Cuál?»** para escribirla (fuga, ISQ, sangrado…). Con esto el registro calcula urgencias,
    conversiones y complicación mayor (≥ IIIa).
  - **🔎 ¿Cirugía sin registrar?** (28 oct 2026). Si el DX («PO LAPE 26/10»), la Cronología («pasa a quirófano para
    colecistectomía») o la fecha POP dicen que hubo una cirugía que no está en la lista, la caja lo avisa en un renglón
    discreto (máximo 3; no sale al imprimir). **Nada se escribe solo**:
    - **➕ Registrar** agrega la cirugía con su fecha y el procedimiento sin «PO», la hora ni «pasa a quirófano para»;
      revísalo y completa hallazgos, sangrado y cirujano. **↩ Regresar** la quita.
    - **✕** deja de avisar esa en todos los iPads (no es de este internamiento).
    - No avisa lo planeado («programada», «pendiente», «mañana»), los antecedentes («antecedente de…», fechas de antes
      del ingreso) ni lo que ya está en la lista ese día («PO LAPE + RESECCIÓN» con la resección ya anotada: la LAPE es
      su abordaje).
- **💉 Manejo médico actual** (verde azulado).
- **⚠️ Pendientes / Plan** (ámbar).
- **🕓 Cronología** (azul; 19 oct 2026, sustituye a «Entrega / Recibo de guardia», que se confundían):
  UNA sola caja por paciente donde cada guardia anota, con fecha y hora, **lo que pasa y lo que hace**
  (eventos, llamadas, lo que se hizo). El botón **➕ Ahora** agrega un renglón al final con `dd/mm hh:mm GF: `
  y deja el cursor ahí. La siguiente guardia la lee de arriba abajo. **Solo tiene lo que escribe la gente**:
  desde el 27 oct 2026 la app no anota nada sola (ver "Nada automático en las cajas"). **✨ Resumen** muestra en
  una ventana un resumen corto con lo que importa, sin escribirlo en la caja (ver "Entrega de guardia que
  resume"). Lo que había en la caja antigua «Recibido» pasó una sola vez al
  principio de la cronología (en orden) y esa caja desapareció; su historial sigue en 🕘 como «Recibido
  (caja antigua)».
- Las tres cajas de trabajo quedan así: **⚠️ Pendientes** (lo por hacer), **🕓 Cronología** (lo que se va
  haciendo cada guardia) y **🗂️ Otros** (lo que no cabe en ninguna; antes se llamaba Misceláneo).
- **🕘 Historial por caja**: cada caja de texto (Pendientes, Interconsultas, Cultivos, Misceláneo, Guardia…)
  tiene un reloj junto a su título. Abre un diario con las versiones anteriores de ESA caja (quién, cuándo,
  texto completo) y un botón **Restaurar** por versión. Sirve para recuperar lo que alguien borró o lo que un
  arrastre movió de caja: se restaura la versión buena y queda registrado como un cambio más.
- **↩ Regresar / ↪ Rehacer solo tocan la caja de ese paso** (19 oct 2026): si un compañero escribió en otra caja
  desde su iPad mientras tanto, un Regresar tuyo ya no se lo pisa. El botón ↩ Deshacer del aviso «Cambio guardado»
  deshace al paciente que anunció ese aviso.
- **Al abrir, cada equipo toma la 🕓 Cronología (Guardia) de la base** (20 oct 2026). Antes, al abrir o recargar,
  cada equipo se quedaba con SU copia guardada de esa caja: se limpiaron en la base renglones repetidos de varias
  camas y la Mac ya los veía limpios, pero el iPad seguía mostrando los repetidos aunque se cerrara y abriera. Ahora
  gana lo de la base, como en las demás cajas (y como ya pasaba con los cambios en vivo); los diagramas corporales
  siguen la misma regla (un diagrama vacío en la base no borra el trazo del equipo). Lo que ese equipo escribió y aún
  no sube (sin red, en la cola de envío, o lo que estás escribiendo en ese momento) se queda en pantalla y se sube,
  también si mientras espera se guarda un lab en esa tarjeta. Un renglón que otro equipo escribe mientras la app está
  cargando (al abrirla o al volver a ella) tampoco desaparece, y 📜 Restaurar versión sube la Cronología restaurada.
- **Al abrir la app, deja pasar unos segundos antes de escribir en la Cronología.** Mientras termina de cargar y de
  subir lo pendiente del equipo, la tarjeta puede mostrar la copia guardada en el equipo (p. ej. con los renglones
  repetidos); al terminar se repinta con la de la base. Si escribes en ese momento, la caja se queda con lo que veías
  más lo tuyo, y eso es lo que se sube.
- Plegables: **Historia · APP / PA** y **Pendientes MIPs / R1**.

Columna lateral: el **Pase** (dieta, ATB, TVP, herida, NPT, vitales, **drenajes y sondas** con su
gasto y **Balance**, clínico), IC · Cultivos, Sugerencias, Indicaciones del Doc, Estudios de imagen,
Diagrama y No olvidar. El balance ya solo se captura en el pase; bajo la lista de drenajes queda un
renglón de nota libre por si hace falta.

## Cambios de cama: los labs viajan con el paciente

Un paciente que cambia de cama en la hoja (cortar y pegar la fila, o reescribir el número de cama)
conserva su tarjeta completa: labs, pendientes, checklist, diagrama. Tres capas lo garantizan:

1. **La hoja** (`censo-sync.gs`): si la fila desaparece un instante mientras la mueves, el programa
   espera 12 minutos antes de darla de baja; si en ese lapso aparece en otra cama, solo cambia la
   cama. Corregir un número de expediente de la misma persona tampoco borra nada.
   **Hay que volver a pegar el programa en Apps Script** (ver "Paso a paso" arriba).
2. **La base de datos**: si un paciente con el mismo expediente y nombre vuelve a crearse en los
   10 días siguientes a haber sido archivado, su nota se restaura sola desde la Papelera (trigger
   `patients_restore_note_after_insert`, `scripts/supabase_restore_note.sql`).
3. **La app**: al aparecer un paciente, primero lee su nota de la nube y después lo muestra; y
   trae sus labs de WinLab aunque el último escaneo tenga más de 4 días.

El 13 de octubre de 2026 se recuperaron así las notas de 3-151, 3-153, 3-162, 3-177, 3-181 y UCI 8.

## Los labs nunca se borran solos (16 de octubre de 2026)

La bitácora mostraba notas que perdían fechas de labs (15 → 11, 5 → 0). La causa era un dispositivo
con una copia vieja de la nota que, al guardar, subía su lista corta y pisaba la de la nube.
Ahora hay cuatro protecciones:

1. **Al guardar**, la app primero lee las fechas que ya están en la nube y agrega las que le faltan.
   Si no hay red para esa consulta, el guardado sigue igual.
2. **Eliminar labs** es la única forma de quitar una fecha. El borrado queda anotado en la nota y
   ningún otro dispositivo la regresa. El robot tampoco la regresa con los mismos valores, pero sí
   si WinLab trae un resultado nuevo de esa fecha.
3. **Respaldo en segundo plano**: unos segundos después de abrir la app, se bajan los escaneos del
   robot de más de 4 días y se reponen las fechas que falten. Solo cuentan los escaneos de este
   internamiento, desde 5 días antes del ingreso, así que un reingreso no trae labs de hace meses.
   Corre una vez por paciente y dispositivo cada 7 días. Las fechas repuestas no salen como
   «labs nuevos» ni en la entrega.
4. **La base de datos** tiene la misma regla. Hay que ejecutar una vez
   `scripts/supabase_preserve_lab_history.sql` en Supabase → SQL Editor. Para purgar labs a mano
   por SQL, agrega la fecha a `checklist.__lab_deleted` en el mismo cambio.

Un encabezado de WinLab con menos nombres de pila que la hoja ahora sí cuenta, por ejemplo dos
nombres en WinLab y tres en la hoja. Solo cuenta si el robot ya validó ese reporte con nombre y edad.
Otra persona con los mismos apellidos nunca entra.

## Aviso de Supabase «Disk IO Budget» (27 de octubre de 2026)

El 24 de octubre Supabase avisó que el proyecto estaba agotando su presupuesto de **lectura/escritura de
disco** (no de espacio: la base pesa ~100 MB de 500). La causa era la vista `winlab_cultivos` (caja
«Cultivos (lab)»): por cómo estaba escrita, en cada consulta armaba la lista de **todos** los reportes de
todos los días de laboratorios antes de filtrar por paciente, tardaba más de 60 s, escribía ~120 MB de archivo
temporal a disco y la base la cortaba a los 8 s (la caja no recibía nada). 5 GB de temporales en 2.5 días.

- Se reescribió (`scripts/supabase_winlab_cultivos_rapida.sql`, aplicada en producción): mismo resultado
  (147 de 147 cultivos idénticos), ahora en ~1 s, solo con los días y pacientes pedidos y sin tocar disco.
  Reconoce también los encabezados de WinLab en italiano.
- Si aun así la consulta falla en el servidor, la tarjeta ya no se queda callada: muestra «No se pudieron cargar
  los cultivos de WinLab (se reintenta en unos minutos)» y la app lo vuelve a intentar 3 veces, cada 5 min. Los
  cultivos del PDF siguen en 🦠 Cultivos. Sin red no se avisa: se reintenta solo al volver la conexión.
- Indicaciones: la app revisa primero la huella del Doc y solo baja el texto completo (≈136 000 letras)
  si cambió.
- `scripts/supabase_indicaciones_sin_vaiven.sql` (aplicada en producción): la descarga de la base y el Apps
  Script ya no se sobrescriben el Doc mutuamente (~95 reescrituras de 136 KB al día) y una revisión sin cambios no
  toca la fila. Si el Apps Script sube una lectura parcial (la versión vieja que leía solo la primera pestaña), la
  base la ignora mientras su propia descarga funcione.
- Para revisarlo: Supabase → Settings → Infrastructure → Disk IO, o Reports → Database (por hora).
- `scripts/supabase_indicaciones_sin_reenvio.sql` (aplicada en producción): con el Apps Script nuevo los dos traen el
  Doc completo pero con otro formato, y la base reescribía la fila 30 min después de cada edición. Ahora la base
  recuerda desde cuándo el Doc está en cada versión: si el Apps Script ya la subió no escribe nada («api_vigente» en
  `indicaciones_fetch_log`); solo la sube ella si el Apps Script no siguió el cambio en 30 min.

## Seguridad clínica de la app (27 de octubre de 2026)

**Valores críticos (rojo): una sola tabla.** El rojo de la celda, el semáforo, el banner «Labs críticos sin
reconocer», la Entrega, las novedades y el 🧠 Análisis IA usan los mismos cortes: los `cl`/`ch` de `LAB_FIELDS` en
`index.html` (≤ crítico bajo, ≥ crítico alto). Lo demás fuera de rango es **amarillo**. Hoy:

| Estudio | Crítico | Estudio | Crítico |
|---|---|---|---|
| Hb | ≤7 o ≥20 g/dL | Na | ≤120 o ≥160 mmol/L |
| Leucocitos | ≤2 o ≥30 k/µL | K | ≤2.8 o ≥6.0 mmol/L |
| Neutrófilos absolutos | ≤0.5 k/µL | Ca | ≤6.5 o ≥13 mg/dL |
| Plaquetas | ≤50 o ≥1000 k/µL | Mg | ≤1.0 o ≥4.9 mg/dL |
| Hematocrito | ≤20 % | P | ≤1.0 mg/dL |
| Glucosa | ≤50 o ≥400 mg/dL | INR (real o estimado) | ≥3 |
| Lactato | ≥4 mmol/L | TTP | ≥100 s |
| Fibrinógeno | ≤100 mg/dL | pH | ≤7.2 o ≥7.6 |
| pCO₂ | ≤20 o ≥70 mmHg | pO₂ | ≤40 mmHg |
| HCO₃ | ≤10 o ≥40 mEq/L | SatO₂ | ≤85 % |
| Troponina I | ≥100 pg/mL | CK | ≥5000 U/L |
| Triglicéridos | ≥1000 mg/dL | | |

Glucosa 210, leucocitos 15, PCR 200, Hb 7.5, albúmina 2.2, bilirrubina 2.5, lipasa 500, creatinina 3.4 o PCT 4 ya
**no** son rojo (antes casi la mitad de los reportes ponían al paciente en rojo). **Pendiente:** pedir al laboratorio
del hospital su lista oficial de valores críticos y ajustar la tabla (solo en `LAB_FIELDS`).

**WinLab: muestras rechazadas y unidades.**
- Cuando el laboratorio rechaza la muestra («TIEMPO DE PROTROMBINA MUESTRA MAL AFORADA», «HEMOGLOBINA MUESTRA
  COAGULADA», «… SIN MUESTRA»), WinLab pone como valor el límite del rango (TP 11.00). La celda ahora dice
  **RECHAZADA** con ⚠ (repetir la toma), no hay INR estimado y la Entrega dice «TP muestra rechazada — repetir». Si el
  mismo día hay un resultado real, gana el real.
- La troponina I en ng/mL se convierte a pg/mL (×1000). «GLUCOSA» en MINUTOS (curva de tolerancia), la 25-OH vitamina D
  pegada a fibrinógeno/TTP y los cristales de orina ya no ocupan la llave. Si llega una unidad que la app no reconoce
  en un estudio clave (Hb, K, Na, glucosa, Cr, Ca/Mg/P, TP/TTP, fibrinógeno, dímero D, troponina), la celda dice
  **REVISAR UNIDAD (…)**: revisar el valor en WinLab.

**Mensajes y calculadoras.**
- Los mensajes de cada laboratorio orientan («considerar»), sin dosis fijas que dependan de peso, función renal o
  anticoagulación. Fibrinógeno en mg/dL (antes 80 decía «elevado»); dímero D en ng/mL y sin «TEP probable» (sirve
  para descartar, no para confirmar); pancreatitis: la gravedad la da la falla orgánica, hidratación moderada.
- ⚡ Corrección: los CE se estiman como (meta − Hb) × peso ÷ 70 (antes Hb 6 → 10 en 70 kg daba 86 unidades); meta por
  defecto 8 g/dL con el umbral restrictivo de 7. Sin peso no calcula déficit ni unidades: lo pide. Na con la
  clasificación estándar (leve 130-134, moderada 125-129, grave <125) y cuánto sube 1 L de cada solución.
- 🫁 Peso predicho: sin sexo no se calcula (antes suponía hombre); el chip dice «⚥ falta sexo».
- INR estimado = (TP ÷ testigo)^ISI. El ISI está en `PL_INR_ISI` (hoy 1.0): cuando el laboratorio informe el ISI del
  reactivo, cambiarlo ahí. El estimado nunca sustituye al INR para decidir una cirugía.
- Antibiograma: «sensible dependiente de dosis» se muestra como «(SDD: dosis alta)» en la tarjeta, la nota y la entrega.

**Nota de evolución.**
- El borrador ya no escribe datos que nadie capturó: enoxaparina sin dosis → `[DOSIS Y FRECUENCIA]`, sin pronóstico →
  `[PRONÓSTICO]`, Foley → `[¿PERMEABLE A DERIVACIÓN?]`.
- 🤖 Nota con IA: el prompt ya no pide agregar profilaxis, analgesia ni fisioterapia que no estén en la tarjeta. La
  app compara la nota con el borrador: lo que la IA escribió y no venía (medicamentos, cifras, medidas, pronóstico)
  sale **en amarillo** (toca cada uno cuando lo revises) y los `[corchetes]` en rosa. «Copiar» y «↗ Pasar a la página»
  piden confirmación mientras quede alguno.
- 🧠 Análisis IA: los rangos salen de la misma tabla (Ca/Mg/P en mg/dL) y pide sugerencias sin dosis.
- Sugerencia «Lesión renal aguda KDIGO»: solo con una creatinina previa más baja, y nunca con ERC o diálisis en el
  diagnóstico.

## Sincronización entre iPads y datos (27 de octubre de 2026)

- **Alta desde otro dispositivo con cambios sin subir:** si la hoja del censo u otro iPad da de alta a un paciente
  mientras este iPad tiene cambios que aún no suben (los últimos segundos, o todo lo escrito sin red), esa versión va a la
  🗑️ Papelera (local y nube) como «CAMBIOS DE ESTE iPad SIN SUBIR» y sale un aviso. Lo mismo con una nota que estaba en
  la cola de un paciente que ya no está en el censo al volver la red (antes se tiraba en silencio).
- **Dos personas en la misma caja:** si un colega cambia la caja que estás escribiendo, la tarjeta avisa
  «✋ … cambió «Pendientes» mientras escribías» con **Ver su versión**, **Unir las dos** (tus renglones + los suyos
  nuevos, marcados con su nombre) y **Quedarme con la mía**. Lo reemplazado siempre queda en 🕘 Historial de la caja.
- **«No olvidar»:** el aviso entre iPads ya no manda la lista; cada iPad la baja de la nube (un iPad que estuvo dormido
  ya no impone su lista vieja). También se recarga al volver a la app y al volver la red.
- **Recargas:** al volver los canales en vivo después de un corte, una recarga completa (censo, notas, «No olvidar»,
  procedimientos); y cada 10 min con la app en pantalla y nadie escribiendo, una recarga ligera.
- **Nota muy grande:** si el aviso en vivo llega recortado (más de 1 MB), se baja la nota completa en vez de vaciar cajas.
- **Sin red:** la barra dice de cuándo son los datos («Sin conexión · datos de hoy 06:10») y, con más de 2 h, en rojo
  con un aviso abajo.
- **Memoria del iPad:** las notas de pacientes que llevan más de 24 h fuera del censo se borran del iPad (siguen en la nube
  y en la Papelera).
- **Camas:** mover a alguien a una cama con número que ya ocupa otro paciente avisa quién la ocupa y no hace nada (la nube
  acepta uno por cama; para intercambiar usa una cama libre de paso). Restaurar de la Papelera ya no borra la copia de la
  nube hasta que el paciente sube.
- **Procedimientos del día:** el día se fija al crearlo; editarlo o subirlo después de medianoche ya no lo cambia de día.
- **Críticos reconocidos:** «✓ Reconocer» guarda quién y a qué hora; la tarjeta lo muestra («🔕 Reconocidos: K 6.4 ✓ GF 07:40»).
- **Indicador del robot** (botón 💧 de arriba): «Robot: hoy 05:12» con la última corrida; en rojo con ⚠ si no corrió a la
  hora programada (05:00, 12:30 y 20:07, con 2 h de margen). Antes nunca funcionaba.
- **Nombres parecidos:** etiqueta «👥 Apellido igual: 3-115» en la tarjeta de dos pacientes con el mismo apellido paterno.
- **Fotos y PDF con IA:** la nota postquirúrgica de otro paciente (nombre o expediente distinto) no llena nada; los labs
  leídos de foto/PDF se muestran para confirmar antes de guardarse, los imposibles (K 50, Hb 150) se descartan y la celda
  queda marcada 🤖.
- **📌 Tablero:** ahora se comparte entre iPads (se une renglón por renglón; un borrado no resucita). La Entrega ya no
  proyecta «altas programadas» de pacientes que ya se fueron.
- **🔠 Letra** (⋯ Más): normal → grande → más grande, en cajas, tabla de labs y fechas. En la tabla de labs, además del color,
  «A» = alto, «B» = bajo, «!» = crítico.
- **Arranque:** después del censo, notas, labs, robot, indicaciones e imagen se piden al mismo tiempo.

## Registro de pacientes para investigación: pestañas de análisis y motivo del egreso (27 de octubre de 2026)

El registro de Google Sheets (`apps-script/registro-pacientes.gs`; detalle en `apps-script/REGISTRO.md`) ya no es solo
una copia: además trae pestañas listas para estadística.

- **Pestañas «Análisis · Episodios / Labs / Signos vitales / Cultivos».**
  - No tienen nombres ni expedientes: usan ID seudónimos.
  - Los números van como números, en la unidad de la app; las fechas como AAAA-MM-DD.
  - Lo que no se pudo usar como dato (muestra rechazada, unidad desconocida, valor imposible, texto) queda vacío y
    explicado.
  - «Diccionario de variables» define cada columna.
  - Para compartir un análisis: Archivo → Descargar → CSV de esas pestañas, una por una. **Nunca** se comparte la
    «Clave de seudónimos».
- **Una hospitalización restaurada desde la Papelera cuenta como UN episodio** (antes parecía un egreso y un reingreso
  falsos). Si la segunda parte entró 2 días o más después, «Calidad de datos» pide confirmar que no fue reingreso.
- **Motivo del egreso.** Casi todos los egresos salen del censo de la hoja («RETIRADO DEL CENSO (hoja)») sin decir si fue
  alta o defunción. Por eso el registro no podía calcular mortalidad. Ahora:
  - al dar de alta en la app (🚪 Alta), el cuadro pide el motivo (desde el 28 oct: alta a domicilio, defunción, cambio
    de servicio, contrarreferencia, traslado a otro hospital, alta voluntaria, fuga / abandono, otro motivo o «no fue
    egreso (error del censo)»). **Es obligatorio** (28 oct 2026): sin elegirlo, el botón avisa y abre el menú. Al cambiar
    el estado a ALTA o DEFUNCIÓN, ese estado ya es el motivo;
  - **aviso discreto «🚪 Egreso sin motivo»** (28 oct 2026): cuando un paciente ya no aparece en el censo (alta en la app o
    retirado por la hoja) y nadie dijo el motivo, una tarjeta pequeña abajo a la izquierda pregunta «3-160 · NOMBRE ya no
    aparece en el censo. ¿Cuál fue el motivo del egreso?» con el menú. No bloquea nada:
    - se esconde mientras escribes o hay una ventana abierta;
    - «Después» la pospone 3 horas en ese dispositivo; «✕» la cierra hasta recargar;
    - el chip **🚪 N** de la barra del paciente dice cuántos faltan y la vuelve a abrir;
    - solo pregunta por los egresos de los últimos 7 días (los más viejos se clasifican en la Papelera);
    - lo que elija cualquiera queda para todos; «Defunción» pide confirmar;
    - si el paciente volvió al censo, no pregunta;
  - en la **Papelera**, cada egreso tiene su selector «Motivo», y arriba aparece cuántos egresos no lo tienen;
  - el motivo se guarda en la nube con la función `archive_set_egreso` (`scripts/supabase_archive_egreso.sql`, ya
    aplicada); se une a la copia sin pisar la nota;
  - el registro lo toma aunque la copia sea vieja.

  **Pide al equipo que llene el motivo de los egresos.** Sin él, en el registro la defunción queda «desconocida».
- **Mortalidad con los motivos nuevos** (registro 2026.10.28): «Defunción» = 1; alta, alta voluntaria, traslado,
  contrarreferencia, fuga y cambio de servicio = 0 (salió vivo del servicio; en cambio de servicio no se conoce el
  desenlace posterior en el hospital); «otro motivo» y «no fue egreso» quedan vacíos (y «no fue egreso» no cuenta como
  egreso observado).
- **Cirugías desde donde estén marcadas** (registro 2026.10.28). La pestaña «Cirugías» ya no depende solo de la caja:
  si una cirugía no está ahí, se toma de la fecha POP, del texto Qx anterior, de la Cronología («pasa a quirófano…») o
  del DX («PO LAPE 25/10»), sin repetir la que ya está en la caja (mismo día). Cada fila dice su **Fuente** y su
  **Grupo** (laparotomía, colecistectomía, apendicectomía, plastia, resección intestinal…). La programación del día
  entra como «sin confirmar» y no cuenta como cirugía hecha. Si después alguien la pasa a la caja, la inferida queda
  «Vigente: No» y no se cuenta doble. «Análisis · Episodios» suma «Grupo de la 1.ª cirugía», «Reintervención»,
  «Cirugías inferidas (n)» y «Programadas sin confirmar (n)»; «Calidad de datos» pide pasar las inferidas a la caja.
- **Datos que antes se perdían** (registro 2026.10.28):
  - **Peso y talla** del Pase Matutino (Pacientes) e **IMC** (Análisis · Episodios; las filas viejas los toman del
    checklist guardado).
  - **Comorbilidades** desde los Antecedentes (APP) y el DX, con negación («NIEGA DM, HAS» = 0): diabetes,
    hipertensión, ERC, cirrosis, cardiopatía, EPOC/asma, obesidad (también por IMC ≥ 30), cáncer, inmunosupresión y
    tabaquismo; «Comorbilidades (n)». Sin APP quedan vacías (desconocidas), no 0. Es texto libre: revisar una muestra
    antes de publicar.
  - **Horas de uresis** e **índice urinario** por día (Análisis · Signos vitales) e «Índice urinario mínimo» y «Días
    con oliguria (IU < 0.5)» por episodio.
  - **Labs corregidos a mano** (✏️ Corregir): la pestaña «Labs» dice quién corrigió, cuándo y qué decía antes.
  - **Para que el registro sea completo, en la app:** llenen **APP**, **peso y talla** (fila Clínico del Pase), las
    **horas de la uresis**, el **motivo del egreso** (🚪) y pasen las cirugías a la caja (🔎 ➕ Registrar).
- **Pestañas nuevas del registro** (registro 2026.10.28-2):
  - **«Por completar»**: la lista de trabajo del equipo, **con nombres** (no se comparte). Trae a los hospitalizados y a
    los egresados de los últimos 30 días a los que les falta algo: motivo del egreso, sexo, edad, APP, peso, talla,
    dx principal, cirugías por pasar a la caja o sin urgencia/abordaje/Clavien. Al completarlo, la fila queda «Vigente:
    No». Sugerencia: que el jefe de residentes la revise una vez por semana.
  - **«Resumen mensual»**: solo cuentas, sin nombres. Por mes: ingresos, egresos, defunciones y **mortalidad sobre los
    egresos con desenlace conocido** (y cuántos no tienen motivo), estancia mediana y media, pacientes operados,
    cirugías, % de urgencias, % laparoscópico, conversiones, complicación mayor (Clavien ≥ IIIa), reintervenciones,
    reingresos a 30 días, cultivos positivos y los 5 dx, cirugías y gérmenes más frecuentes.
  - En «Análisis · Episodios»: dx principal con su CIE-10 y de dónde salió (elegido o inferido del DX), urgencia y
    abordaje de la 1.ª cirugía, conversión, Clavien-Dindo máximo, complicación mayor y cirugías sin clasificar.
- **Para que el registro tenga las pestañas nuevas:** abre el proyecto «Registro de pacientes» en script.google.com,
  borra todo `Código.gs`, pega el `apps-script/registro-pacientes.gs` nuevo y guarda. No hay que tocar nada más: la
  propiedad `REG_SAL` (la sal del seudónimo) se crea sola en la siguiente corrida.

## Privacidad de las bitácoras de los robots y robot que se congelaba (27 de octubre de 2026)

- **Bitácoras sin nombres.** El repositorio es público y las bitácoras de GitHub Actions también.
  - Los robots de WinLab y del RIS imprimían nombres de pacientes (homónimos, casi-coincidencias, «encontrado como»).
  - Ahora imprimen solo la cama, las iniciales y los 3 últimos dígitos del expediente.
  - Una red de seguridad (`rpa/lib.js`: `instalarLogSeguro`) oculta cualquier nombre que se escape.
  - Una prueba revisa que ninguna línea de bitácora imprima un nombre.
- **Sin adjuntos con datos.** Ya no se suben capturas de pantalla ni volcados de WinLab/RIS como adjuntos de la corrida:
  cualquiera con cuenta de GitHub podía descargarlos.
- **Limpieza de lo que ya estaba publicado.** El flujo «Limpiar bitácoras con datos de pacientes»
  (`.github/workflows/limpiar-bitacoras.yml`) borra las bitácoras de todas las corridas anteriores de los robots. Corre
  solo al llegar a main y se puede relanzar a mano. Las corridas siguen listadas, sin su texto.
- **«🔎 Buscar ahora» ya no publica el expediente.** La app manda al robot el id interno del paciente (`ID-<uuid>`, que no
  identifica a nadie) y el robot lo busca en el censo. No hubo que cambiar el worker.
- **Robot que se quedaba pasmado ~55 min.** Ninguna operación del navegador queda sin tope:
  - abrir o cerrar la pestaña de un paciente: 15 s;
  - guardar en Supabase: 90 s.

  Si el navegador no responde, el robot guarda lo capturado, entra otra vez a WinLab y sigue con el siguiente paciente
  (hasta 3 veces por corrida). El error «interrupted by another navigation» se reintenta. Cada intento del flujo tiene 45
  min, así el segundo intento sí cabe en los 90.
- **Respaldo diario sin trabajo repetido.** La corrida diaria del cron de GitHub es solo respaldo de las tres de Supabase.
  Si en las últimas 8 h el robot ya revisó al menos al 80 % del censo, termina en segundos; si no, corre completa.
- **Imagen (RIS) cada 2 h de verdad.** GitHub lanzaba el robot de imagen cada 4-6 h aunque estaba programado cada 2.
  Ahora Supabase lo dispara a hora exacta cada 2 h (minuto 41, cron `ris-scrape-cada-2h`;
  `scripts/supabase_ris_dispatch.sql`, ya aplicado) por una ruta nueva del worker (`/api/scrape-ris`).
  - **Falta un paso tuyo:** pega el `cloudflare-worker/index.js` nuevo (v6, que ya incluye lo de v5) en el worker
    `piso-libro-ai` (Cloudflare → Workers → piso-libro-ai → Edit code → pegar → Deploy). Ver "Worker v6" abajo.
  - Hasta entonces, esa ruta responde 404 (queda anotado en `winlab_dispatch_log`, sin efecto) y el cron de GitHub
    sigue como respaldo.
- **Vigilante de todo el sistema.** `labs-watchdog.yml` + `scripts/vigilante.py` revisa cada 2 h (antes cada 6 y solo
  labs) la última señal de vida de cada pieza:

  | Pieza | Límite |
  |---|---|
  | Robot de labs | 11 h (avisa antes de la visita si falló la corrida de las 05:00) |
  | Labs guardados | 26 h |
  | Imagen del RIS | 10 h |
  | Descarga del Doc de indicaciones | 2 h |
  | Censo | 18 h sin ningún cambio |
  | Tamaño de la base | — |
  | Disparos desde Supabase (labs y RIS) | la última respuesta del worker debe ser 200 (un 404 del RIS solo avisa: worker sin pegar) |
  | Protecciones de la base | todas puestas (`pl_salud_catalogo`, 59 revisiones: triggers de notas y pacientes, RLS, políticas, pg_cron, canales privados, que nadie pueda cambiarse el rol) |
  | Versión de los dos Apps Script | igual a la del repositorio (solo avisa) |

  Si algo se atrasa, el job sale en rojo con el qué revisar y GitHub te manda el correo. Solo imprime horas y conteos.
- **📦 Labs Masivo descarta valores imposibles.** Si la IA lee mal una cifra (Hb 125, K 40…), ya no se guarda, igual que
  en la hoja de una sola persona; el resultado lo dice en rojo («No se guardaron… revisa la hoja»). Probado además: el
  mismo PDF dos veces no duplica; con labs de WinLab del mismo día se suman sin pisar; un PDF que falla no detiene a los
  demás; un nombre que encaja con dos pacientes no se escribe hasta confirmarlo.
- **El robot ya no reescribe lo que no cambió.** Si la fila de hoy de un paciente ya está igual en la base (mismos reportes,
  cama y especialidad), no se vuelve a guardar. Antes cada corrida mandaba un aviso en vivo a todos los iPads («🧪 Labs
  WinLab actualizados») y repintaba las tarjetas aunque nada cambiara. El resultado de la búsqueda (`winlab_match`) sí
  se actualiza siempre (de ahí leen el indicador del robot y el vigilante).
- **Edad que no cuadra con WinLab.** Si en WinLab solo hay una persona con ese nombre, el robot acepta sus labs aunque la
  edad no coincida (para no perder labs por una edad mal capturada en la hoja). Ahora la tarjeta lo avisa en amarillo
  («WinLab: 61 años · censo: 39»): corrige la edad en la hoja del censo o, si son de otra persona, fija el «Nombre en
  WinLab».
- **«🔎 Buscar ahora» con la cola ocupada.** El aviso ya no promete que «incluirá a este paciente»: dice que, si lo que
  está en cola es la búsqueda de otro paciente, hay que pulsar 🔎 otra vez. La tarjeta vigila el resultado 45 min
  (antes 12), porque la corrida completa tarda 25-32.

## Los labs ya no se reescriben en bucle (19 de octubre de 2026)

La bitácora de actividad crecía con miles de filas al día de «labs» que no cambiaban nada: la base
guarda los analitos en otro orden del que la app los arma, la app lo tomaba como un cambio, volvía a
subir los labs de todos los pacientes y cada iPad recibía el aviso «📡 Actualización recibida» y
repetía la pasada. Desde esta fecha:

1. La app compara los labs **analito por analito y valor por valor**, sin importar el orden. Si las
   cifras son las mismas no guarda nada, no toca la hora de sincronización y no sube la nota.
2. Cuando el robot sube una fila de WinLab, la app sincroniza **solo a ese paciente** (no a todo el
   censo) y junta las filas que llegan en 1.5 s en una sola pasada; una corrida de 40 filas es una
   pasada, no 40.
3. El aviso «🧪 Labs WinLab actualizados» nombra solo a quien de verdad tiene labs distintos, y el
   aviso «📡 Actualización recibida» sale solo cuando cambió algo visible de un paciente en pantalla.

Si el ⚙️ Actividad vuelve a mostrar muchas filas de «labs» seguidas del mismo paciente con las mismas
cifras, probablemente algún iPad sigue con la versión anterior: basta con recargar la app ahí.

## Cirugías y gastos: todo el texto cabe (16 de octubre de 2026)

Las cajas de Cirugías crecen hasta mostrar todo el procedimiento y los hallazgos. Sangrado y cirujano
van en su propio renglón con espacio. En drenajes, sondas y estomas el gasto tiene un cuadro de al
menos 96 px y se lee completo. Si el panel es angosto, cada dispositivo usa dos renglones. Cuando un
valor no cabe, la letra baja solo lo necesario. Al tocar el cuadro vuelve a su tamaño normal, para que
el iPad no haga zoom, y al soltarlo se ajusta de nuevo.

## Apple Pencil, Misceláneo y nota postquirúrgica con IA (16 de octubre de 2026)

**Apple Pencil.** En el iPad, con ✍️ Scribble (el modo por defecto), la app ya no deja ningún oyente que haga
esperar al lápiz: antes cada toque esperaba a la app y, si estaba ocupada guardando, el lápiz solo
seleccionaba. Un iPad que se había quedado en ✍️ Tinta regresa una vez a Scribble. En 📌 Tablero, pasar
de una nota a otra ya no borra la nota en la que se escribe. Tocar la cama o el nombre en la cabecera de la
ficha ya no esconde las cajas.

**Misceláneo.** La caja «Manejo médico actual» ahora se llama 🗂️ Misceláneo en la ficha, la barra de saltos,
⚙ Cajas, el editor y la nota de evolución. El dato es el mismo. Lo escrito no se pierde al cambiar de
tarjeta antes de que se guarde, al perder la red, al ocultar la app ni cuando llega un cambio de otro iPad.

**Nota postquirúrgica con IA.** En Cirugías, el 📷 de cada cirugía o el botón «📷 Nota postquirúrgica»
toman la foto (o varias páginas). La foto queda en la cirugía y el ayudante de IA llena SOLO los campos
vacíos: fecha, procedimiento, hallazgos (con técnica, complicaciones y lo importante), sangrado y cirujano.
Lo que ya estaba escrito nunca se pisa. Revisa lo llenado; ↩ Regresar lo deshace. Sin red o si falla, la foto
se queda y la lectura se reintenta sola al volver la red, o con 🤖 Transcribir. La foto también se guarda en
el iPad si la subida tarda, y se abre en un visor dentro de la app.

**Robustez.** Revisión completa del archivo con 5 revisores y verificación independiente: arranque sin red
sin pantalla vacía, no cerrar sesión cuando solo falta la red, la copia vieja de otro iPad ya no borra la
Entrega o las casillas del colega, la recarga ya no regresa lo recién escrito, altas y pacientes nuevos sin
red ya no reaparecen ni desaparecen, el almacenamiento lleno libera historial de pacientes egresados, y
las llamadas a la nube y a la IA tienen límite de tiempo.

## Entrega de guardia que resume (octubre 2026)

La vista **📤 Entrega** (una ficha por paciente) muestra **solo** estos bloques, en este orden, y
únicamente los que tienen algo escrito (lo que no está registrado no aparece): **🩺 Diagnóstico**, **❤️ Signos vitales** del pase
(TA con PAM, FC, FR, temperatura, SaO₂ con el O₂; si hoy aún no se capturan, los del último día con
su fecha), **💧 Gastos**, **🧪 Laboratorios** puntuales, **🦠 Cultivos** (WinLab con germen y
antibiograma, o "en proceso", y lo escrito en la caja Cultivos) y **🩻 Estudios de imagen** (solo
las conclusiones: los estudios del visor de las últimas dos semanas que ya tienen reporte, y el
último registro manual).

**📽 Modo Proyector** (botón en la vista Entrega): muestra una ficha por paciente a pantalla completa
con esos mismos bloques más los **🔪 eventos quirúrgicos** (fecha, día POP, hallazgos, sangrado y
cirujano), **todos los laboratorios** del último control agrupados como en la tarjeta (críticos en
rojo, anormales en ámbar) y las **💊 indicaciones** del Doc de indicaciones. Solo aparece lo que está
registrado. Empieza en la cama 150 y sigue el orden del tablero (piso 3
por número, luego UCI, UTI y piso 2); con **Ir a cama** se elige desde dónde empezar, y ◀ ▶ (o las
flechas del teclado) avanzan. La ficha se ajusta sola al tamaño de la pantalla para que no se corte.

El botón **✨ Resumen** de la Cronología muestra el resumen completo en una ventana de solo lectura, que además incluye:

- **🔪 Quirófano**: si pasó a quirófano hoy o ayer (procedimiento, hallazgos, sangrado, cirujano);
  si no, el día POP de la última cirugía y cuántas previas hay. Cruce quirúrgico si está activo.
- **⚠️ Atención**: vasopresor con dosis, ventilador, NPT, ayuno, "sin labs desde hace N días".
- **💧 Gastos**: cada drenaje o sonda con su gasto y características, la nota de drenajes, la uresis
  y el balance del pase.
- **🧪 Labs puntuales** del último control: solo valores críticos, cambios grandes contra el control
  previo (por ejemplo Hb que baja 1.5 o más, K que cambia 0.7, creatinina 0.3), INR ≥ 1.3 y lactato
  > 2, con flecha de tendencia y el valor anterior. Máximo seis; el resto se cuenta. Nada de
  transcribir todos los analitos.
- **🆕 Nuevo del día**: lo que se agregó, pidió o llegó hoy o ayer. Se reconoce por los sellos de
  fecha que ya usa la app (➕ Hoy, el encabezado del día en Pendientes)
  en Pendientes, Manejo, IC, Cultivos y Entrega; además los drenajes colocados hoy/ayer, los
  estudios del visor recién llegados (con su conclusión) y los cultivos de los últimos dos días.
  Por eso conviene tocar ➕ Hoy antes de escribir: lo que no tiene fecha no se puede saber si es nuevo.
- **📋 Pendientes** abiertos (sin ✓) y los "No olvidar" del paciente.

✨ Resumen abre una ventana con el texto (encabezado `— Resumen dd/mm hh:mm GF —`) y un botón **📋 Copiar** por
si alguien lo quiere pegar en algún lado. **No escribe en la Cronología.** Lo escrito en la Cronología se ve en
la tarjeta, no en la vista 📤 Entrega.

### Nada automático en las cajas (27 oct 2026)

Pedido de Gera: «no quiero que pongas nada en las cajitas de manera automática». Antes la app anotaba sola en la
Cronología una línea por novedad (`13-10-2026: Labs: …`, estudios del RIS, cultivos) y ✨ Resumen escribía su
bloque al final. Desde la versión 2026.10.27-5:

- La app **ya no escribe nada por su cuenta en ninguna caja**. Los labs críticos, los estudios de imagen y los
  cultivos se siguen viendo en su sección de la tarjeta, en los avisos («labs nuevos», 🩻) y en la vista 📤 Entrega.
- ✨ Resumen solo muestra (ver arriba).
- Las 14 líneas automáticas que ya había (10 pacientes) se quitaron de la base; lo escrito por la gente no se tocó.
  Cada línea quitada quedó registrada en `guardia_cortes` (motivo «borrado») y en la bitácora (`audit_log`).
  El script es `scripts/supabase_quitar_auto_cronologia.sql`.
- La base rechaza esas líneas si alguien las manda, al editar una nota (`pl_entrega_protegida`) y, desde el 28 oct,
  también al crear la primera nota de un paciente nuevo (`pl_entrega_sin_auto_insert`; ese día una pestaña de Chrome
  con la versión vieja coló una línea así y se quitó). Un iPad o una computadora con la versión anterior solo las ve
  un momento hasta que se actualiza (la app avisa cuando hay versión nueva; una pestaña que lleva días abierta conviene
  recargarla).
- Lo que **sí** sigue escribiendo la app es lo que pide la persona con un botón: ➕ Ahora / ➕ Hoy (fecha y
  hora), órdenes rápidas, ➕ A pendientes de una sugerencia, importar el censo o el PDF, la transcripción del lápiz
  o de una foto que la persona manda convertir. Y la caja antigua «Recibido» pasó una sola vez a la Cronología
  (texto de la propia gente).
- Desde la versión 2026.10.28-1, subir un PDF o una foto de labs **ya no agrega la línea «[LABS dd/mm …]» al final
  del DX**; los valores quedan en la tabla de labs. Las líneas que ya existían en algún DX no se tocaron (se borran a
  mano si estorban).

## INR: siempre visible (octubre 2026)

WinLab **no reporta INR**: en coagulación solo entrega TP, su **testigo** (control, 13 s) y TTP. Como
el INR decide si se opera, la app ahora:

- guarda el testigo del TP (`tp_testigo`), que antes se descartaba como basura del PDF;
- cuando no hay INR capturado, lo **estima** como TP ÷ testigo (ISI ≈ 1) y lo marca con **≈** (por
  ejemplo TP 20.7 s con testigo 13 s → INR ≈1.59, en ámbar; ≥ 3 en rojo);
- muestra la fila INR **siempre** en la tabla de labs de la ficha, aunque no haya valor (en modo Pase
  las demás filas vacías se ocultan); en la lista, la celda vacía trae el estimado como marca de agua
  y al escribir el INR real este manda;
- lo pone en la línea de pase (`INR ≈1.59▲`), en la nota de evolución ("INR 1.59 (ESTIMADO
  TP/TESTIGO)"), en los labs puntuales de la entrega y como novedad automática si es ≥ 1.5.

Si el laboratorio reporta un INR real, se usa ese y desaparece el estimado.

## ✍️ Lápiz: escribir con el Apple Pencil (octubre 2026)

**En el iPad escribe con el lápiz encima de CUALQUIER caja** (vitales FC/FR/T°/SaO₂, TA `120/80`, uresis,
gasto de drenajes, dieta, días de ATB, labs, vasopresor, modales, cajas grandes) y el iPad lo convierte en
letra de máquina al instante (Scribble, el reconocedor de Apple). La app no interviene: no hay que elegir
nada. **Desde el 19 de octubre de 2026 en el iPad no hay modos**: el botón **✍️** de la barra siempre dice
«✍️ Scribble» y, al tocarlo, solo recuerda cómo funciona y cómo activar Garabatear. El estado **✍️ Tinta**
se retiró del iPad: dejaba la letra como tinta en las cajas grandes y, con sus oyentes en la página, hacía
que en las demás cajas (vitales, gastos) el lápiz "no dejara escribir" o seleccionara y arrastrara texto de
una caja a otra (así se movieron bloques enteros en una entrega). Un iPad que se quedó en Tinta o en «→ Texto»
vuelve solo a Scribble al abrir; la tinta que ya estaba guardada en una caja se sigue viendo y el ✍️ de cada
caja (lienzo grande) sigue ahí para dibujar o firmar. Un **toque** con el lápiz pone el cursor; el dedo y el
teclado siguen igual.

**Campos chicos (Pase Matutino, dieta, gasto de drenajes, labs, peso/talla, ventilador)**: al tocarlos con el
lápiz se agrandan solos en una banda de escritura (230 × 52 px, letra grande) para que Scribble tenga dónde
escribir; al soltar el foco vuelven a su tamaño. Antes el trazo caía fuera del campo (52 px) y el iPad lo tomaba
como selección o desplazamiento («no me detecta el lápiz»).

**Si el lápiz solo selecciona texto en vez de escribir**, Scribble está apagado en el iPad: Ajustes →
Apple Pencil → **Garabatear** (encendido). Prueba rápida: escribe con el lápiz en el buscador de Safari.
La app lo detecta sola: si escribes dos palabras seguidas con el lápiz en una caja de texto y no entra ninguna
letra, aparece un aviso abajo con esos pasos (botón «Entendido» para cerrarlo; vuelve a salir si pasa de nuevo).
Mientras Scribble convierta lo escrito, el aviso no sale.

**Protección contra arrastres y borrados** (19 oct 2026): el texto ya no se puede arrastrar ni soltar
entre cajas (ni con el lápiz ni con el dedo: lo seleccionado se queda donde está). Si una caja pierde
40 o más letras de golpe (borrón, Scribble que tachó de más), sale el aviso **Deshacer** unos segundos;
y si ya pasó, el reloj 🕘 de la caja abre su historial para restaurar la versión anterior.

Fuera del iPad (laptop con lápiz, Android) sigue existiendo el estado **✍️ → Texto**: los números los
convierte la app al instante (reconocedor local de dígitos, sin red) y el texto el **ayudante de IA**
(worker en ⚙️ Config), con una lectura provisional en morado que no se guarda hasta que la IA responde.

## Quién agregó cada procedimiento del día (19 de octubre de 2026)

En la lista **🔬 Procedimientos del día** (al pie de la vista Piso) cada fila muestra ahora **👤 quién lo
agregó en la app y a qué hora** (el nombre con el que esa persona entró). Se guarda al crearlo y no cambia
al editarlo; los procedimientos de antes de esta versión muestran «?».

## Vista de escritorio (octubre 2026)

En un monitor ancho el contenido usa hasta 1 740 px (antes 1 440, con márgenes enormes), la cabecera y
las pestañas quedan alineadas con el contenido (el logo y «Salir» ya no tocan el borde) y la ficha del
paciente mide lo mismo que la barra de navegación (antes se centraba a 1 100 px bajo una barra más
ancha). En laptop sigue el riel de camas a la izquierda; en iPad, la tira de camas en la barra.

## Vista iPad: las cajas usan todo el ancho (octubre 2026)

- Las **camas** ya no van en el riel de la izquierda cuando la pantalla mide menos de 1 340 px (iPad):
  están en una **tira deslizable** dentro de la barra pegajosa del tablero (la cama en foco queda a la
  vista; el punto rojo/ámbar y 🧪 labs nuevos se conservan). En laptop sigue el riel lateral.
- Se quitaron los **tres botones flotantes** de la derecha (💾 respaldo, 📥 indicaciones, 📊 planes)
  que tapaban las cajas. **📊 Planes** está en la barra del tablero y los tres viven en el menú
  **⋯ Más → Importar y respaldo**.

## Cultivos

Los cultivos de WinLab aparecen en **IC · Cultivos** aunque el resultado venga como "POSITIVO",
"NO DESARROLLO" o "NEGATIVO A 5 DÍAS" (antes solo se leía el germen y casi nunca salían).

La tabla de WinLab solo dice "POSITIVO": el germen y el antibiograma están en el PDF del reporte.
Desde el 13 de octubre de 2026 el robot abre ese PDF, guarda su texto completo y extrae germen
(género y especie, con BLEE / carbapenemasa / MRSA si lo dice), UFC y antibiograma. La tarjeta
muestra **S:** sensibles, **I:** intermedios y **R:** resistentes, con el reporte completo
plegable ("📄 Reporte completo"). La entrega de guardia y la nota de evolución dicen a qué es
sensible y resistente. Los cultivos ya capturados antes de esa fecha se vuelven a abrir una vez
en la siguiente pasada del robot. Si un antibiograma no se reconoce, el texto completo sigue
visible en la tarjeta: mándame ese caso (sin nombre) para afinar el lector.

## Nota de evolución

En la tarjeta, **📝 Nota de evolución** genera la nota completa en el formato del servicio (todo en
mayúsculas): encabezado con edad, FN, expediente y cama; década de la vida y diagnósticos unidos con
"+"; subjetivo; signos vitales en texto (oxígeno por puntas nasales o mascarilla, ventilador);
exploración; drenajes y sondas con gasto y características; Foley con uresis; laboratorios del día
con nombres completos y los del control previo (lo que hoy no se tomó más la tendencia de
leucocitos, hemoglobina, creatinina, PCR y procalcitonina); análisis por aparatos y sistemas;
ayuno o dieta, antibiótico y día, NPT, tromboprofilaxis, cultivos, tomografía con conclusión,
interconsultas, plan y pendientes; estado de salud y pronóstico; firma. Lo que la tarjeta no sabe
queda entre corchetes `[…]` para llenarlo antes de pegar.

### 🤖 Nota con IA en un clic (octubre 2026)

En el menú **⋯ Más** de la tarjeta, **🤖 Nota IA (1 clic)** abre la nota y la redacta sola: toma
todo lo de la tarjeta (diagnósticos, pase matutino, drenajes y sondas, cirugías, laboratorios por
fecha, cultivos, estudios, antibiótico, APP/PA, manejo, pendientes, entrega y recibo de guardia), lo
manda al ayudante de IA (el worker de Cloudflare, la misma configuración que "Leer documento con
IA") con el formato exacto del servicio y la instrucción de redactar el análisis y plan con medicina
basada en evidencia: metas numéricas y guías por nombre y año solo cuando aplican (Surviving Sepsis
2021, WSES/SIS, ESPEN 2023, KDIGO, AABB, ADA, ERAS, ARDSNet, Tokyo 2018). Reglas duras: no inventa
datos (lo que falta queda entre corchetes), conserva cifras y fechas tal cual, sin markdown, todo en
mayúsculas; el encabezado y la firma siempre son los de la tarjeta. Mientras la IA responde ya ves
el borrador estructurado; si la IA falla o no hay red, te quedas con ese borrador (aviso amarillo) y
puedes reintentar.

- **✏️ Editar** permite corregir el texto antes de copiarlo.
- **Copiar** copia la nota. **↗ Pasar a la página de notas** la copia y abre la página de notas de
  evolución del hospital para pegarla ahí (Ctrl/Cmd + V). La primera vez pide la dirección de esa
  página; queda en **⚙️ Configuración → Página de notas de evolución** y se comparte a todos los
  dispositivos.
- **🕘 Notas previas**: cada nota generada o copiada se guarda en la tarjeta (las últimas 10) para
  volver a verla.
- **📝 Borrador sin IA** sigue generando la nota estructurada de siempre.

### 💉 Vasopresores y 🫁 ventilador (octubre 2026)

En el checklist de la tarjeta, la fila **⚕️ Clínico** tiene ahora **Peso (kg)** y **Talla (cm)**. El
peso se usa en la calculadora y se precarga en la corrección de electrolitos.

La fila **💉 Vasopresor** calcula la dosis con solo el peso, la dilución y la velocidad. El **⚖️ peso**
se captura ahí mismo (es el mismo de la fila Clínico: cambiar uno actualiza el otro):

- **Norepinefrina**: al encenderla propone **4 mg en 100 mL** (en el servicio todo se diluye en
  100 mL; editable). Con la velocidad en mL/h muestra la dosis en **mcg/kg/h** y, entre paréntesis,
  en mcg/kg/min: `(mg × 1000 ÷ mL) × mL/h ÷ kg` (÷ 60 para mcg/kg/min). Ejemplo: 4 mg/100 mL a
  10 mL/h en 70 kg = 5.7 mcg/kg/h (0.095 mcg/kg/min). En **meta** escribes la dosis deseada en
  mcg/kg/h y te dice a cuántos mL/h ponerla. Más de 30 mcg/kg/h (0.5 mcg/kg/min) se marca en rojo;
  a partir de 15 mcg/kg/h (0.25 mcg/kg/min) sugiere agregar vasopresina (Surviving Sepsis
  Campaign 2021).
- **Vasopresina**: propone 20 U en 100 mL. Muestra U/min (y U/h): `(U ÷ mL) × mL/h ÷ 60`; la meta
  funciona igual. Más de 0.04 U/min se marca en rojo.

Con **🫁 VM** encendido, además de modo, FiO₂, PEEP, VT, FR y PIP puedes anotar **Pplat**,
**Pmedia** e **I:E**. Con la talla (y el sexo en ✏️ Editar) calcula el peso predicho (Devine) y
muestra **VT en mL/kg** (rojo si > 8) y la **presión de distensión** Pplat − PEEP (rojo si > 15;
Pplat > 30 también se marca).

La nota de evolución escribe todo esto en texto: "TA 110/70 MMHG (PAM 83 MMHG) BAJO APOYO
VASOPRESOR CON NOREPINEFRINA A 11.4 MCG/KG/H (0.19 MCG/KG/MIN) (4 MG EN 100 ML A 20 ML/H) Y VASOPRESINA A 0.03
U/MIN (20 U EN 100 ML A 9 ML/H)" y "BAJO VENTILACIÓN MECÁNICA INVASIVA (MODO AC, FIO2 40 %, PEEP 8
CMH2O, VOLUMEN TIDAL 420 ML (6.4 ML/KG DE PESO PREDICHO), FR 16 RPM, PIP 24 CMH2O, PRESIÓN MESETA
20 CMH2O, PRESIÓN DE DISTENSIÓN 12 CMH2O, RELACIÓN I:E 1:2)".

## Cuentas, permisos y registro de actividad (octubre 2026)

Cada persona entra con **su propio correo y contraseña** (Supabase Auth). Solo entran las cuentas que
el administrador tiene **activas** en 👥 Usuarios: la base de datos rechaza cualquier lectura o
escritura de una cuenta bloqueada o sin registro, aunque tenga sesión abierta. El robot de labs y la
hoja del censo no cambian (usan la llave de servicio).

### 👥 Usuarios (solo el administrador)

Botón **👥 Usuarios** en la cabecera (solo lo ve el administrador).

- **➕ Dar acceso a alguien**: correo, nombre y rol → se crea la cuenta y aparece una **contraseña
  temporal** una sola vez (12 caracteres, ya copiada): mándasela por WhatsApp y borra el mensaje después.
  Entra con su correo y esa contraseña y **la app le pide una nueva antes de seguir** (la ventana 🔑 no se puede
  cerrar hasta cambiarla; desde el 27 oct 2026).
- Por cuenta: **🔑 Contraseña temporal** (la anterior deja de servir), **🔗 Enlace** (copia un enlace de
  recuperación que vale 1 hora: al abrirlo la app pide la contraseña nueva), **📧 Correo** (Supabase
  manda ese enlace por correo; ver SMTP abajo), **✏️ Nombre**, **⬆️ Hacer admin / ⬇️ Quitar admin**,
  **⛔ Bloquear / 🔓 Activar** (bloqueado no puede ni iniciar sesión), **📅 Fin de rotación** (fecha hasta la que
  tiene acceso) y **🗑 Borrar** (su actividad anterior se conserva).
- Avisos en la lista (27 oct 2026): **rotación terminada** (ya pasó su 📅), **sin uso 30+ días** y **🔑 contraseña
  temporal** (aún no la cambia). Arriba aparece un recuadro con cuántas hay que revisar.
- Nadie puede cambiarse a sí mismo el rol ni el estado desde fuera del panel: la base solo deja que cada cuenta
  cambie su nombre (antes una cuenta podía hacerse administradora con una petición directa; se cerró el 27 oct 2026).
- El administrador no puede bloquearse, borrarse ni quitarse el rol a sí mismo.
- **Sin registro**: cuentas creadas a mano en el panel de Supabase; aparecen con **✅ Dar acceso**.
- **📱 Versiones** (28 oct 2026): cada iPad, celular o computadora reporta la versión de la app que tiene, al abrirla y
  cada hora: quién, qué equipo («iPad · Safari 17.6 · ícono»), versión y cuándo. Arriba dice si **todos los
  dispositivos usados en los últimos 7 días** tienen la versión publicada o cuántos siguen con una vieja.
  - **Úsalo antes de apagar el acceso público de Realtime:** solo cuando diga ✅.
  - Uno con versión vieja: ábrelo y toca «Actualizar» en el aviso de versión nueva, o recarga.
  - No guarda nada de pacientes. La tabla es `pl_dispositivos` (`scripts/supabase_dispositivos.sql`, ya aplicada) y
    solo la lee el administrador.

### Cuando alguien se va del servicio (rotación, egreso)

El mismo día, el administrador:

1. 👥 Usuarios → su cuenta → **⛔ Bloquear** (no borrar: su actividad se conserva).
2. Hoja del censo (Google Sheets) → Compartir → quitarlo. Doc "INDICACIONES HOSPITALIZACION" →
   Compartir → quitarlo.
3. Pedirle que en su iPad y celular cierre sesión y **borre los datos del sitio** (iPad/iPhone:
   Ajustes → Safari → Avanzado → Datos de sitios web → `pisolibro.pages.dev` → Eliminar; Android:
   Chrome → ⋮ → Configuración → Configuración de sitios → Datos del sitio) y quite el icono de la
   pantalla de inicio. 🚪 Salir **no** borra la copia local de los pacientes.
4. Si conocía el token del ayudante de IA (⚙️ Config → desplegar «🔧 Worker proxy (legacy /
   avanzado)» → 🔑 Token de Acceso → Guardar; el campo está oculto hasta desplegar esa sección),
   cambiarlo: pasos en `scripts/SECURITY_NOTES.md` (`ACCESS_TOKEN`).
5. Sacarlo del grupo donde se mandan las contraseñas temporales.
6. Si era el dueño de la cuenta de WinLab o del visor que usan los robots, ver "Cuentas que usan
   los robots".

### Cuando alguien llega

1. 👥 Usuarios → **➕ Dar acceso**: correo, nombre y rol; mandarle la contraseña temporal (la app le pide una
   nueva al entrar) y ponerle su **📅 Fin de rotación**.
2. Explicarle **tres reglas**: código de bloqueo en el iPad y el celular; la cuenta es personal y
   no se presta; no se mandan capturas de pantalla con pacientes por WhatsApp.
3. Enseñarle dónde está este manual (`MANUAL-OPERACION.md` en GitHub) y las secciones "Si los
   laboratorios no llegan" y "Recuperar la contraseña".
4. Acceso a la hoja del censo y al Doc solo si los va a editar.

### Revisión mensual de cuentas

Una vez al mes, y en cada cambio de rotación, el administrador abre 👥 Usuarios: el recuadro de arriba y las
etiquetas **rotación terminada** y **sin uso 30+ días** dicen a quién revisar. **Bloquea** esas cuentas y las
creadas hace más de una semana que nunca han entrado (🔓 Activar las repone si la persona regresa). Ponerlo en el
calendario del servicio junto con la fecha de cambio de rotación.

### 🕵️ Actividad

Pestaña **Actividad** del mismo panel: cada cambio guardado en la nube con **quién** (nombre y
cuenta), **desde dónde** (nombre del dispositivo, navegador e IP) y **qué** (cama, paciente y cada
campo con "de → a", incluidas las claves del checklist). Filtros por persona, cama y días; lo que
hacen el robot de labs y la hoja del censo sale como 🤖. Tabla `audit_log`, disparadores en pacientes,
notas, No olvidar, procedimientos, guardia y configuración. **Cuánto se guarda** (19 oct 2026,
`scripts/supabase_audit_acotado.sql`, cron `audit-log-purge`): las versiones de texto de las cajas y del DX,
**365 días**; las reescrituras automáticas de labs e imagen (solo conteos), **30 días**; todo lo demás,
**180 días**. Una racha de tecleo de la misma persona en la misma caja (guardados a menos de 5 min, sin
borrar 40 letras o más) se guarda como UNA versión (de lo que había antes → a lo último); un borrado
siempre abre una versión nueva, así que el texto previo a un borrado nunca se pierde.

### 👤 Mi cuenta (todos)

Nombre (se guarda en la cuenta y se usa en todos tus dispositivos: iniciales en las cajas y en la
actividad), **nombre de este dispositivo** (p. ej. "iPad de Gera", así sale en "desde dónde") y
**🔑 Cambiar contraseña** (mínimo 12 caracteres; puede ser una frase corta).

### Recuperar la contraseña (tres caminos)

1. **¿Olvidaste tu contraseña?** en la pantalla de entrada: Supabase manda un enlace al correo
   (requiere el SMTP de abajo). Al abrirlo, la app pide la contraseña nueva.
2. El administrador toca **🔗 Enlace** y te lo manda por WhatsApp (no necesita correo).
3. El administrador toca **🔑 Contraseña temporal** y te la dicta.

### Configuración en Supabase (una vez, 5 minutos)

1. **Authentication → URL Configuration**: Site URL `https://pisolibro.pages.dev`; en Redirect URLs
   agrega `https://pisolibro.pages.dev/**` (y `https://*--pisocirugiahgl.netlify.app/**` solo cuando
   la copia de Netlify se alinee; hoy no se usa). Sin esto, los enlaces de recuperación mandan a
   otra dirección.
2. **Authentication → Sign In / Providers → Email**: desactiva *Allow new users to sign up*. Nadie se
   registra solo (de todas formas, sin registro no ve nada).
3. **Correo gratis para "¿Olvidaste tu contraseña?"**: el correo integrado de Supabase es limitado
   (pocos por hora y, en la práctica, solo a correos del equipo del proyecto). Usa tu Gmail:
   Google → Seguridad → Verificación en 2 pasos → **Contraseñas de aplicaciones** → crea una para
   "Piso Libro". En Supabase → **Project Settings → Authentication → SMTP Settings** → *Enable
   custom SMTP*: Host `smtp.gmail.com`, Port `465`, User `gfdz1540@gmail.com`, Password = la
   contraseña de aplicación, Sender email `gfdz1540@gmail.com`, Sender name `Piso Libro`. Costo: $0
   (límite ~500 correos al día). Los caminos 2 y 3 funcionan sin esto.

### Si el administrador pierde su acceso

En Supabase → SQL Editor:

```sql
update public.app_users set role = 'admin', status = 'active' where email = 'gfdz1540@gmail.com';
```

## 💾 Espacio en la nube (octubre 2026)

La base de datos vive en el plan gratuito de Supabase, que tiene un **tope de 500 MB**. Si se llena,
Supabase deja la base en solo lectura: la app abre y muestra lo que hay, pero **deja de guardar** lo
que se escribe. Para que eso no sorprenda a nadie:

- **⚙️ Config → 💾 Espacio en la nube** muestra cuánto ocupa la base ("76 MB de 500 MB", con una
  barra), lo que más ocupa (laboratorios del robot `winlab_labs`, bitácora/historial `audit_log`,
  bitácora del censo `sync_log`, notas `notes`) y a qué hora se revisó. El dato lo da la función SQL
  `pl_tamano_base`; si la base aún no la tiene dice "sin dato".
- Cuando la base se acerca al tope (nivel **aviso**, amarillo) o ya está muy cerca (nivel **alto**,
  rojo) aparece una **franja arriba de la app**: "La base de datos va en X MB de 500: avisa al
  administrador". **Entendido** la oculta 24 horas en ese dispositivo (si sube de aviso a alto vuelve
  a salir). La app revisa al entrar y cada 6 horas, solo con red, y nunca se bloquea por esto.

Qué hacer el administrador cuando sale el aviso (en este orden):

1. **Correr la purga a mano** (normalmente corre sola de noche): Supabase → SQL Editor →
   `select jobname, command from cron.job;` muestra los trabajos programados; copia el comando del
   `audit-log-purge` (borra la bitácora vieja según su tipo: labs/imagen automáticos a los 30 días,
   cajas de texto a los 365, lo demás a los 180; ver "🕵️ Actividad → Cuánto se guarda") y el del
   `net-http-response-vacuum` (compacta la tabla de respuestas de pg_net) y ejecútalos. Después
   vuelve a abrir ⚙️ Config para ver si bajó.
2. **Revisar la retención de `winlab_labs`** (los laboratorios del robot son lo que más crece: entre
   100 y 340 renglones por semana). Si pasa de 100 MB, borrar los renglones de pacientes que ya
   egresaron hace más de 6 meses (antes de borrar, exportar la tabla desde Supabase → Table Editor →
   Export CSV y guardar el archivo en el Drive del servicio).
3. Si aun así sigue en aviso, **considerar el plan Pro de Supabase** (8 GB de base; se paga con
   tarjeta cada mes) o avisar a quien mantiene la app para cambiar el proyecto.

## Llaves y vencimientos (recordatorio 2 semanas antes)

Varias piezas dejan de funcionar en una fecha, o cuando alguien cambia su contraseña, sin ningún
aviso claro. Esta tabla es para anotar esas fechas y poner un **recordatorio en el calendario del
servicio 2 semanas antes** de cada una (título: "Renovar <llave> — Piso Libro", con el enlace a
esta sección). La guía completa de cada llave, dónde vive y cómo cambiarla el mismo día en todos
lados está en `scripts/SECURITY_NOTES.md`.

| Llave | Para qué sirve | Si vence, qué se nota | ¿Cuándo vence? | Vence el (llenar) | Cómo renovarla (resumen) |
|---|---|---|---|---|---|
| Token de GitHub del worker (`GITHUB_TOKEN` en Cloudflare) | Despierta al robot a la hora exacta y con 🔎 Buscar ahora | Los labs dejan de llegar a las 5:00, 12:30 y 20:07 y solo llegan una vez en la tarde; 🔎 Buscar ahora falla; `winlab_dispatch_log` con 502 | En la fecha elegida al crearlo (GitHub propone 30 días) | ________ | GitHub → token nuevo → Cloudflare → worker `piso-libro-ai` → `GITHUB_TOKEN` → Deploy → probar 🔎 Buscar ahora |
| Contraseña de aplicación de Gmail | Correo de "¿Olvidaste tu contraseña?" | El correo no llega; 🔗 Enlace y 🔑 Contraseña temporal siguen funcionando | Cuando se cambia la contraseña de la cuenta de Google o se apaga la verificación en 2 pasos | ________ | Google → Contraseñas de aplicaciones → nueva → Supabase → SMTP Settings |
| Token de Cloudflare (`CLOUDFLARE_API_TOKEN` en GitHub) | Publicar la app | El paso "Publicar en Cloudflare Pages" sale en rojo; la app se queda en la versión anterior | Solo si se le puso fecha al crearlo | ________ | Cloudflare → API Tokens → nuevo → GitHub → secret → Run workflow de "Deploy a Cloudflare Pages" |
| Contraseña de WinLab (`WINLAB_PASS`) | Robot de labs | Corrida en rojo con "Login fallido" | Según el hospital | ________ | WinLab → GitHub secret → "WinLab corrida en seco" |
| Contraseña del visor (`RIS_PASS`) | Robot de imagen | "RIS Imagen" en rojo al iniciar sesión | Según el hospital | ________ | Visor → Supabase `rpa_config` → "RIS Imagen" con `dry_run` |
| Contraseña de la base (`SUPABASE_DB_URL` en GitHub) | Respaldo nocturno de la base | "Respaldo de la base" en rojo (correo de GitHub); no hay artifact del día | Cuando alguien hace *Reset database password* en Supabase | — | Supabase → Connect → Session pooler → URI con la contraseña nueva → GitHub → secret `SUPABASE_DB_URL` → Run workflow |
| Clave de Gemini (`GEMINI_API_KEY` en Cloudflare) | Toda la IA (nota, labs de foto/PDF, lápiz → texto) | Todo lo de IA falla con «Token del Worker inválido o clave del ayudante de IA (Google Gemini) expirada» o con un HTTP 400/403 pelón (el worker devuelve el error de Google tal cual); 🤖 Nota IA cae al borrador sin IA con «La IA no respondió (HTTP …)». «…tuvo un problema» solo sale con errores 5xx (worker o Gemini caídos), no por la clave | No por fecha; lo que sí puede retirarse es el modelo que usa el worker | — | AI Studio → clave nueva → Cloudflare → Deploy. Si Google retira un modelo, el worker v6 usa solo el de respaldo; para cambiarlo sin tocar el código: Cloudflare → worker → Settings → Variables → `GEMINI_MODEL` (principal), `GEMINI_MODEL_RAPIDO` (lápiz) o `GEMINI_MODEL_RESPALDO` → Deploy. Antes de mover la clave a otra cuenta de Google, probar en el proyecto nuevo que el modelo responde |

Además, sin ser llaves: GitHub apaga los robots tras 60 días sin cambios en el repositorio (se
mantienen despiertos solos) y Supabase pausa el proyecto tras 7 días sin tráfico (hay un ping cada
3 días).

## Seguridad de cuentas, canales en vivo y versiones (27 de octubre de 2026)

- **Nadie puede hacerse administrador por su cuenta.** La regla «cada quien edita su fila» dejaba cambiar cualquier
  columna (rol, estado) con una petición directa a la base. Ahora cada cuenta solo cambia su nombre, su última
  conexión y la marca de contraseña temporal; rol y estado solo desde 👥 Usuarios. Se revisó: un solo administrador,
  el original. `scripts/supabase_cuentas_y_canales_27oct.sql`.
- **Respaldo del 20 oct sin candado.** Una tabla de respaldo con 7 notas tenía apagado RLS: cualquier sesión podía
  leerla o vaciarla. Ya está cerrada; junto con otros avisos del asesor de Supabase (funciones internas que se podían
  llamar desde fuera, funciones sin ruta fija). `scripts/supabase_seguridad_asesor_27oct.sql`.
- **Contraseña temporal obligatoria** y **📅 fin de rotación**: ver "Cuentas, permisos y registro de actividad".
  Ya está desplegada la función `admin-users` nueva (versión 3).
- **Canales en vivo privados.** El aviso de quién edita cada tarjeta, la guardia y el aviso de No olvidar viajaban por
  canales públicos. Desde la versión 2026.10.27-6 la app los abre privados y solo entran cuentas activas (si el
  privado falla, vuelve al público en esa sesión para no perder los avisos).
  - **Paso tuyo, cuando todos los iPads ya tengan la versión 2026.10.27-6** (aviso «versión nueva» aceptado):
    Supabase → Realtime → Settings → apagar **«Allow public access»** → Save. Mientras esté prendido, los canales
    públicos siguen existiendo para los iPads viejos.
- **Contraseñas filtradas.** El asesor de Supabase sugiere prender «Prevent use of leaked passwords» (Authentication →
  Sign In / Providers → Email), que rechaza contraseñas que ya aparecieron en filtraciones públicas. En el plan gratuito
  Supabase no lo ofrece (es de Pro); mientras, siguen el mínimo de 12 caracteres y la contraseña temporal obligatoria.
- **Protecciones vigiladas.** El vigilante (cada 2 h) revisa que sigan puestas las 59 protecciones de la base y queda
  en rojo si falta una (`scripts/supabase_salud_catalogo.sql`). Si se agrega o quita una protección a propósito,
  actualizar las listas de esa función.
- **Versión de los Apps Script.** `censo-sync.gs` y `registro-pacientes.gs` tienen una constante de versión
  (`CENSO_SYNC_VERSION`, `REGISTRO_VERSION`) que reportan a la base una vez al día; el vigilante avisa en amarillo si
  la instalada no es la del repositorio («falta pegar») o si un script deja de reportar. **Al cambiar uno de esos
  archivos, sube su constante.**
- **Bitácora del censo con plazo.** `sync_log` (avisos del script del censo: expediente, camas y nombres) se guarda 90
  días (`sync-log-purge`, 04:47). La Papelera y los archivos (PDF, fotos) se conservan a propósito: la Papelera
  alimenta el registro de investigación y lo que se borre ahí queda en `archive_eliminados`.

### Worker v6: modelo de IA por tarea y de respaldo

- Leer lo escrito con el lápiz (una palabra o un número) usa un modelo **rápido** (`gemini-2.5-flash`, sin
  razonamiento); notas, documentos, fotos de notas y Labs masivo siguen en el **grande** (`gemini-2.5-pro`).
- Si un modelo responde que fue retirado (404), que se acabó la cuota (429), que está saturado (5xx) o que no admite
  la configuración (400), el worker reintenta **una vez** con el otro. Una llave rechazada (401/403) no se reintenta.
- Los modelos se cambian sin tocar el código: variables `GEMINI_MODEL`, `GEMINI_MODEL_RAPIDO`, `GEMINI_MODEL_RESPALDO`.
- También deja usar la IA desde el espejo de Netlify (`https://pisocirugiahgl.netlify.app`).
- Incluye la ruta `/api/scrape-ris` de v5. **Paso tuyo:** pegar `cloudflare-worker/index.js` en `piso-libro-ai` →
  Deploy. Probar: ✍️ escribir un número con el lápiz y 🤖 Nota IA en un paciente.

### Estudio de imagen de otra persona: «🚫 No es de este paciente»

Si el robot del RIS trae a una tarjeta un estudio que no es de ese paciente (nombre parecido, expediente corregido),
el botón **🚫 No es de este paciente** de ese estudio lo oculta de la tarjeta, de la vista 📤 Entrega y de la nota. No
se borra: **👁 Mostrar ocultos** lo enseña atenuado y **↩ Sí es de este paciente** lo regresa. La lista viaja con la
nota a todos los iPads y deja un paso en ↩ Regresar. Para los labs de WinLab de otra persona: ponle a la tarjeta su
**nombre en WinLab** (el robot deja de traer los del homónimo) y quita los labs equivocados con ✕ en esa fecha.

## Plan B si los robots no pueden entrar, y la cuenta que usan (27 de octubre de 2026)

**La cuenta.** El robot de labs entra a WinLab y el de imagen al RIS con el usuario de una persona. WinLab usa los
secrets `WINLAB_USER` y `WINLAB_PASS` de GitHub; el RIS usa `RIS_USER` y `RIS_PASS` en la tabla `rpa_config` de
Supabase. Para cada búsqueda, el hospital ve a esa persona.
- Anota en un lugar privado de quién es cada cuenta y cuándo vence su contraseña.
- Pide por escrito a Informática una cuenta solo de consulta para el robot, a nombre del servicio. Si no la dan, que
  el dueño de la cuenta y la jefatura firmen que se usa así, y revísalo en cada rotación.
- **El día que cambie la contraseña**, cámbiala en el mismo lugar (GitHub → Settings → Secrets, o `rpa_config`) y lanza
  una corrida de prueba. Si el robot dice «Login fallido», casi siempre es eso.

**Si el hospital cierra el acceso desde fuera.** Los robots corren en computadoras de GitHub, fuera del hospital, y
entran por internet. Si un día no pueden entrar (el vigilante avisa por correo):
1. Mientras tanto, cada tarjeta tiene **📄 PDF / 📷 Foto**: lee la hoja de laboratorio con IA y la guarda. Para varios a
   la vez, **⋯ Más → 📦 Labs Masivo**.
2. Habla con Informática: pregunta si el acceso externo seguirá permitido o si prefieren que el robot corra dentro de
   la red del hospital.
3. Si lo prefieren dentro: una computadora del servicio siempre encendida puede ser el «runner» propio de GitHub (la
   máquina que corre el robot). Se registra en GitHub → Settings → Actions → Runners y se cambia `runs-on` en los dos
   flujos de los robots. Pruébala primero con una corrida en seco (`winlab-dryrun.yml`).

## Si un paciente no tiene labs: el nombre no coincide con WinLab (octubre 2026)

El robot busca a cada paciente en WinLab por apellidos y nombre. Si la hoja del censo trae un
error de dedo (cama 3-181: dos letras invertidas en el apellido paterno), WinLab no devuelve nada. Desde octubre de 2026:

1. **El robot prueba más variantes**: apellidos completos, Ñ/N, orden invertido, paterno + nombre y
   ahora también **materno + nombre** (tolera el error en el paterno). Al identificar al paciente
   acepta diferencias de una o dos letras (letras invertidas, una letra de más o de menos) y exige edad compatible.
2. **La tarjeta te dice qué pasó**: en la sección de labs aparece "🤖 El robot no encontró a este
   paciente", qué buscó y a qué hora, y los nombres parecidos que WinLab listó. **Toca el correcto**
   y queda como *nombre en WinLab* del paciente (se guarda en la nota, también sin red; la hoja del
   censo no lo pisa). También puedes escribirlo con **✏️ Nombre en WinLab** en el formato
   `APELLIDOS, NOMBRE` (con coma), tal como aparece en WinLab.
3. **🔎 Buscar ahora** (también en el menú ⋯ de la tarjeta: 🤖 Pedir labs al robot) pide al robot
   una corrida solo para ese paciente: tarda 2-4 minutos y la tarjeta se actualiza sola ("encontrado
   como …"). Necesita internet; sin red, el nombre fijado se usa en la siguiente corrida automática
   (5:00, 12:30 y 20:07). Sirve desde el iPad, que no puede abrir la página de WinLab.
4. **Mientras tanto**: 📄 PDF / 📷 Foto en la sección de labs lee la hoja impresa o la pantalla con
   IA y guarda los valores en la tarjeta.

Lo que el robot encuentra o no por paciente queda en la tabla `winlab_match` (qué buscó, nombres
vistos, "encontrado como", hora); el alias vive en `notes.checklist.winlab_alias`. La corrida dirigida
usa el input `exp` del workflow `winlab-scraper.yml` (`WL_TARGET_EXP`), que el worker manda cuando la
app llama `/api/scrape` con `{"exp": "…"}`. Para que el botón dispare la corrida dirigida (y no una
completa) hay que pegar el `cloudflare-worker/index.js` actualizado en el worker `piso-libro-ai`.

## Si un paciente desapareció del censo

1. En la app, abre la pestaña **Papelera**.
2. Pulsa **☁️ Cargar desde nube**. Aparecen los pacientes que salieron del
   censo (por egreso, por el Excel o por la hoja), cada uno con su nota.
3. Pulsa **↩ Restaurar** en el paciente. Vuelve al censo con su nota.

## Respaldo nocturno de la base (octubre 2026)

Supabase (plan gratuito) **no guarda copias** de la base: si el proyecto se borra, se pausa sin
remedio o alguien corre un `UPDATE` equivocado, los pacientes, las notas y los labs se pierden.
Desde octubre de 2026 el workflow **"Respaldo de la base"** (`.github/workflows/db-backup.yml`)
hace cada noche a las **02:20 (hora de León)** una copia completa de la base, la **cifra** y la
guarda fuera de Supabase:

- **Dónde queda**: GitHub → repo → **Actions** → **Respaldo de la base** → corrida del día → al
  final, **Artifacts** → `respaldo-db-AAAAMMDD-HHMM`. Se conserva **30 días** (cada noche entra uno
  nuevo y los de más de 30 días se borran solos). Opcional: también en una carpeta privada de Google
  Drive (ahí se guardan 90 días).
- **Cifrado**: el archivo solo lo puede abrir el administrador con su **llave privada**. Ojo: el
  repo es **público**, así que el artifact y el registro de la corrida los puede bajar **cualquiera**
  con cuenta de GitHub. Lo único que protege los datos es el cifrado: por eso nunca se sube nada en
  claro, el registro solo muestra números (nunca nombres) y la llave privada no sale de la Mac/USB.
- **Egreso de Supabase**: cada respaldo saca del proyecto más o menos lo que pesa la base (el plan
  gratuito da **5 GB al mes**). Por eso el respaldo deja fuera las filas de `sync_log` (bitácora del
  censo, se regenera sola). Una vez al mes mira Supabase → Settings → **Usage** → *Egress*: si va
  por más de ~3 GB, cambia en `db-backup.yml` el cron a noches alternas (`"20 8 */2 * *"`).
- **Cómo saber que corrió**: en esa lista debe haber un círculo verde cada día. Si sale rojo, GitHub
  manda el correo de "workflow failed" al dueño del repo; el paso rojo dice la causa (lo más común:
  cambió la contraseña de la base). El resumen de cada corrida dice el tamaño y cuántas filas tenían
  pacientes, notas, labs del robot y bitácora (solo números, nunca datos de pacientes).
- **Cómo restaurar** (siempre en un proyecto nuevo, nunca sobre producción) y el **simulacro
  mensual**: `scripts/db-restore.md`.

**Configuración (una vez, 15 minutos, el administrador en su Mac)**

1. **Llave de cifrado**: en Terminal, `brew install age` y luego
   `age-keygen -o ~/Documents/piso-libro-llave.txt`. Imprime una línea `Public key: age1…`: esa es
   la parte **pública** y va a GitHub. El archivo `piso-libro-llave.txt` es la **privada**: cópialo a
   una USB y a una nota segura (1Password / Notas con candado) y **no lo subas a ningún lado**
   (ni al repo, ni a GitHub, ni al chat). Sin esa llave los respaldos no se pueden abrir; sin la
   pública, el workflow no sube nada.
2. **URL de la base**: Supabase → proyecto → botón **Connect** (arriba) → pestaña **Session pooler**
   → copia la URI `postgresql://postgres.vkxplmrzyqlamxpbtmes:[YOUR-PASSWORD]@aws-0-….pooler.supabase.com:5432/postgres`
   y cambia `[YOUR-PASSWORD]` por la **contraseña de la base** (Project Settings → Database →
   *Database password*; si no la sabes, **Reset database password** ahí mismo). No es la
   `service_role` key ni la contraseña de tu cuenta. Si la contraseña lleva símbolos (`@`, `#`,
   `/`…), mejor cámbiala por una solo con letras y números para no tener que codificarla en la URL.
3. **Secrets en GitHub**: repo → Settings → Secrets and variables → Actions → **New repository
   secret**: `SUPABASE_DB_URL` (la URI completa del paso 2) y `BACKUP_AGE_PUBLIC_KEY` (la línea
   `age1…` del paso 1).
4. **Probar**: Actions → Respaldo de la base → **Run workflow**. En 2-3 minutos debe salir verde y
   el artifact abajo. Luego sigue los pasos 1 y 2 de `scripts/db-restore.md` para comprobar que tu
   llave lo abre (si no, repite el paso 1).
5. **Opcional, copia a Google Drive**: `brew install rclone`, `rclone config` → *New remote*, nombre
   `gdrive`, tipo `drive`, scope `drive.file` (solo ve los archivos que él mismo sube), inicia sesión
   en el navegador con la cuenta del administrador. Después `cat ~/.config/rclone/rclone.conf` y pega
   ese texto completo en el secret `RCLONE_CONFIG`; si quieres otra carpeta, secret
   `BACKUP_GDRIVE_DIR` = `gdrive:NombreDeLaCarpeta` (por defecto `gdrive:PisoLibro-respaldos`).
   Sin ese secret el paso se omite y el respaldo de GitHub queda igual.

| Simulacro (primer lunes del mes) | Resultado | Quién |
|---|---|---|
| ________ | ________ | ________ |

## Si algo sale muy mal con las notas de laboratorio

El 9 de octubre de 2026 se hizo una limpieza de valores erróneos (pH y
hemoglobina de orina guardados como sangre). Antes de tocar nada se guardó una
copia completa en la tabla `notes_lab_history_backup_20261009` de Supabase.
Para volver a como estaba, en Supabase → SQL Editor:

```sql
update notes n set lab_history = b.lab_history
from notes_lab_history_backup_20261009 b where b.patient_id = n.patient_id;
```

## ¿Dónde vive cada cosa en el repositorio?

| Carpeta / archivo | Qué es |
|---|---|
| `index.html` | Toda la app (un solo archivo) |
| `version.json` | La versión publicada; la compara el aviso 🔄 con `PL_BUILD` de `index.html` (se suben juntas en cada cambio) |
| `apps-script/censo-sync.gs` | El programa de la hoja del censo (se pega a mano en Google) |
| `rpa/` | El robot de laboratorios (WinLab → Supabase) |
| `.github/workflows/winlab-scraper.yml` | Los horarios y la configuración del robot |
| `.github/workflows/winlab-dryrun.yml` | La corrida en seco del domingo (prueba que el robot aún puede entrar a WinLab) |
| `.github/workflows/ris-scraper.yml` | El robot de imagen (visor RIS → Supabase) |
| `.github/workflows/labs-watchdog.yml` | El vigilante que avisa si los labs llevan más de 26 h sin llegar |
| `.github/workflows/db-backup.yml` | El respaldo nocturno cifrado de la base (02:20 León; artifact de 30 días) |
| `scripts/db-restore.md` | Cómo abrir y restaurar ese respaldo en un proyecto nuevo, y el simulacro mensual |
| `.github/workflows/ci.yml` | Las pruebas que corren en cada PR y antes de publicar |
| `.github/workflows/deploy-pages.yml` | Cómo se publica la app en Cloudflare (solo si pasan las pruebas) |
| `cloudflare-worker/` | El ayudante de IA (extraer labs de PDF, disparar el robot) |
| `scripts/supabase_rls_current.sql` | La configuración de seguridad vigente de la base de datos |
| `scripts/SECURITY_NOTES.md` | Qué llaves existen y qué hacer si se filtra alguna |
