// Who sees which requests. Each group has a board: a clinic's board holds the Cases owned by its
// Salesforce users, the staff board holds every Case whose owner is not a clinic owner.
// Students and employees see only their own group's board; managers and admins see all boards.

import { sf, query, isId, soqlString } from './salesforce.js';
import { listGroups } from './db.js';

export const canSeeAll = (user) => user.role === 'manager' || user.role === 'admin';

const clinicOwnerIds = (groups) => groups.filter((g) => g.kind === 'clinic').flatMap((g) => g.sf_owner_ids || []).filter(isId);
const idList = (ids) => ids.map((id) => `'${id}'`).join(', ');

// SOQL condition for the Cases on one group's board.
export function boardFilter(group, groups) {
  if (group.kind === 'clinic') {
    const ids = (group.sf_owner_ids || []).filter(isId);
    return ids.length ? `OwnerId IN (${idList(ids)})` : 'Id = null';
  }
  const clinics = clinicOwnerIds(groups);
  return clinics.length ? `OwnerId NOT IN (${idList(clinics)})` : null;
}

// The group whose board a Case with this owner is on.
export function groupOfOwner(ownerId, groups) {
  return groups.find((g) => g.kind === 'clinic' && (g.sf_owner_ids || []).includes(ownerId))
    || groups.find((g) => g.kind === 'staff')
    || null;
}

// The boards this user may open.
export async function visibleGroups(user) {
  const groups = await listGroups();
  return canSeeAll(user) ? groups : groups.filter((g) => g.id === user.groupId);
}

// SOQL condition limiting Cases to what the user may see, optionally narrowed to one board.
// Returns 'Id = null' (matches nothing) when the user may not see that board.
export async function caseFilter(user, boardId = null) {
  const groups = await listGroups();
  let board = null;
  if (!canSeeAll(user)) {
    board = groups.find((g) => g.id === user.groupId);
    if (!board || (boardId && boardId !== board.id)) return 'Id = null';
  } else if (boardId) {
    board = groups.find((g) => g.id === boardId);
    if (!board) return 'Id = null';
  }
  return board ? boardFilter(board, groups) : null;
}

// ---- Salesforce Contacts for portal users (the request handler field points at one) ----

let internalRecordType;
async function contactRecordTypeId() {
  if (internalRecordType === undefined) {
    const r = await query("SELECT Id FROM RecordType WHERE SobjectType = 'Contact' AND DeveloperName = 'RecordType_internal' AND IsActive = true LIMIT 1");
    internalRecordType = r.records[0]?.Id || null;
  }
  return internalRecordType;
}

function splitName(name, email) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { LastName: email.split('@')[0] };
  if (parts.length === 1) return { LastName: parts[0] };
  return { FirstName: parts.slice(0, -1).join(' ').slice(0, 40), LastName: parts.at(-1).slice(0, 80) };
}

const sfError = (e) => (Array.isArray(e.errors) ? e.errors.map((x) => x?.message).filter(Boolean).join('; ') : '') || e.message;

// Finds each person's Contact by email, creating the missing ones (name + email) through the API user.
// people: [{ email, name }] → Map(email → { id } | { error }). Never updates or deletes existing Contacts.
export async function ensureContacts(people) {
  const result = new Map();
  for (let i = 0; i < people.length; i += 100) {
    const batch = people.slice(i, i + 100);
    const r = await query(`SELECT Id, Email FROM Contact WHERE Email IN (${batch.map((p) => soqlString(p.email)).join(', ')}) ORDER BY CreatedDate`);
    for (const c of r.records) {
      const email = String(c.Email).toLowerCase();
      if (!result.has(email)) result.set(email, { id: c.Id, matched: true });
    }
  }
  const missing = people.filter((p) => !result.has(p.email));
  if (!missing.length) return result;
  const recordTypeId = await contactRecordTypeId();
  for (let i = 0; i < missing.length; i += 200) {
    const batch = missing.slice(i, i + 200);
    try {
      const res = await sf('/composite/sobjects', {
        method: 'POST',
        body: {
          allOrNone: false,
          records: batch.map((p) => ({
            attributes: { type: 'Contact' },
            ...splitName(p.name, p.email),
            Email: p.email,
            ...(recordTypeId ? { RecordTypeId: recordTypeId } : {}),
          })),
        },
      });
      res.forEach((x, j) => result.set(batch[j].email, x.success
        ? { id: x.id, created: true }
        : { error: x.errors.map((er) => er.message).join('; ') }));
    } catch (e) {
      for (const p of batch) result.set(p.email, { error: sfError(e) });
    }
  }
  return result;
}

// The active Salesforce user with this email, if any (owner of new staff-board requests they create).
export async function sfUserByEmail(email) {
  const r = await query(`SELECT Id, Name FROM User WHERE Email = ${soqlString(email)} AND IsActive = true AND UserType = 'Standard' LIMIT 1`);
  return r.records[0] || null;
}
