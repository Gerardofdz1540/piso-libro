# 💧 WinLab Auto-Sync — Documentación

## Qué hace

Conecta la sección **manual de labs** (Hb, Leuc, Plaq, Cr, etc.) en cada tarjeta de paciente con los datos del scraper WinLab que se almacenan en `winlab_labs`. Antes, esos datos solo aparecían como dump JSON colapsable abajo; ahora se transforman a campos tipados y aparecen poblados automáticamente.

## Cómo activarlo (la primera vez)

1. Abre PisoLibro en el navegador
2. En el header, busca el botón nuevo: **💧 Auto OFF**
3. Haz **clic derecho** sobre el botón → toggle a **💧 Auto ON**
4. La app sincroniza inmediatamente. Verás un toast verde con el conteo de pacientes con labs auto-llenados.
5. A partir de aquí, **cada vez que se recargan datos de WinLab (cron 13:15 CST diario, o manual con click izquierdo en `🧪 Labs`), los campos se llenan solos.**

## Cómo usarlo en el día a día

- **Clic izquierdo en `💧 Auto ON`**: ejecuta sync ahora (sin esperar al cron).
- **Clic derecho**: toggle ON/OFF.
- Si editas un valor a mano después del sync, **tu edición se preserva** — el próximo sync NO la sobreescribe. Solo rellena campos vacíos.

## Reglas de merge (importante)

| Estado actual del snapshot | Lo que pasa con el resync |
|---|---|
| No existe snapshot para la fecha | Se inserta uno nuevo con `source='winlab'` |
| Existe snapshot con `source='winlab'` | Se actualizan todos los valores con los más recientes |
| Existe snapshot con `source='manual'` (porque tú editaste) | Solo se llenan campos **vacíos**. Tus valores manuales siguen ahí. |

## Qué campos se mapean

48 campos en 8 grupos:

- **Biometría/renal:** Hb, Leuc, Plaq, Cr, Urea, Glu, Na, K, Alb, PCR, PCT, Lac
- **Electrolitos:** Mg, Ca, P, Cl
- **Coagulación:** TP, TTP, INR, Fibrinógeno, Dímero D
- **Hepático:** AST, ALT, BT, BD, GGT, FA
- **Pancreático:** Amilasa, Lipasa
- **Gasometría:** pH, pCO₂, pO₂, HCO₃, BE, SatO₂
- **EGO:** Color, Aspecto, Densidad, pH, Leu, Nitritos, Bacterias, Proteínas, Glucosa, Hematíes
- **Cardíaco:** Trop I, Trop T, CK, CK-MB, LDH, BNP, NT-proBNP, Mioglobina, Ferritina

## Si un campo no se llena

Quiere decir que el nombre del estudio en WinLab no coincide con ningún alias del mapper. Para arreglar:

1. Abre `index.html`, busca `WINLAB_ALIASES`
2. Encuentra la clave del campo (ej. `hb`, `cr`, etc.)
3. Agrega un regex nuevo al array correspondiente con el nombre como aparece en WinLab
4. Recarga la app — sin restart de Supabase, sin redeploy del scraper

Ejemplo: si WinLab pone "PROCALCITONINA SEROLOGICA":
```js
pct: [/procalcitonin/i, /^pct$/i], // ya cubre — match
```

## Tests

Validados con 5 escenarios y 37 campos: 100% accuracy. 0 falsos positivos en 8 cases de noise. Edge cases (null, vacío, undefined) manejados.

Para correr de nuevo: copia el bloque al final de `WINLAB-AUTOSYNC.md` y ejecuta con `node`.

## Cómo desactivar todo

Si por alguna razón rompe algo:

```js
// Consola del navegador:
localStorage.removeItem("pl_winlab_auto_sync");
location.reload();
```

O simplemente click derecho en el botón → vuelve a Auto OFF.

## Arquitectura técnica

```
GitHub Actions cron 13:15 CST
        ↓
rpa/scraper.js (Playwright + WinLab)
        ↓
public.winlab_labs (data jsonb)
        ↓ (refreshWinlabLabs lee a winlabByExp en cliente)
        ↓
applyWinlabSyncToPatients() ← NUEVO
        ↓ (mapWinlabReportesToLabs aplica WINLAB_ALIASES)
        ↓
notes.lab_history (snapshot por fecha)
        ↓
renderLabSection() pinta campos tipados con valores
```

## Cambios en código

| Archivo | Líneas | Qué cambió |
|---|---|---|
| `index.html` | +260 | Nuevo módulo WinLab→Lab mapper + UI + init hook |
| (sin cambios en scraper, schema, ni notes) | — | Cero riesgo de romper backend |

## Próximos pasos (futuras iteraciones)

1. **Badge "💧 WinLab" inline** en cada celda auto-llenada (visual diferenciador manual/sync)
2. **Toggle por paciente** (algunos quizás siempre quieren manual)
3. **Hist. de cambios** de auto-sync (audit log)
4. **Mapper para EGO** (parser de tabla "Examen General de Orina" si WinLab lo separa en otra sección)
