import { createClient } from '@supabase/supabase-js'

const SUPA_URL = import.meta.env.VITE_SUPA_URL ?? 'https://vkxplmrzyqlamxpbtmes.supabase.co'
const SUPA_KEY = import.meta.env.VITE_SUPA_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZreHBsbXJ6eXFsYW14cGJ0bWVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5NTg1MjcsImV4cCI6MjA4NzUzNDUyN30.zChMOiKnxNv3pLyt2Fqi7zUh0ET5rn1a5L6S3RV1Q98'

export const supabase = createClient(SUPA_URL, SUPA_KEY, {
  realtime: { params: { eventsPerSecond: 10 } },
  auth: { persistSession: true, autoRefreshToken: true },
})

// Table names
export const TABLES = {
  PATIENTS: 'patients',
  NOTES: 'notes',
  WINLAB: 'winlab_labs',
  GUARD_INFO: 'guard_info',
  CONFIG: 'config',
}
