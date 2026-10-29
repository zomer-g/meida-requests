// Case metadata for the portal: field types and labels from describe, picklist values for the
// request record type from the UI API. Cached in memory and refreshed every 30 minutes.

import { sf } from './salesforce.js';
import { SECTIONS, REQUEST_RECORD_TYPE, LOOKUPS } from './fields.js';

const TTL_MS = 30 * 60 * 1000;
let cache = null;

const decode = (s) => String(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

export async function getMeta() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const describe = await sf('/sobjects/Case/describe');
  const rt = describe.recordTypeInfos.find((r) => r.developerName === REQUEST_RECORD_TYPE);
  if (!rt) throw new Error(`Record type ${REQUEST_RECORD_TYPE} not found on Case`);
  const picklists = await sf(`/ui-api/object-info/Case/picklist-values/${rt.recordTypeId}`);
  const byName = Object.fromEntries(describe.fields.map((f) => [f.name, f]));

  const field = (cfg) => {
    const f = byName[cfg.name];
    if (!f) return null; // field removed or not visible to the API user
    const values = picklists.picklistFieldValues?.[cfg.name]?.values
      ?? f.picklistValues?.filter((p) => p.active) ?? [];
    return {
      name: f.name,
      label: cfg.label || decode(f.label),
      type: f.type,
      length: f.length,
      help: f.inlineHelpText ? decode(f.inlineHelpText) : null,
      required: !!cfg.required,
      wide: !!cfg.wide || f.type === 'textarea',
      updateable: f.updateable,
      createable: f.createable,
      lookup: LOOKUPS[f.name] || null,
      options: ['picklist', 'multipicklist'].includes(f.type)
        ? values.map((v) => ({ value: v.value, label: decode(v.label) }))
        : undefined,
    };
  };

  const value = {
    recordTypeId: rt.recordTypeId,
    sections: SECTIONS.map((s) => ({ key: s.key, title: s.title, fields: s.fields.map(field).filter(Boolean) })),
  };
  value.fields = Object.fromEntries(value.sections.flatMap((s) => s.fields).map((f) => [f.name, f]));
  cache = { at: Date.now(), value };
  return value;
}
