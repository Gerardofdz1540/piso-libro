# Registro de pacientes para investigación (Google Sheets)

Copia diaria de **todo lo que la app y los robots tienen de cada paciente** a una hoja de cálculo privada en Google
Drive, para estudios y ensayos clínicos futuros. Entran los pacientes del censo, los egresados que guarda la Papelera, la
cronología, los labs y cultivos de WinLab, los estudios de RIS y los procedimientos programados.

```
Supabase ──GET, 1 vez al día──► Apps Script (proyecto aparte) ──► hoja «Registro de pacientes» en la carpeta privada
```

- **Código:** `apps-script/registro-pacientes.gs`.
- **Pruebas:** `node apps-script/registro-pacientes.test.js`. Usan datos ficticios y una hoja simulada tan estricta como
  Google; corren en CI.
- **Hoja:** «Registro de pacientes (se actualiza cada día)», en la carpeta «Registro de pacientes — Piso (investigación,
  PRIVADO)» del Drive del dueño. La carpeta no tiene permisos heredados.
- **Base:** el script solo **lee** (GET paginado). En el registro de ejecuciones escribe solo conteos, nunca nombres ni
  expedientes.

## Pestañas

| Pestaña | Una fila por… | Contenido |
|---|---|---|
| Pacientes | hospitalización (episodio) | **Censo:** nombre, expediente, edad, sexo, especialidad, adscrito, residente, cama.<br>**Estancia:** ingreso, egreso y motivo, días de estancia, dx, estado.<br>**Cajas:** APP, PA, manejo, pendientes, drenajes y dispositivos, antibiótico, cultivos, interconsultas, dieta y NPO, TVP, NPT, ventilación, vasopresores.<br>**Resúmenes:** cirugías, imagen, labs, Guardia vigente, Cronología.<br>**Respaldo:** nota y checklist completos en JSON, sin archivos. |
| Cirugías | cirugía | fecha, procedimiento, hallazgos, sangrado, cirujano · **Vigente** |
| Labs | fecha y estudio | valor como está en la tarjeta · **Vigente** |
| Imagen | estudio | fecha, tipo, descripción, enlace (solo http) · **Vigente** |
| Signos vitales | día | FC, FR, temp, SaO2, O2, TA, uresis, DxTx, IU, balance. La app guarda 14 días; aquí se acumulan todos. |
| Notas de evolución | nota | fecha y hora, autor, con IA o no, texto. La app guarda 10; aquí se acumulan. |
| Guardia y cronología | renglón | Cronología (de la nota y del respaldo de la base) y Guardia vigente · **Vigente** |
| Procedimientos programados | procedimiento | la lista del día de la app |
| Labs del robot (WinLab) | expediente, fecha y estudio | lo que capturó el robot, aunque no haya llegado a la tarjeta |
| Cultivos del robot (WinLab) | cultivo | tipo, germen, resultado |
| Imagen del robot (RIS) | estudio | modalidad, estudios, crítico, reporte, enlace (con su episodio) |
| Diccionario | — | qué es cada columna, última actualización, conteos y avisos |

- **Episodio:** el id del paciente en la base. Un reingreso crea otro id y por lo tanto otro episodio.
- **Restaurar desde la Papelera** crea otro id. La columna «Episodio relacionado» une las dos partes («Continúa en …» /
  «Viene de …»).
- **Censo y Papelera:** si el mismo episodio está en los dos, manda el censo y la Papelera rellena lo que le falte.
  Entre varias copias de la Papelera manda la más reciente y las anteriores rellenan.
- **Copia de la base:** cada copia de la Papelera se une con la que guardó la base al egresar (`_copia_base`), por si el
  equipo que dio el egreso tenía una copia vieja.
  - Una caja vacía toma la de la base.
  - Labs, imagen, cirugías, signos y notas se unen.
  - No reviven los labs borrados a propósito.

## Nunca borra

- Cada día se actualizan, por clave, las filas que hoy están en la base; lo demás se conserva.
  - **Vigente: No.** Lo que ya no está en la tarjeta (una cirugía corregida, un renglón quitado) se queda marcado así.
  - **Egresado depurado de la Papelera:** se queda con sus datos y con la fecha de la «Última vez en la base».
  - **Salió del censo sin pasar por la Papelera:** queda como «Salió de la base sin egreso registrado».
- **Escritura segura:**
  - Escribe encima sin vaciar antes; si Sheets falla a la mitad, la pestaña no queda vacía.
  - Agranda la cuadrícula si hace falta.
  - Si alguien renombró la columna clave de la fila 1, se detiene sin tocar nada y avisa.
- **Respaldo semanal:** antes de escribir, cada 7 días guarda una copia de toda la hoja en la misma carpeta y conserva
  las últimas 5. Las más viejas van a la papelera de Drive, que las guarda 30 días.
- **Lecturas incrementales y reanudables:**
  - La Papelera, WinLab y RIS se leen por cursor, desde 2 días antes de lo último leído. Hay un tope por corrida (400,
    5000 y 3000 filas). Si quedan filas, escribe lo leído y programa una continuación en 10 min, así la primera carga
    termina en varias vueltas.
  - Los cursores avanzan solo cuando lo leído ya quedó escrito.
  - El censo, las notas, la cronología, los cultivos y los procedimientos se leen completos.
  - Si la lectura pasa de 4.5 min, no escribe nada y lo reintenta.
  - Si una respuesta es demasiado grande (archivos incrustados), pide menos filas por página.
- **Capacidad:** Sheets admite 10 millones de celdas por libro. El Diccionario muestra cuántas se usan y avisa al pasar
  del 70%. A ese ritmo, en aproximadamente un año habrá que pasar lo viejo a un libro histórico.
- **Al usar la hoja:**
  - Se pueden agregar columnas **a la derecha** y usar filtros; esas columnas se respetan.
  - No insertes columnas en medio ni renombres la fila 1.
  - Para analizar, mejor trabaja en una copia.

## Instalación (una vez, ~5 min)

Se recomienda un **proyecto aparte**, no ligado a la hoja. Así, aunque compartas la hoja, nadie más ve la llave de
Supabase.

1. Entra a <https://script.google.com> con la misma cuenta de Drive → **Nuevo proyecto**.
   Ponle nombre, por ejemplo «Registro de pacientes».
2. Borra lo que haya en `Código.gs`, pega **todo** `apps-script/registro-pacientes.gs` y guarda.
3. **Configuración del proyecto** (engrane):
   - Zona horaria: `America/Mexico_City`.
   - **Propiedades del script:**
     - `SUPABASE_KEY` = la *service_role key* (la misma que usa el script del censo).
     - `REGISTRO_SHEET_ID` = el id de la hoja del registro: lo que va entre `/d/` y `/edit` en su dirección.
4. En el editor elige `instalarRegistroDiario` → **Ejecutar** → autoriza (Sheets, Drive y conexión externa).
   Crea la actualización diaria (entre 23:00 y 24:00) y hace la primera copia completa, que puede tardar unos minutos.
5. Para copiar en cualquier momento, ejecuta `actualizarRegistro` desde el editor.

Opcionalmente, el script se puede ligar a la hoja (Extensiones → Apps Script, sin `REGISTRO_SHEET_ID`). Eso agrega el
menú **Registro → Actualizar ahora**, pero cualquiera con permiso de **editor** en la hoja podría ver la llave. En ese
caso, comparte la hoja solo como **lector**.

Si una corrida falla, el registro de ejecuciones muestra solo el error y la hoja queda como estaba.

## Privacidad y uso en investigación

- La hoja tiene **datos de salud identificables** (nombre y expediente).
  - Mantenla en la carpeta privada y no descargues copias a equipos compartidos.
  - Compártela solo como lector y solo con quien autorice el protocolo.
- Usar estos datos en un estudio o ensayo requiere un **protocolo aprobado por el Comité de Investigación y el Comité de
  Ética en Investigación** del hospital.
  - Marco: Reglamento de la Ley General de Salud en Materia de Investigación para la Salud; NOM-012-SSA3-2012.
  - El protocolo cubre el consentimiento informado, o su dispensa en estudios retrospectivos, y el resguardo de los
    datos personales sensibles (ley de protección de datos personales aplicable a la institución).
  - Lo usual es analizar una copia **seudonimizada** (sin nombre ni expediente) y guardar la llave aparte.
- La *service_role key* da acceso total a la base: solo va en Propiedades del script, nunca en la hoja ni en el código.
