// Which Case fields the portal shows and edits, grouped like the "בקשה" page layout in Salesforce.
// Types, labels and picklist values come from Salesforce at runtime (see meta.js).

export const REQUEST_RECORD_TYPE = 'request_RecordType';

export const SECTIONS = [
  {
    key: 'main',
    title: 'פרטי הבקשה',
    fields: [
      { name: 'request_name__c', required: true, wide: true },
      { name: 'Description', label: 'תיאור הבקשה', required: true, wide: true },
      { name: 'Status', label: 'סטטוס', required: true },
      { name: 'request_date__c' },
      { name: 'request_org_name__c', required: true },
      { name: 'asmahta_gov_number__c' },
      { name: 'request_initiator__c', required: true },
      { name: 'metapel_bakasha__c', required: true },
      { name: 'Origin', label: 'מקור הבקשה', required: true },
      { name: 'SUBJECT__c' },
      { name: 'entity__c' },
      { name: 'Priority', label: 'עדיפות' },
      { name: 'time__c' },
      { name: 'dropbox__c' },
      { name: 'Comments', label: 'הערות פנימיות', wide: true },
    ],
  },
  {
    key: 'process',
    title: 'תהליך',
    fields: [
      { name: 'OK__c' },
      { name: 'Confirmationofreceipt__c' },
      { name: 'Field4__c' },
      { name: 'Field5__c' },
      { name: 'Field8__c' },
      { name: 'extension30__c' },
      { name: 'extention60__c' },
      { name: 'extention21__c' },
      { name: 'extetion45__c' },
      { name: 'objection_to_response__c' },
      { name: 'Field6__c' },
      { name: 'abc__c' },
      { name: 'comNUM__c' },
      { name: 'complaint__c' },
      { name: 'complaint_date__c' },
      { name: 'complaint_result__c' },
    ],
  },
  {
    key: 'answer',
    title: 'מענה',
    fields: [
      { name: 'first_Answerd__c' },
      { name: 'Answer__c' },
      { name: 'format__c' },
      { name: 'quality__c' },
      { name: 'no_data__c' },
      { name: 'Treatment_production_decisions__c' },
      { name: 'Handling_production_fee__c' },
      { name: 'Reasoning_handling_production__c', wide: true },
    ],
  },
];

export const EDITABLE_FIELDS = SECTIONS.flatMap((s) => s.fields.map((f) => f.name));

// Shown in the list and in the record header; never written by the portal.
export const READONLY_FIELDS = ['CaseNumber', 'OwnerId', 'CreatedDate', 'LastModifiedDate', 'ClosedDate'];

// Lookup fields and the object each one points at.
export const LOOKUPS = {
  request_org_name__c: 'Account',
  request_initiator__c: 'Contact',
  metapel_bakasha__c: 'Contact',
};
