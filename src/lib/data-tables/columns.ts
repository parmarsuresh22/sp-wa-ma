// Column model shared by the server importer and the browser editor.
// Kept free of the spreadsheet parser so the editor does not ship it.

export interface DataColumn {
  /** Stable id used in row data and in `{{table.key}}` placeholders. */
  key: string
  /** What the user sees; free to rename without touching the rows. */
  name: string
}

/** `Student Name` → `student_name`; unique within `used`. */
export function columnKey(name: string, used: Set<string>): string {
  let base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  if (!base) base = 'column'
  if (/^\d/.test(base)) base = `c_${base}`
  let key = base
  for (let n = 2; used.has(key); n++) key = `${base}_${n}`
  used.add(key)
  return key
}
