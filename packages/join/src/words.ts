/** The join page's few words, in the phone's language when it is Swedish (#80). */
const SV: Record<string, string> = {
  'Scan the table’s code': 'Skanna bordets kod',
  'Open this page from the QR code on the table’s screen.': 'Öppna sidan via QR-koden på bordets skärm.',
  'This browser can’t join': 'Den här webbläsaren kan inte ansluta',
  'Open the link in Safari or Chrome, or update the browser.': 'Öppna länken i Safari eller Chrome, eller uppdatera webbläsaren.',
  'Connecting to the table…': 'Ansluter till bordet…',
  'Can’t reach the table': 'Når inte bordet',
  'The table may be closed, or this network blocks the connection. Try mobile data, or ask the staff.':
    'Bordet kan vara avstängt, eller så blockerar nätverket anslutningen. Prova mobildata, eller fråga personalen.',
  'Try again': 'Försök igen',
  'This table needs an older join page': 'Bordet behöver en äldre anslutningssida',
  'Ask the staff to update the table’s software.': 'Be personalen uppdatera bordets programvara.',
  'This table needs a newer join page': 'Bordet behöver en nyare anslutningssida',
  'Reload the page. If it keeps showing, ask the staff.': 'Ladda om sidan. Fråga personalen om det fortsätter.',
};

const swedish = (() => {
  try {
    const kept = localStorage.getItem('mrs-language');
    if (kept) return kept === 'sv';
  } catch {
    // No storage: the browser's language.
  }
  return (navigator.languages ?? [navigator.language]).some((l) => l?.toLowerCase().startsWith('sv'));
})();

export function say(english: string): string {
  return swedish ? (SV[english] ?? english) : english;
}
