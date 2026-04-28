// Offline-safe retry helper and outbox utilities

export async function retryNetwork(fn, retries = 2, baseDelayMs = 350) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      const isNetworkError =
        e.message?.includes('Failed to fetch') ||
        e.message?.includes('NetworkError') ||
        e.message?.includes('timeout')
      if (!isNetworkError || attempt === retries) break
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt))
    }
  }
  throw lastErr
}

// Simple in-memory pending queue. In production you'd persist to IndexedDB.
class SyncQueue {
  constructor() {
    this._queue = []
    this._flushing = false
    this._handlers = []
  }

  enqueue(item) {
    this._queue.push({ ...item, queuedAt: Date.now() })
    this._notify()
  }

  get size() {
    return this._queue.length
  }

  onSizeChange(handler) {
    this._handlers.push(handler)
    return () => { this._handlers = this._handlers.filter((h) => h !== handler) }
  }

  _notify() {
    this._handlers.forEach((h) => h(this._queue.length))
  }

  async flush(processFn) {
    if (this._flushing || this._queue.length === 0) return 0
    this._flushing = true
    let processed = 0
    while (this._queue.length > 0) {
      const item = this._queue[0]
      try {
        await processFn(item)
        this._queue.shift()
        processed++
        this._notify()
      } catch {
        break
      }
    }
    this._flushing = false
    return processed
  }
}

export const syncQueue = new SyncQueue()

// Listen for online events and auto-flush
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    // Caller must provide a processFn via syncQueue.flush(fn)
    // This just signals the queue has work
    syncQueue._notify()
  })
}
