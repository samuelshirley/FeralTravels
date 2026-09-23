// The day onboarding-date-picker.yaml picks: the 15th of NEXT month, so the
// flow always steps a month (proving onboarding-date-next) and never lands on
// a month edge, where a UTC slip would be ambiguous.
//
// Computed here with plain arrays rather than Intl, so the expected strings do
// not depend on Maestro's JS engine having the same locale data as Hermes —
// the flow checks the APP's formatting, not its own.
var monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
var dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

var now = new Date();
var pick = new Date(now.getFullYear(), now.getMonth() + 1, 15);
var y = pick.getFullYear();
var m = pick.getMonth();
var weekday = dayNames[pick.getDay()];
var month = monthNames[m];

// "October 2026" — the calendar's title after one step forward.
output.pickTitle = month + ' ' + y;
// "Thursday, October 15, 2026" — the day cell's accessibility label.
output.pickLabel = weekday + ', ' + month + ' 15, ' + y;
// "2026-10-15" — what the cell reports and the server stores.
output.pickIso = y + '-' + (m < 9 ? '0' : '') + (m + 1) + '-15';
// The answered chip: formatDate() says "Thu 15 Oct" (metric) or
// "Thu Oct 15" (imperial). Either order; the fixture's units are not this
// flow's business.
var wd = weekday.slice(0, 3);
var mo = month.slice(0, 3);
output.pickAnswered = wd + ' (15 ' + mo + '|' + mo + ' 15)';
