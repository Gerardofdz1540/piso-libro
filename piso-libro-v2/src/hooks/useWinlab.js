import { useState, useEffect, useCallback } from 'react'
import { supabase, TABLES } from '../config/supabase'

export function useWinlab() {
  // Map of exp → { fecha, scraped_at, data }
  const [winlabByExp, setWinlabByExp] = useState({})
  const [loading, setLoading] = useState(false)
  const [lastFetched, setLastFetched] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from(TABLES.WINLAB)
        .select('exp,fecha,scraped_at,data')
        .order('scraped_at', { ascending: false })
        .limit(500)
      if (error) throw error

      const map = {}
      ;(data ?? []).forEach((row) => {
        // Keep most-recent record per exp
        if (!map[row.exp] || row.scraped_at > map[row.exp].scraped_at) {
          map[row.exp] = { fecha: row.fecha, scraped_at: row.scraped_at, data: row.data }
        }
      })
      setWinlabByExp(map)
      setLastFetched(new Date())
    } catch (e) {
      console.error('useWinlab load:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  // Subscribe to new scrapes in realtime
  useEffect(() => {
    load()

    const channel = supabase
      .channel('winlab-realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: TABLES.WINLAB }, (payload) => {
        const row = payload.new
        setWinlabByExp((prev) => {
          const existing = prev[row.exp]
          if (existing && existing.scraped_at >= row.scraped_at) return prev
          return {
            ...prev,
            [row.exp]: { fecha: row.fecha, scraped_at: row.scraped_at, data: row.data },
          }
        })
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [load])

  // Returns the lab entry for a patient expediente, or null
  const getLabForExp = useCallback(
    (exp) => winlabByExp[String(exp ?? '')] ?? null,
    [winlabByExp],
  )

  return { winlabByExp, loading, lastFetched, reload: load, getLabForExp }
}
