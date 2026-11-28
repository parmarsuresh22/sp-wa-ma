import { describe, expect, it } from 'vitest'

import { pickDeviceContacts } from './contact-sync'

describe('pickDeviceContacts', () => {
  it('keeps saved people with a phone number, under their saved name', () => {
    const picked = pickDeviceContacts([
      { id: '919876543210@c.us', name: 'Asha Sharma', pushname: 'Asha', isMyContact: true },
      { id: '919812345678@s.whatsapp.net', pushname: 'Ravi' },
      { id: { _serialized: '14155550123@c.us' }, shortName: 'Sam' },
    ])
    expect(picked).toEqual([
      { digits: '919876543210', name: 'Asha Sharma' },
      { digits: '919812345678', name: 'Ravi' },
      { digits: '14155550123', name: 'Sam' },
    ])
  })

  it('leaves out groups, lists, hidden numbers, strangers, blocked people and the phone itself', () => {
    const picked = pickDeviceContacts(
      [
        { id: '120363012345678901@g.us', name: 'Family' },
        { id: 'status@broadcast' },
        { id: '123456789012345@lid', name: 'Hidden' },
        { id: '919800000001@c.us', name: 'Stranger', isMyContact: false },
        { id: '919800000002@c.us', name: 'Blocked', isBlocked: true },
        { id: '918433701949@c.us', name: 'Me' },
        { id: '12345@c.us', name: 'Too short' },
        null,
        'junk',
      ],
      '+91 84337 01949',
    )
    expect(picked).toEqual([])
  })

  it('lists a number once, keeping a name when one of the entries has it', () => {
    const picked = pickDeviceContacts([{ id: '919876543210@c.us' }, { id: '919876543210@s.whatsapp.net', name: 'Asha' }])
    expect(picked).toEqual([{ digits: '919876543210', name: 'Asha' }])
    expect(pickDeviceContacts('not a list')).toEqual([])
  })
})
