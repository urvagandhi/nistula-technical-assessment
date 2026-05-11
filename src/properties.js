// Property registry — single source of truth for property facts fed to Claude.
//
// This is in-memory for the assessment. The shape mirrors what a `properties`
// row would carry in `schema.sql` so the eventual swap to a DB-backed loader
// is a one-function change (replace `getById` with a SELECT).

const PROPERTIES = {
  'villa-b1': {
    id: 'villa-b1',
    name: 'Villa B1, Assagao, North Goa',
    context: `
Property: Villa B1, Assagao, North Goa
Bedrooms: 3 | Max guests: 6 | Private pool: Yes
Check-in: 2:00 PM | Check-out: 11:00 AM
Base rate: INR 18,000 per night (up to 4 guests)
Extra guest charge: INR 2,000 per night per person
WiFi password: Nistula@2024
Caretaker: Available 8am to 10pm
Chef on call: Yes (pre-booking required)
Availability April 20–24: Available
Cancellation: Free cancellation up to 7 days before check-in
`.trim(),
  },
};

function getById(propertyId) {
  return PROPERTIES[propertyId] ?? null;
}

function knownIds() {
  return Object.keys(PROPERTIES);
}

module.exports = { getById, knownIds };
