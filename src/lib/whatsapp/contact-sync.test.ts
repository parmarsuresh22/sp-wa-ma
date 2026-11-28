import { describe, expect, it } from 'vitest'

import { lidMapFrom, pickDeviceContacts } from './contact-sync'

describe('pickDeviceContacts', () => {
  it('keeps the saved people when the bridge marks them, under their saved name', () => {
    const { contacts, stats } = pickDeviceContacts([
      { id: '919876543210@c.us', name: 'Asha Sharma', pushname: 'Asha', isMyContact: true },
      { id: { _serialized: '14155550123@c.us' }, shortName: 'Sam', isMyContact: true },
      { id: '919800000001@c.us', pushname: 'Stranger', isMyContact: false },
    ])
    expect(contacts).toEqual([
      { digits: '919876543210', name: 'Asha Sharma' },
      { digits: '14155550123', name: 'Sam' },
    ])
    expect(stats).toMatchObject({ total: 3, phoneIds: 3, notSaved: 1, kept: 2 })
  })

  it('keeps everyone with a name when the bridge marks nobody as saved', () => {
    const { contacts } = pickDeviceContacts([
      { id: '919876543210@s.whatsapp.net', name: 'Asha' },
      { id: '919812345678@s.whatsapp.net', pushName: 'Ravi', isMyContact: false },
      { id: '919800000009@s.whatsapp.net' },
    ])
    expect(contacts).toEqual([
      { digits: '919876543210', name: 'Asha' },
      { digits: '919812345678', name: 'Ravi' },
    ])
  })

  it('turns hidden ids back into numbers, from the bridge list or the entry itself', () => {
    const lids = lidMapFrom([{ lid: '111222333444555@lid', pn: '919876543210@c.us' }, { lid: 'bad' }, null])
    const { contacts, stats } = pickDeviceContacts(
      [
        { id: '111222333444555@lid', name: 'Asha' },
        { id: '999888777666555@lid', name: 'Ravi', phoneNumber: '919812345678@s.whatsapp.net' },
        { id: '123123123123123@lid', name: 'Unknown number' },
      ],
      null,
      lids,
    )
    expect(contacts).toEqual([
      { digits: '919876543210', name: 'Asha' },
      { digits: '919812345678', name: 'Ravi' },
    ])
    expect(stats).toMatchObject({ hiddenIds: 3, hiddenResolved: 2, kept: 2 })
  })

  it('leaves out groups, lists, blocked people and the phone itself', () => {
    const { contacts, stats } = pickDeviceContacts(
      [
        { id: '120363012345678901@g.us', name: 'Family' },
        { id: 'status@broadcast' },
        { id: '919800000002@c.us', name: 'Blocked', isBlocked: true },
        { id: '918433701949@c.us', name: 'Me' },
        { id: '12345@c.us', name: 'Too short' },
        null,
        'junk',
      ],
      '+91 84337 01949',
    )
    expect(contacts).toEqual([])
    expect(stats.groupsAndLists).toBe(4)
  })

  it('lists a number once, keeping a name when one of the entries has it', () => {
    const { contacts } = pickDeviceContacts([
      { id: '919876543210@c.us', isMyContact: true },
      { id: '919876543210@s.whatsapp.net', name: 'Asha', isMyContact: true },
    ])
    expect(contacts).toEqual([{ digits: '919876543210', name: 'Asha' }])
    expect(pickDeviceContacts('not a list').contacts).toEqual([])
  })
})
