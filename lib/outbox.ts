/**
 * The local-first outbox.
 *
 * An event's timestamp is fixed at the keystroke and does not travel over the
 * network, so a delayed or retried send changes nothing about the data. That fact
 * is only worth anything if the console actually behaves that way: append locally,
 * show the operator their event immediately, and flush in the background with
 * backoff.
 *
 * IndexedDB rather than memory, because the outcome to design against is not a
 * slow link — it is a closed laptop lid, a crashed tab, or a reload mid-match.
 * Falls back to memory when storage is unavailable (private mode, denied quota) so
 * that collection never blocks on it.
 */

import type { CollectedEvent } from './protocol.ts'

const DB_NAME = 'live-timebase'
const DB_VERSION = 1
const STORE = 'outbox'

let dbPromise: Promise<IDBDatabase> | null = null
let memoryFallback: CollectedEvent[] | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('no indexedDB'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'clientEventId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'))
  })
  return dbPromise
}

function useMemory(): CollectedEvent[] {
  memoryFallback ??= []
  return memoryFallback
}

async function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode)
    const request = run(transaction.objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'))
  })
}

export async function enqueue(event: CollectedEvent): Promise<void> {
  try {
    await tx('readwrite', (store) => store.put(event) as IDBRequest<IDBValidKey>)
  } catch {
    useMemory().push(event)
  }
}

export async function pending(): Promise<CollectedEvent[]> {
  try {
    return await tx('readonly', (store) => store.getAll() as IDBRequest<CollectedEvent[]>)
  } catch {
    return [...useMemory()]
  }
}

export async function acknowledge(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      for (const id of ids) store.delete(id)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('delete failed'))
    })
  } catch {
    memoryFallback = useMemory().filter((e) => !ids.includes(e.clientEventId))
  }
}
