/**
 * Punto de encuentro entre el servidor MCP y el canvas-server.
 *
 * Son procesos SEPARADOS a propósito: la spec de MCP prohíbe que un servidor
 * stdio escriba a stdout cualquier cosa que no sea un mensaje de protocolo, y
 * cualquier librería HTTP/WS loguea a stdout en cuanto algo va mal. Compartir
 * proceso es la forma documentada de matar la conexión al arrancar.
 */
import { dirname } from 'node:path'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

import { HOME, LOCK_FILE } from './paths.ts'

export interface CanvasLock {
  port: number
  token: string
  pid: number
  startedAt: number
}

export function writeLock(lock: CanvasLock): void {
  mkdirSync(dirname(LOCK_FILE) || HOME, { recursive: true })
  writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2), 'utf8')
}

export function readLock(): CanvasLock | null {
  try {
    return JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as CanvasLock
  } catch {
    return null
  }
}

export function clearLock(): void {
  try {
    rmSync(LOCK_FILE)
  } catch {
    /* ya no estaba */
  }
}

/** Un lockfile huérfano de un proceso muerto es peor que no tener ninguno. */
export function isAlive(lock: CanvasLock): boolean {
  try {
    process.kill(lock.pid, 0)
    return true
  } catch {
    return false
  }
}
