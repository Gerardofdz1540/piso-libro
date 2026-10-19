# vendor/ — librerías empaquetadas con la app

Desde oct 2026 la app no carga nada de CDNs externos (unpkg, cdnjs, jsdelivr): en redes móviles y
con portales cautivos esos dominios se bloqueaban y la página se quedaba en blanco. Las librerías
viven aquí, en el mismo origen, y `sw.js` las precachea para que la app abra sin conexión.

- `index.html` carga `supabase-*.js` en la cabecera (hace falta al arrancar) y las demás solo al
  usarlas, por nombre de archivo, en `window._libLoad` (mapa `SRC`).
- `sw.js` las lista en `SHELL` (supabase, obligatoria) y `OPTIONAL` (Excel y Word, "a la mejor").
- Los nombres llevan la versión porque el SW las sirve *cache-first* como inmutables: un archivo con
  el mismo nombre y otro contenido nunca llegaría al iPad.
- Cloudflare Pages (`.github/workflows/deploy-pages.yml`) y Netlify (`netlify.toml`) publican la
  carpeta tal cual; no hay paso de build.

## Inventario

Copias byte a byte del origen (verificadas con `sha256sum`; el hash del origen se bajó de nuevo y
coincide). Fecha = día en que se bajó el archivo.

| Archivo | Librería y versión | Origen (URL exacta) | Fecha | sha256 |
|---|---|---|---|---|
| `supabase-2.46.1.js` | supabase-js 2.46.1 (UMD, sin minificar) | https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.46.1/dist/umd/supabase.js | 14-oct-2026 | `423414e044fb0de7dec817257dfa7cda65bafdd4ae7d90e25a7314b37e3b37c0` |
| `xlsx-0.20.3.full.min.js` | SheetJS CE 0.20.3 (lee Excel: censo y planes; exporta el censo) | https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js | 19-oct-2026 | `cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41` |
| `exceljs-4.4.0.min.js` | ExcelJS 4.4.0 (escribe Excel con formato) | https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js | 14-oct-2026 | `7e49da68588e250dbb8bba190d2caa8ab3787cc0284bda1d8b2f805c4df742c9` |
| `docx-8.5.0.umd.js` | docx 8.5.0 (UMD, sin minificar; genera Word) | https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js | 14-oct-2026 | `02d568d203c0180af37609bcf5ff6c0919d220f933a88ca896eba0556a08faad` |

Para comprobar lo que hay en el repo: `sha256sum vendor/*.js` y comparar con la tabla.

Historial:

- 19-oct-2026: SheetJS 0.18.5 → 0.20.3. La 0.18.5 (que venía de
  `https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js`, sha256
  `c9506197caf809a075b6dee1da0d36fb19da7158ffe8a88e7b0c96c5d8623c99`) tenía fallas conocidas al
  leer un archivo manipulado (CVE-2023-30533, contaminación de prototipos; CVE-2024-22363, ReDoS).
  SheetJS ya no publica versiones nuevas en npm ni en cdnjs: el origen oficial es `cdn.sheetjs.com`.
  Se probó en Node que la 0.20.3 lee un xlsx escrito por ella misma y uno escrito por ExcelJS con
  las mismas opciones que usa la app (`type: "array", cellDates, cellStyles`, `sheet_to_json`).
- 14-oct-2026: primera copia de las cuatro librerías (antes se cargaban de cdnjs / jsdelivr).

## Cómo actualizar una librería

Nunca se sobrescribe un archivo: se agrega el nuevo con la versión en el nombre y se borra el viejo.

1. **Bajar** del origen oficial, con la versión en el nombre (ejemplo con SheetJS):
   `curl -fsSL -o vendor/xlsx-0.20.3.full.min.js https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js`
   Origen por librería: SheetJS en `cdn.sheetjs.com`; supabase-js, ExcelJS y docx en
   `cdn.jsdelivr.net/npm/<paquete>@<versión>/...` (misma ruta que en la tabla, cambiando la versión).
2. **Comprobar** que es la versión esperada (`grep -o 'version="0.20.3"' vendor/xlsx-0.20.3.full.min.js`,
   o la cadena de versión que traiga cada librería) y anotar `sha256sum vendor/<archivo>` en la tabla,
   con la fecha y la URL exacta. Si se puede, probarla en Node antes de tocar la app (`require` del
   archivo y una ida y vuelta: escribir un xlsx y leerlo).
3. **index.html**: cambiar el nombre en el mapa `SRC` de `window._libLoad` (xlsx, exceljs, docx) o en el
   `<script src="vendor/supabase-...">` de la cabecera.
4. **sw.js**: cambiar el nombre en `SHELL` u `OPTIONAL` **y subir `VERSION`** (`pisolibro-vN` → `vN+1`).
   Sin subir la versión, los iPads que ya tienen el SW instalado siguen con la caché vieja.
5. **Borrar** el archivo anterior de `vendor/` y revisar que nada más lo nombre (`grep -rn <nombre-viejo>`
   fuera de `node_modules`).
6. **Probar**: `node tests/headless/syncheck.js index.html` y la batería `tests/headless/run_all.sh`
   (al menos `app_import`, `app_offline` y `noCdn`, que cubren importar Excel, el precache del SW y que
   no haya CDNs). Después, en un iPad con la versión publicada: importar un censo y un archivo de planes
   reales, exportar el censo a Excel y confirmar que la caché nueva (`pisolibro-vN+1`) ya está.
7. Anotar el cambio en el historial de arriba.
