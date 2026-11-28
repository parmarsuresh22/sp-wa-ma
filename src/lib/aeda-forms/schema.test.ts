import { describe, expect, it } from 'vitest'

import { answerText, checkAnswers, cleanSchema, csvCell, keyFromLabel, publishProblems } from './schema'

const design = cleanSchema({
  fields: [
    { id: 'a', type: 'text', label: 'Full Name', required: true },
    { id: 'b', type: 'email', label: 'Email' },
    { id: 'c', type: 'number', label: 'Age' },
    { id: 'd', type: 'dropdown', label: 'City', options: ['Sirohi', 'Jaipur', 'Sirohi', ''], required: true },
    { id: 'e', type: 'checkbox', label: 'Interests', options: ['Sales', 'Support'] },
    { id: 'f', type: 'heading', label: 'About you', required: true },
    { id: 'g', type: 'date', label: 'Visit date' },
    { id: 'h', type: 'nonsense', label: 'Dropped' },
  ],
  stages: ['New', 'Done', 'New'],
})

describe('cleanSchema', () => {
  it('drops unknown types, tidies choices and names every field', () => {
    expect(design.fields.map((f) => f.key)).toEqual(['full_name', 'email', 'age', 'city', 'interests', 'about_you', 'visit_date'])
    expect(design.fields[3].options).toEqual(['Sirohi', 'Jaipur'])
    expect(design.fields[5].required).toBe(false)
    expect(design.stages).toEqual(['New', 'Done'])
    expect(design.submitLabel).toBe('Submit')
  })

  it('keeps keys unique', () => {
    const s = cleanSchema({ fields: [{ type: 'text', label: 'Name' }, { type: 'text', label: 'Name' }, { type: 'text', label: 'Name' }] })
    expect(new Set(s.fields.map((f) => f.key)).size).toBe(3)
    expect(new Set(s.fields.map((f) => f.id)).size).toBe(3)
  })

  it('survives rubbish', () => {
    expect(cleanSchema(null).fields).toEqual([])
    expect(cleanSchema('x').stages).toEqual(['New'])
  })
})

describe('keyFromLabel', () => {
  it('makes a storage name', () => {
    expect(keyFromLabel('First Name')).toBe('first_name')
    expect(keyFromLabel('2nd phone')).toBe('f_2nd_phone')
    expect(keyFromLabel('???')).toBe('field')
  })
})

describe('publishProblems', () => {
  it('wants a field that collects an answer, and choices where needed', () => {
    expect(publishProblems(cleanSchema({ fields: [{ type: 'heading', label: 'Hi' }] })).length).toBe(1)
    expect(publishProblems(cleanSchema({ fields: [{ type: 'radio', label: 'Pick' }] })).length).toBe(1)
    expect(publishProblems(design)).toEqual([])
  })
})

describe('checkAnswers', () => {
  it('accepts a good answer and keeps only known fields', () => {
    const r = checkAnswers(design, {
      full_name: '  Asha  ',
      email: 'asha@example.com',
      age: 31,
      city: 'Jaipur',
      interests: ['Sales', 'Hacking'],
      visit_date: '2026-12-01',
      extra: 'ignored',
    })
    expect(r.ok).toBe(true)
    expect(r.values).toEqual({
      full_name: 'Asha',
      email: 'asha@example.com',
      age: '31',
      city: 'Jaipur',
      interests: ['Sales'],
      visit_date: '2026-12-01',
    })
  })

  it('reports what is missing or wrong, per field', () => {
    const r = checkAnswers(design, { email: 'nope', age: 'old', city: 'Mumbai', visit_date: '01/12/2026' })
    expect(r.ok).toBe(false)
    expect(Object.keys(r.errors).sort()).toEqual(['age', 'city', 'email', 'full_name', 'visit_date'])
  })

  it('leaves an empty optional field alone', () => {
    expect(checkAnswers(design, { full_name: 'A', city: 'Sirohi' }).ok).toBe(true)
  })
})

describe('export helpers', () => {
  it('turns answers into text and safe CSV cells', () => {
    expect(answerText(['a', 'b'])).toBe('a, b')
    expect(answerText(null)).toBe('')
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)")
  })
})
