export class StandaloneManagementService {
  constructor({ peopleStore, mappingStore, auditStore }) {
    this.peopleStore = peopleStore;
    this.mappingStore = mappingStore;
    this.auditStore = auditStore;
  }

  async suggestPersonForDeviceUser(deviceUserRowId) {
    const user = await this.mappingStore.getDeviceUserByRowId(deviceUserRowId);
    if (!user) return null;
    const mapping = await this.mappingStore.getMappingByDeviceUserRowId(deviceUserRowId);
    if (mapping) return { state: 'mapped', user, mapping };

    const suggestedPersonCode = String(user.device_user_id ?? '').trim();
    const existingPerson = suggestedPersonCode
      ? await this.peopleStore.getPersonByCode(suggestedPersonCode)
      : null;

    return {
      state: existingPerson ? 'existing_person_suggested' : 'new_person_suggested',
      user,
      suggestedPersonCode: suggestedPersonCode || null,
      suggestedDisplayName: cleanDisplayName(user.display_name),
      existingPerson
    };
  }

  async createPerson({ personCode, displayName, notes = null, actor = systemActor() }) {
    const person = await this.peopleStore.createPerson({ personCode, displayName, notes, status: 'active' });
    await this.auditStore.append({
      ...actorFields(actor), actionType: 'person_created', entityType: 'person', entityId: person.id,
      afterState: safePersonSnapshot(person)
    });
    return person;
  }

  async mapDeviceUser({ personId, deviceUserRowId, actor = systemActor() }) {
    const [person, user, existing] = await Promise.all([
      this.peopleStore.getPersonById(personId),
      this.mappingStore.getDeviceUserByRowId(deviceUserRowId),
      this.mappingStore.getMappingByDeviceUserRowId(deviceUserRowId)
    ]);
    if (!person) throw codedError('PERSON_NOT_FOUND', `person not found: ${personId}`);
    if (String(person.status).toLowerCase() !== 'active') throw codedError('PERSON_INACTIVE', `person is not active: ${personId}`);
    if (!user) throw codedError('DEVICE_USER_NOT_FOUND', `device user not found: ${deviceUserRowId}`);
    if (existing) {
      if (Number(existing.person_id) === Number(personId) && String(existing.status).toLowerCase() === 'active') {
        return { mapping: existing, created: false };
      }
      throw codedError('DEVICE_USER_MAPPING_CONFLICT', `device user is already mapped: ${deviceUserRowId}`);
    }

    const mapping = await this.mappingStore.createMapping({ personId, deviceUserRowId, status: 'active' });
    await this.auditStore.append({
      ...actorFields(actor), actionType: 'device_user_mapped', entityType: 'person_device_user', entityId: mapping.id,
      afterState: {
        mappingId: mapping.id,
        personId: Number(personId),
        personCode: person.person_code,
        deviceUserRowId: Number(deviceUserRowId),
        deviceId: user.device_id,
        deviceUserId: user.device_user_id
      }
    });
    return { mapping, created: true };
  }

  async createPersonAndMapSuggestedDeviceUser({ deviceUserRowId, displayName = null, notes = null, actor = systemActor() }) {
    const suggestion = await this.suggestPersonForDeviceUser(deviceUserRowId);
    if (!suggestion) throw codedError('DEVICE_USER_NOT_FOUND', `device user not found: ${deviceUserRowId}`);
    if (suggestion.state === 'mapped') return { person: suggestion.existingPerson ?? null, mapping: suggestion.mapping, createdPerson: false, createdMapping: false };

    let person = suggestion.existingPerson;
    let createdPerson = false;
    if (!person) {
      const chosenName = cleanDisplayName(displayName) || suggestion.suggestedDisplayName;
      if (!chosenName) throw codedError('DISPLAY_NAME_REQUIRED', 'display name is required for a new person');
      person = await this.createPerson({
        personCode: suggestion.suggestedPersonCode,
        displayName: chosenName,
        notes,
        actor
      });
      createdPerson = true;
    }
    const mapped = await this.mapDeviceUser({ personId: person.id, deviceUserRowId, actor });
    return { person, mapping: mapped.mapping, createdPerson, createdMapping: mapped.created };
  }
}

function cleanDisplayName(value) {
  const text = String(value ?? '').trim();
  return text || null;
}
function systemActor() { return { actorType: 'system', actorReference: null }; }
function actorFields(actor) {
  return {
    actorType: String(actor?.actorType ?? 'system').trim() || 'system',
    actorReference: actor?.actorReference == null ? null : String(actor.actorReference).trim() || null
  };
}
function safePersonSnapshot(person) {
  return { id: person.id, personCode: person.person_code, displayName: person.display_name, status: person.status };
}
function codedError(code, message) { const error = new Error(message); error.code = code; return error; }
