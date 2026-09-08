/** "13:05:00" -> "1:05 PM". Used in messages shown to students and
 *  lecturers, so it matches how the frontend renders slot times rather than
 *  echoing the raw 24-hour value straight out of the database. */
function formatSlotTime(timeStr) {
  const [h, m] = String(timeStr).split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${suffix}`;
}

module.exports = { formatSlotTime };
