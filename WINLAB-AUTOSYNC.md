# 💧 WinLab Auto-Sync — Documentación técnica

## Resumen ejecutivo

Sistema completo que conecta los laboratorios scrapeados de WinLab con los
campos tipados de la tarjeta de paciente en PisoLibro. Antes de este trabajo,
los labs quedaban en `winlab_labs.data` como JSON crudo con la lista de
reportes (no con valores reales) y nunca se mostraban en la UI.

Ahora, después de:
1. **Descubrir** la arquitectura real de WinLab (frameset + PDF)
2. **Implementar** descarga + parseo del PDF generado por WinLab
3. **Conectar** los valores extraídos con los campos tipados del cliente
4. **Defense in depth** contra datos corruptos

…los labs aparecen automáticamente en cada tarjeta sin intervención manual.

---

## Arquitectura real de WinLab (descubierta May 2026)

Cuando un médico hace click en el icono "Rep." de un paciente en WinLab:

```
[Pestaña original: lista de búsqueda por apellido]
            │
            │ click en icono "Rep." de paciente RAMIREZ JARAMILLO
            ▼
[Nueva ventana: RefertiSel.htm]
            │
            │ <frameset rows="100,*">
            ├─ frame "header" → RefertiSelHeader.aspx (toolbar)
            └─ frame "main"   → EditPDF.aspx?FileName=../Temp/<hash>/<uuid>.pdf
                                       │
                                       │ servidor genera PDF on-the-fly
                                       ▼
                              [PDF binario con tabla de valores]
```

El bug del scraper original: nunca cambiaba al contexto de la nueva ventana,
parseaba la página de búsqueda como si fuera detalle. Resultado: `valores`
contenía códigos de reporte (`2605221486`) y fechas (`22/05/2026 14:11`)
en lugar de Hb=11.2, Leu=8.4, etc.

---

## Solución implementada

### Pipeline completo

```
[GitHub Actions cron 13:15 CST]
        ↓
rpa/scraper.js — login WinLab → buscar paciente → click "Rep." → POPUP
        ↓
ctx.waitForEvent("page") detecta nueva ventana
        ↓
rpa/pdf-extract.js::findPdfFrameUrl()
  busca frame con EditPDF.aspx?FileName=*.pdf
        ↓
ctx.request.get(pdfUrl) — descarga con cookies de sesión
        ↓
rpa/pdf-extract.js::parsePdfToLabValues(buffer)
  ├─ PDFParse.getText() → texto plano (pdf-parse@2.4.5)
  └─ extractLabValuesFromText() → regex línea por línea
        ↓
Array<{estudio, valor, unidad, referencia}>
        ↓
Upsert masivo a winlab_labs.data.reportes[].valores[]

[Cliente PisoLibro]
        ↓
refreshWinlabLabs() carga winlab_labs → winlabByExp
        ↓
applyWinlabSyncToPatients() para cada paciente:
  ├─ findWinlabRowForPatient(p) — match por exp con variantes
  ├─ mapWinlabReportesToLabs() — aliases regex (48 campos)
  │   └─ isWinlabGarbageEstudio() — defense in depth
  └─ Merge en notes.lab_history (manual gana sobre WinLab)
        ↓
renderLabSection() — campos tipados llenos automáticamente
```

### Tres capas de defensa

1. **VÍA PRINCIPAL (PDF)**: descarga + parseo
   - Confiable porque el PDF es server-generated y estructura es consistente
   - 95%+ de éxito esperado

2. **FALLBACK 1 (DOM scrape)**: si el PDF falla (frame no carga, HTTP error)
   - Heurística vieja que escanea tablas HTML
   - Solo activo si vía PDF retorna []

3. **DEFENSE IN DEPTH (cliente)**: `isWinlabGarbageEstudio()`
   - Rechaza estudios que parecen fechas/códigos/servicios
   - Protege contra regresiones futuras del scraper

---

## Archivos del fix

| Archivo | Líneas cambiadas | Propósito |
|---|---|---|
| `rpa/pdf-extract.js` | +141 (nuevo) | Módulo aislado de parsing PDF (testeable sin Playwright) |
| `rpa/scraper.js` | +50 / -45 en `drillDownReport` | Vía PDF + popup detection + cleanup |
| `rpa/package.json` | +1 dep | `pdf-parse@^2.4.5` |
| `rpa/pdf-extract.test.js` | +120 (nuevo) | 50 tests del módulo PDF (incluyendo PDF binario real) |
| `rpa/drilldown.test.js` | +60 (nuevo) | 28 tests del flujo drilldown completo |
| `rpa/test-fixtures/winlab_sample.pdf` | +1.5KB (nuevo) | PDF de muestra para tests reproducibles |
| `index.html` | +19 líneas | `isWinlabGarbageEstudio()` + filtro en mapper |
| `WINLAB-AUTOSYNC.md` | +200 líneas (este) | Documentación técnica completa |

---

## Tests (142 pasan offline, sin Playwright ni red)

```bash
cd rpa && npm test
```

| Suite | Tests | Cobertura |
|---|---|---|
| `scraper.test.js` | 64 | dedup, isAllowedEsp, formatDate, isMenuTableText, isMeaningfulReportRow, extractApellidos, expVariants |
| `drilldown.test.js` | 28 | regression guards: hooks correctos en código, regex PDF URL, FileName extraction, anti-confusión |
| `pdf-extract.test.js` | 50 | extractLabValuesFromText (edge cases, multi-formato), parsePdfToLabValues con PDF binario real (14 estudios) |

---

## Edge cases manejados

| Caso | Comportamiento |
|---|---|
| Popup no abre (instalación distinta) | Fallback a DOM scrape en `page` original |
| Popup abre pero sin PDF | Fallback a DOM scrape en `detailPage` |
| Frame con PDF tarda en cargar | Reintenta hasta 10 veces con 500ms entre cada |
| Descarga PDF retorna HTTP 4xx/5xx | Log y fallback a DOM scrape |
| PDF protegido (`OffuscaPDF=True`) | `pdf-parse` lanza `PasswordException`; retorna [] sin crashear |
| PDF corrupto o no-PDF | `pdf-parse` lanza error; retorna [] sin crashear |
| Texto extraído tiene líneas de ruido | `PDF_NOISE_PATTERNS` filtra 26 patterns conocidos |
| Línea parece lab pero empieza con dígito | Sanity check rechaza |
| Cliente recibe basura del scraper | `isWinlabGarbageEstudio()` filtra (defense in depth) |
| Manual edit vs WinLab refresh | Manual gana SIEMPRE; WinLab solo llena vacíos |

---

## Activación

### Primera vez
1. Aplicar archivos (ver `INSTRUCCIONES_APLICAR.md`)
2. Push a `feature/winlab-auto-sync`
3. Crear PR, mergear a main cuando validemos
4. Próximo cron 13:15 CST corre con el fix

### Uso diario (médico)
1. Abrir PisoLibro
2. Click DERECHO en "💧 Auto OFF" → activa auto-sync persistente
3. Cada vez que recarga, sync corre automático
4. Click IZQUIERDO en "💧 Auto ON" → sync manual on-demand

### Desactivar
- Click DER en "💧 Auto ON" → OFF
- O consola: `localStorage.removeItem("pl_winlab_auto_sync"); location.reload();`

---

## Plan de validación post-deploy

1. **Merge a main** → próximo cron 13:15 corre con el fix
2. **Verificar logs** del workflow en GitHub Actions:
   ```
   [drilldown] POPUP detectado: ...RefertiSel.htm...
   [drilldown] PDF detectado en frame: FileName=../Temp/.../uuid.pdf
   [drilldown] PDF descargado: 12345 bytes
   [drilldown] PDF parseado: 14 valores
   ```
3. **Hard refresh** PisoLibro post-13:30
4. **Click "💧 Auto ON"** — toast debe mostrar `XX/57 pacientes con labs`
5. **Abrir tarjetas** — campos Hb/Leu/Plaq/Cr llenos con valores REALES
6. **Editar manual** un campo → resync no lo sobrescribe (manual wins)

### Troubleshooting

Si paso 4 sigue dando 0 matches:
```javascript
// En consola del cliente:
const r = Object.values(winlabByExp)[0]?.data?.reportes;
copy(JSON.stringify(r?.find(x => x.valores?.length), null, 2));
```

Si paso 4 da X matches pero campos vacíos:
```javascript
const p = patients[0];
const wl = findWinlabRowForPatient(p);
console.log("Primer valor:", wl?.data?.reportes?.find(r => r.valores?.length)?.valores?.[0]);
```

---

## Decisiones técnicas tomadas

### ¿Por qué pdf-parse v2 y no pdfjs-dist o pdf2json?

| Opción | Pros | Contras | Decisión |
|---|---|---|---|
| `pdf-parse@^2.4.5` | API simple (1 línea), 14M downloads/sem, usa pdfjs internamente | Solo extracción (no edición) | ✅ Elegida |
| `pdfjs-dist` | Oficial Mozilla, control fino | API compleja, ~2MB | ❌ Overkill |
| `pdf2json` | Estructura JSON con coordenadas | API más verbosa | ❌ Innecesario para texto |
| `pdfreader` | Específico para tablas | Menos mantenida | ❌ Riesgo |

Solo necesitamos texto plano + regex. `pdf-parse` es lo más simple y robusto.

### ¿Por qué módulo separado pdf-extract.js?

- **Testeable sin Playwright**: tests offline corren en milisegundos
- **Reutilizable**: si en el futuro queremos parsear PDFs en otros flujos (subida manual, bulk import), ya está
- **Single responsibility**: `scraper.js` orquesta, `pdf-extract.js` parsea

### ¿Por qué conservar DOM scrape como fallback?

- Defensa contra cambios en WinLab (si en algún momento dejan de servir PDF)
- Si una instalación distinta de WinLab no usa frames, el DOM scrape cubre
- Costo: ~50 líneas más; beneficio: robustez ante regresiones

---

## Histórico de commits del branch

```
fix(scraper): descarga PDF + parseo con pdf-parse (vía principal)
fix(scraper): popup detection para detalle de reportes
fix(client): defense in depth contra estudios basura
fix(winlab-sync): match exp con variantes (con guion/sin/solo tail)
feat(labs): WinLab auto-sync mapper inicial
```

## Próximos pasos (futuras iteraciones)

1. **Badge "💧 WinLab" inline** en cada celda auto-llenada
2. **Toggle por paciente** (algunos pueden querer sólo manual)
3. **Audit log** de cambios de auto-sync con timestamp
4. **Health check automatizado**: alerta si N pacientes consecutivos retornan 0 valores
5. **Soporte multi-página**: si reportes muy largos generan PDFs con paginación
6. **PDFs protegidos**: implementar parser de PDF cifrado con password de servicio
7. **PoC con `getTable()`**: pdf-parse v2 tiene API específica para tablas; evaluar si mejora precisión
