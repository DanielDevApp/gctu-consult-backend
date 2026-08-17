/** Canonical GCTU programmes and lecturer departments — must stay in sync
 *  with the frontend's src/lib/academic.ts (flat here since the backend
 *  only needs a membership check, not the faculty grouping the dropdown UI
 *  presents them under). Used to validate registration/profile-edit
 *  submissions instead of trusting whatever a client sends. */

const PROGRAMMES = [
  'BSc. Telecommunications Engineering',
  'BSc. Computer Engineering',
  'BSc. Mathematics',
  'BSc. Electrical and Electronic Engineering',
  'BSc. Actuarial Science with Data Analytics',
  'BSc. Computational Statistics',
  'BSc. Information Technology',
  'BSc. Mobile Computing',
  'BSc. Computer Science',
  'BSc. Software Engineering',
  'BSc. Information Systems',
  'BSc. Data Science and Analytics',
  'BSc. Computer Science (Cyber Security)',
  'BSc. Network and System Administration',
  'BSc. Internet of Things and Big Data',
  'BSc. Web Application Development',
  'BSc. Accounting Information Technology',
  'BSc. Economics',
  'BSc. Procurement and Logistics',
  'BSc. Banking and Finance',
  'BSc. E-Commerce and Marketing Management',
  'BSc. Financial Technology',
  'BSc. Business Administration - Human Resource Management Option',
  'BSc. Business Administration - Marketing Option',
  'BSc. Business Administration - Accounting Option',
  'BSc. Business Administration - Management Option',
  'Diploma in Data Science and Analytics',
  'Diploma in Cyber Security',
  'Diploma in Computer Science',
  'Diploma in Multimedia Technology',
  'Diploma in Web Application Development',
  'Diploma in Public Relations',
  'Diploma in Management',
  'Diploma in Accounting',
  'Diploma in Marketing',
];

const DEPARTMENTS = [
  'Department of Computer Science',
  'Department of Information Technology',
  'Department of Information Systems',
  'Department of Software Engineering',
  'Department of Cybersecurity',
  'Department of Mobile & Pervasive Computing',
  'Department of Emerging Technology',
  'Department of General Studies',
  'Department of Computer Engineering',
  'Electrical and Electronics Engineering Department',
  'Telecommunications Engineering Department',
  'Mathematics and Statistics Department',
  'Department of Accounting and Finance',
  'Department of Procurement and Logistics',
  'Department of Management and Human Resource Management',
  'Department of E-Commerce and Marketing Management',
  'Department of Economics',
];

module.exports = { PROGRAMMES, DEPARTMENTS };
