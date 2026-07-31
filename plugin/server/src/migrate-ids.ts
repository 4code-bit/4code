/**
 * Migración de identidad: de id-por-ruta a id-por-remoto.
 *
 * Los tableros creados antes de este cambio llevan un id derivado de dónde
 * estaba el repo en el disco. Eso los hace impersonales de compartir: el mismo
 * repositorio clonado por otra persona generaba un id distinto.
 *
 * Simula por defecto. Para aplicar de verdad:
 *
 *   node server/src/migrate-ids.ts            # enseña qué haría
 *   node server/src/migrate-ids.ts --apply    # lo hace
 */
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ProjectRef } from '../../shared/project.ts'
import { readGit } from './git.ts'
import { PROJECTS_DIR } from './paths.ts'
import { makeRemoteId } from './project.ts'

const aplicar = process.argv.includes('--apply')

if (!existsSync(PROJECTS_DIR)) {
  console.log('No hay nada que migrar.')
  process.exit(0)
}

interface Plan {
  from: string
  to: string
  name: string
  remote: string
  colisiona: boolean
}

const planes: Plan[] = []
const sinCambio: string[] = []

for (const id of readdirSync(PROJECTS_DIR)) {
  // Los directorios ya apartados por una migración o un vaciado anterior NO se
  // vuelven a procesar: sus datos ya se fusionaron en su día, y repetirlo
  // duplicaría cada evento.
  if (/\.(migrado|vaciado-\d+|movido-\d+)$/.test(id)) continue

  const dir = join(PROJECTS_DIR, id)
  const metaPath = join(dir, 'project.json')
  if (!existsSync(metaPath)) continue

  let meta: ProjectRef
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8')) as ProjectRef
  } catch {
    sinCambio.push(`${id} — project.json ilegible`)
    continue
  }

  if (!meta.root || !existsSync(meta.root)) {
    sinCambio.push(`${meta.name ?? id} — su carpeta ya no existe (${meta.root})`)
    continue
  }

  const { remote } = readGit(meta.root)
  if (!remote) {
    sinCambio.push(`${meta.name ?? id} — sin remoto de git, sigue identificado por ruta`)
    continue
  }

  const nuevo = makeRemoteId(remote)
  if (nuevo === id) {
    sinCambio.push(`${meta.name ?? id} — ya usa el remoto`)
    continue
  }

  planes.push({
    from: id,
    to: nuevo,
    name: meta.name ?? id,
    remote,
    colisiona: existsSync(join(PROJECTS_DIR, nuevo)),
  })
}

console.log(`\n${aplicar ? 'MIGRANDO' : 'SIMULACIÓN (usa --apply para hacerlo de verdad)'}\n`)

for (const linea of sinCambio) console.log(`  · sin cambios: ${linea}`)
if (sinCambio.length && planes.length) console.log('')

/** Líneas de un jsonl, sin las vacías. */
function lineas(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim())
}

for (const plan of planes) {
  const desde = join(PROJECTS_DIR, plan.from)
  const hasta = join(PROJECTS_DIR, plan.to)

  if (!plan.colisiona) {
    console.log(`  → ${plan.name}: ${plan.from} → ${plan.to}`)
    console.log(`    remoto: ${plan.remote}`)

    if (aplicar) {
      renameSync(desde, hasta)
      const metaPath = join(hasta, 'project.json')
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as ProjectRef
        writeFileSync(metaPath, JSON.stringify({ ...meta, id: plan.to, remote: plan.remote }, null, 2), 'utf8')
      } catch {
        console.log(`    (aviso: no se pudo actualizar project.json)`)
      }
    }
    continue
  }

  // ── Colisión: el destino ya existe ────────────────────────────────────────
  //
  // Pasa cuando el proyecto siguió trabajando después del cambio de código: sus
  // eventos nuevos fueron al id nuevo y los viejos se quedaron atrás.
  const ambosConTablero = existsSync(join(desde, 'history.jsonl')) && existsSync(join(hasta, 'history.jsonl'))

  if (ambosConTablero) {
    // Fusionar dos historiales de diagrama exige reasignar `seq` y reconstruir
    // el estado; hacerlo mal pierde trabajo. Se avisa y no se toca nada.
    console.log(`  ! ${plan.name}: ${plan.from} y ${plan.to} tienen tablero los dos.`)
    console.log(`    No se fusiona automáticamente. Decide cuál conservar.`)
    continue
  }

  const eventosViejos = lineas(join(desde, 'sessions.jsonl'))
  const eventosNuevos = lineas(join(hasta, 'sessions.jsonl'))
  const tableroEn = existsSync(join(desde, 'history.jsonl')) ? 'viejo' : existsSync(join(hasta, 'history.jsonl')) ? 'nuevo' : 'ninguno'

  console.log(`  ⇄ ${plan.name}: fusionar ${plan.from} → ${plan.to}`)
  console.log(`    ${eventosViejos.length} + ${eventosNuevos.length} eventos · tablero en: ${tableroEn}`)

  if (!aplicar) continue

  // Los eventos llevan timestamp, así que fusionarlos es ordenar por `at`. No
  // hay conflicto posible: son hechos con hora, no estado mutable.
  const todos = [...eventosViejos, ...eventosNuevos]
    .map((l) => {
      try {
        return { l, at: (JSON.parse(l) as { at?: number }).at ?? 0 }
      } catch {
        return { l, at: 0 }
      }
    })
    .sort((a, b) => a.at - b.at)
    .map((x) => x.l)

  if (todos.length) writeFileSync(join(hasta, 'sessions.jsonl'), `${todos.join('\n')}\n`, 'utf8')

  // Si el tablero estaba en el viejo, se lleva al nuevo.
  if (tableroEn === 'viejo') {
    for (const f of ['history.jsonl', 'diagram.json']) {
      if (existsSync(join(desde, f))) renameSync(join(desde, f), join(hasta, f))
    }
  }

  // El viejo queda vacío de datos; se aparta con sufijo en vez de borrarlo, que
  // es reversible si algo salió mal.
  renameSync(desde, `${desde}.migrado`)
  console.log(`    hecho · el antiguo queda como ${plan.from}.migrado`)
}

if (planes.length === 0) console.log('\n  Nada que migrar.')
console.log('')
