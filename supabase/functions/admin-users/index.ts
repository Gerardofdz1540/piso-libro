// Piso Libro · admin-users (oct 2026)
// Panel de usuarios de la app. Solo responde a cuentas con role='admin' y status='active' en public.app_users.
// Usa la service_role key que Supabase inyecta en las Edge Functions (nunca sale al navegador).
// Acciones: list, invite, activar_registro, set_role, set_status, set_nombre, temp_password,
//           recovery_link, recovery_email, delete_user, set_acceso_hasta. Todas quedan en public.audit_log.
// 27 oct 2026: una contraseña dada por el administrador (al crear la cuenta o «🔑 Contraseña temporal») marca la cuenta
// con debe_cambiar_pwd y la app pide una nueva al entrar. acceso_hasta = fin de rotación (el panel avisa cuando pasa).
// Desplegada en el proyecto vkxplmrzyqlamxpbtmes con verify_jwt=true (Supabase → Edge Functions → admin-users).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.46.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pl-device, x-pl-user",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const ROLES = ["admin", "usuario"];
const STATUS = ["active", "blocked"];
const DEFAULT_REDIRECT = "https://pisolibro.pages.dev/";
const MIN_PWD = 12; // política de contraseñas del proyecto (Supabase → Auth → Password)

function tempPassword(): string {
  // 12 caracteres legibles (sin 0/O, 1/l/I) para dictarla por teléfono o WhatsApp.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const buf = new Uint32Array(MIN_PWD);
  crypto.getRandomValues(buf);
  return Array.from(buf, (x) => alphabet[x % alphabet.length]).join("");
}
function clean(s: unknown, n = 120): string { return String(s ?? "").trim().slice(0, n); }
function isEmail(s: string): boolean { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function isUuid(s: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s); }
function now(): string { return new Date().toISOString(); }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Usa POST" });
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json(401, { error: "Sin sesión" });
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const caller = userData?.user;
  if (userErr || !caller) return json(401, { error: "Sesión inválida" });
  const { data: me } = await admin.from("app_users").select("id,email,nombre,role,status").eq("id", caller.id).maybeSingle();
  if (!me || me.status !== "active" || me.role !== "admin") return json(403, { error: "Solo el administrador puede hacer esto" });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json(400, { error: "JSON inválido" }); }
  const action = clean(body.action, 40);
  const id = clean(body.id, 60);
  const dev = clean(req.headers.get("x-pl-device"), 80);
  const ip = clean(req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0], 60);
  const ua = clean(req.headers.get("user-agent"), 200);
  const redirectTo = clean(body.redirect_to, 200) || DEFAULT_REDIRECT;
  const audit = async (op: string, target: { id?: string; email?: string | null }, extra: Record<string, unknown> = {}) => {
    try {
      await admin.from("audit_log").insert({
        user_id: caller.id, email: caller.email, nombre: me.nombre || null, dispositivo: dev || null, ip: ip || null, ua: ua || null,
        tabla: "app_users", op, record_id: target.id ?? null, diff: { usuario: target.email ?? null, ...extra },
      });
    } catch (_) { /* el registro nunca bloquea la acción */ }
  };
  const targetEmail = async (uid: string) => {
    const { data } = await admin.from("app_users").select("email").eq("id", uid).maybeSingle();
    return data?.email ?? null;
  };
  const needsId = ["activar_registro", "set_role", "set_status", "set_nombre", "temp_password", "recovery_link", "recovery_email", "delete_user", "set_acceso_hasta"];
  if (needsId.includes(action) && !isUuid(id)) return json(400, { error: "Falta el id de la cuenta" });

  try {
    switch (action) {
      case "list": {
        const { data: rows, error } = await admin.from("app_users").select("*").order("created_at");
        if (error) throw error;
        const { data: lu } = await admin.auth.admin.listUsers({ page: 1, perPage: 500 });
        const authUsers = lu?.users || [];
        const byId = new Map(authUsers.map((u) => [u.id, u]));
        const users = (rows || []).map((r) => {
          const u = byId.get(r.id);
          return { ...r, last_sign_in_at: u?.last_sign_in_at || null, banned_until: (u as { banned_until?: string } | undefined)?.banned_until || null, sin_cuenta_auth: !u };
        });
        // Cuentas creadas a mano en el panel de Supabase que aún no tienen registro: se listan para activarlas.
        const huerfanos = authUsers.filter((u) => !(rows || []).some((r) => r.id === u.id)).map((u) => ({
          id: u.id, email: u.email || "", nombre: "", role: "usuario", status: "sin_registro", created_at: u.created_at, last_sign_in_at: u.last_sign_in_at || null,
        }));
        return json(200, { users: [...users, ...huerfanos], me: { id: me.id, role: me.role } });
      }
      case "invite": {
        const email = clean(body.email, 120).toLowerCase();
        const nombre = clean(body.nombre, 80);
        const role = ROLES.includes(String(body.role)) ? String(body.role) : "usuario";
        if (!isEmail(email)) return json(400, { error: "Correo inválido" });
        const password = clean(body.password, 72) || tempPassword();
        if (password.length < MIN_PWD) return json(400, { error: `La contraseña debe tener al menos ${MIN_PWD} caracteres` });
        const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { nombre } });
        if (error || !created?.user) return json(400, { error: error?.message || "No se pudo crear la cuenta" });
        const uid = created.user.id;
        const { error: e2 } = await admin.from("app_users").upsert({ id: uid, email, nombre, role, status: "active", debe_cambiar_pwd: true, created_by: caller.id, updated_at: now() });
        if (e2) throw e2;
        await audit("ADMIN:invitar", { id: uid, email }, { role });
        return json(200, { ok: true, id: uid, email, temp_password: password });
      }
      case "activar_registro": {
        const { data: u } = await admin.auth.admin.getUserById(id);
        if (!u?.user) return json(404, { error: "La cuenta no existe" });
        const { error } = await admin.from("app_users").upsert({
          id, email: u.user.email || "", nombre: clean(body.nombre, 80), role: ROLES.includes(String(body.role)) ? String(body.role) : "usuario",
          status: "active", created_by: caller.id, updated_at: now(),
        });
        if (error) throw error;
        await audit("ADMIN:activar", { id, email: u.user.email });
        return json(200, { ok: true });
      }
      case "set_role": {
        const role = ROLES.includes(String(body.role)) ? String(body.role) : null;
        if (!role) return json(400, { error: "Rol inválido" });
        if (id === caller.id && role !== "admin") return json(400, { error: "No puedes quitarte el rol de administrador a ti mismo" });
        const email = await targetEmail(id);
        const { error } = await admin.from("app_users").update({ role, updated_at: now() }).eq("id", id);
        if (error) throw error;
        await audit("ADMIN:rol", { id, email }, { role });
        return json(200, { ok: true });
      }
      case "set_status": {
        const status = STATUS.includes(String(body.status)) ? String(body.status) : null;
        if (!status) return json(400, { error: "Estado inválido" });
        if (id === caller.id) return json(400, { error: "No puedes bloquearte a ti mismo" });
        const email = await targetEmail(id);
        const { error } = await admin.from("app_users").update({ status, updated_at: now() }).eq("id", id);
        if (error) throw error;
        // También en Auth: bloqueado no puede ni iniciar sesión.
        const { error: e2 } = await admin.auth.admin.updateUserById(id, { ban_duration: status === "blocked" ? "87600h" : "none" });
        if (e2) return json(400, { error: e2.message });
        await audit(status === "blocked" ? "ADMIN:bloquear" : "ADMIN:desbloquear", { id, email });
        return json(200, { ok: true });
      }
      case "set_nombre": {
        const nombre = clean(body.nombre, 80);
        const { error } = await admin.from("app_users").update({ nombre, updated_at: now() }).eq("id", id);
        if (error) throw error;
        await admin.auth.admin.updateUserById(id, { user_metadata: { nombre } });
        return json(200, { ok: true });
      }
      case "temp_password": {
        const password = tempPassword();
        const email = await targetEmail(id);
        const { error } = await admin.auth.admin.updateUserById(id, { password });
        if (error) return json(400, { error: error.message });
        await admin.from("app_users").update({ debe_cambiar_pwd: true, updated_at: now() }).eq("id", id);
        await audit("ADMIN:contrasena temporal", { id, email });
        return json(200, { ok: true, temp_password: password });
      }
      case "recovery_link": {
        const email = await targetEmail(id);
        if (!email) return json(404, { error: "La cuenta no existe" });
        const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email, options: { redirectTo } });
        if (error) return json(400, { error: error.message });
        await audit("ADMIN:enlace de recuperacion", { id, email });
        return json(200, { ok: true, link: data.properties?.action_link || null });
      }
      case "recovery_email": {
        const email = await targetEmail(id);
        if (!email) return json(404, { error: "La cuenta no existe" });
        const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
        const { error } = await anon.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) return json(400, { error: error.message });
        await audit("ADMIN:correo de recuperacion", { id, email });
        return json(200, { ok: true });
      }
      case "delete_user": {
        if (id === caller.id) return json(400, { error: "No puedes borrar tu propia cuenta" });
        const email = await targetEmail(id);
        await admin.from("app_users").delete().eq("id", id);
        const { error } = await admin.auth.admin.deleteUser(id);
        if (error) return json(400, { error: error.message });
        await audit("ADMIN:borrar cuenta", { id, email });
        return json(200, { ok: true });
      }
      case "set_acceso_hasta": {
        const fecha = clean(body.fecha, 10);
        if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return json(400, { error: "Fecha inválida (AAAA-MM-DD)" });
        const email = await targetEmail(id);
        const { error } = await admin.from("app_users").update({ acceso_hasta: fecha || null, updated_at: now() }).eq("id", id);
        if (error) throw error;
        await audit("ADMIN:acceso hasta", { id, email }, { acceso_hasta: fecha || null });
        return json(200, { ok: true });
      }
      default:
        return json(400, { error: "Acción desconocida" });
    }
  } catch (e) {
    return json(500, { error: String((e as { message?: string })?.message || e) });
  }
});
