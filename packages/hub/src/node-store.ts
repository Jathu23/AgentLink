// The Store on Node's built-in SQLite.

import { DatabaseSync } from 'node:sqlite'
import { Store, type Row } from './store.ts'

export function openStore(path = ':memory:'): Store {
  const db = new DatabaseSync(path)
  return new Store({
    exec: (sql) => db.exec(sql),
    run: (sql, ...params) => void db.prepare(sql).run(...params),
    all: (sql, ...params) => db.prepare(sql).all(...params) as Row[],
  })
}
