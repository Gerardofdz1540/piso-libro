# Base de datos (Supabase) · cambios del 20 oct 2026

Lo que hay aquí ya está **aplicado en producción**; se guarda para poder reconstruir la base y revisar las reglas.

1. `supabase_guardia_cronologia.sql` — 🌙 Guardia y 🕓 Cronología: la Guardia no la borra una copia vieja de otro
   equipo y quien edita la caja sí puede corregir o borrar (último cambio gana, salvo lo que otro equipo escribió en
   los últimos 15 min); la Cronología solo la escribe la base (paso de las 06:15, todavía sin programar hasta que se
   publiquen las dos cajas); respaldo de la Cronología y su regreso desde la Papelera; capa 2 contra pérdidas
   (ninguna llave del checklist desaparece, alarma de pérdidas masivas); respaldo cada hora (`respaldo_hora`, 7 días).
   Su batería: `valsql/pruebas.sql` (28 pruebas, en una transacción que se deshace).
2. `blindaje_20261020/` — revisión integral: bitácora por equipo, sellos de autor que no retroceden, labs que una copia
   vieja no puede borrar, reescrituras sin cambios ignoradas (sin Realtime ni bitácora), nota de un reingreso
   protegida 10 min, Papelera con copia de la base y de lo borrado, copia al borrar de No olvidar y Procedimientos,
   borrado masivo solo administrador (pacientes y notas), alarma de pérdidas en todas las cajas, permisos, y `notes`
   en REPLICA IDENTITY FULL (Realtime manda la nota completa). Orden, verificación por paso y reversas en
   `blindaje_20261020/APLICAR_EN_ORDEN.md`. Pruebas: `blindaje_20261020/todo_pruebas.sql` (solo en una réplica local:
   189 pruebas).

Nunca correr los archivos de pruebas en producción: crean usuarios y pacientes ficticios dentro de su transacción.
