// Ad-hoc verification helper for Task 13 Step 3: read a companion Sheet's
// tickets tab via the project's own gauth.mjs/api() (not a bespoke credential
// script) and print the rows so authorEmail can be eyeballed.
import { accessToken, api } from '../../plugins/designhub/skills/publish-design/scripts/gauth.mjs';

const sheetId = process.argv[2];
if (!sheetId) {
  console.error('usage: node verify-sheet-row.mjs <sheetId>');
  process.exit(1);
}

const at = await accessToken();
const data = await api(
  at,
  `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/tickets!A2:P`
);
console.log(JSON.stringify(data.values, null, 2));
