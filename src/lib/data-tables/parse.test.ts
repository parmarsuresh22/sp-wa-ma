import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'

import { phoneKey, searchWords } from './lookup'
import { columnKey, googleSheetId, guessPhoneColumn, parseWorkbook } from './parse'

function workbook(sheets: Record<string, unknown[][]>): Uint8Array {
  const wb = XLSX.utils.book_new()
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name)
  }
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
}

describe('columnKey', () => {
  it('makes stable, unique keys', () => {
    const used = new Set<string>()
    expect(columnKey('Student Name', used)).toBe('student_name')
    expect(columnKey('Student  name!', used)).toBe('student_name_2')
    expect(columnKey('2024 Total', used)).toBe('c_2024_total')
    expect(columnKey('%%%', used)).toBe('column')
  })
})

describe('parseWorkbook', () => {
  it('turns every non-empty sheet into a table', () => {
    const sheets = parseWorkbook(
      workbook({
        Scores: [
          ['Student', 'Parent Mobile', 'Total'],
          ['Asha', '+91 97820 48273', 451],
          ['', '', ''],
          ['Ravi', '9876543210', 388.5],
        ],
        Empty: [],
        Doctors: [
          ['Name', 'Speciality'],
          ['Dr. Sharma', 'Cardiology'],
        ],
      }),
      'school.xlsx',
    )
    expect(sheets.map((s) => s.name)).toEqual(['Scores', 'Doctors'])
    expect(sheets[0].columns).toEqual([
      { key: 'student', name: 'Student' },
      { key: 'parent_mobile', name: 'Parent Mobile' },
      { key: 'total', name: 'Total' },
    ])
    expect(sheets[0].rows).toEqual([
      { student: 'Asha', parent_mobile: '+91 97820 48273', total: '451' },
      { student: 'Ravi', parent_mobile: '9876543210', total: '388.5' },
    ])
    expect(guessPhoneColumn(sheets[0])).toBe('parent_mobile')
    expect(guessPhoneColumn(sheets[1])).toBeNull()
  })
})

describe('googleSheetId', () => {
  it('accepts only Google Sheets links', () => {
    const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    expect(googleSheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`)).toBe(id)
    expect(googleSheetId(`http://docs.google.com/spreadsheets/d/${id}/edit`)).toBeNull()
    expect(googleSheetId(`https://evil.example.com/spreadsheets/d/${id}`)).toBeNull()
    expect(googleSheetId('https://docs.google.com/document/d/abc')).toBeNull()
    expect(googleSheetId('not a url')).toBeNull()
  })
})

describe('phoneKey', () => {
  it('matches a number however it was typed', () => {
    expect(phoneKey('+91 97820-48273')).toBe('9782048273')
    expect(phoneKey('919782048273')).toBe('9782048273')
    expect(phoneKey('09782048273')).toBe('9782048273')
    expect(phoneKey('12')).toBeNull()
    expect(phoneKey(null)).toBeNull()
  })
})

describe('searchWords', () => {
  it('keeps meaningful words only, safe for a filter', () => {
    expect(searchWords('Is Dr. Sharma available, for (cardiology)?')).toEqual([
      'sharma',
      'cardiology',
    ])
    expect(searchWords('%,.)(')).toEqual([])
  })
})
