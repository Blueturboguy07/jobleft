// The made-up test persona "Jordan Testwell" (jordan.testwell@example.com). No real person's data.
// One source of truth for every fixture file (PDF, Word, text) and for the expected profile in tests.

export const JORDAN = {
  name: 'Jordan Testwell',
  email: 'jordan.testwell@example.com',
  phone: '555-0100',
  city: 'Austin, TX',
  links: ['https://example.com/jordan', 'https://github.com/jordan-testwell-example'],
  summary: 'Software engineer with 3 years of backend experience building APIs and data pipelines.',
  jobs: [
    {
      title: 'Software Engineer', company: 'Northwind Sample Labs', location: 'Austin, TX', start: 'Jun 2023', end: 'Present',
      startYm: '2023-06', endYm: null as string | null, current: true,
      bullets: [
        'Cut batch-job time by 40% by rewriting the scheduler in TypeScript.',
        'Led a migration of 12 services to PostgreSQL with zero downtime.',
        'Built a billing API that processes $2M in payments each month.',
      ],
    },
    {
      title: 'Junior Developer', company: 'Contoso Example Corp', location: 'Dallas, TX', start: 'Jan 2021', end: 'May 2023',
      startYm: '2021-01', endYm: '2023-05' as string | null, current: false,
      bullets: [
        'Maintained React dashboards used by 12 engineers across 3 teams.',
        'Wrote Python scripts that saved 10 hours of manual work each week.',
      ],
    },
  ],
  education: [{ degree: 'B.S.', major: 'Computer Science', school: 'Sample State University', start: 'Aug 2016', end: 'May 2020', startYm: '2016-08', endYm: '2020-05', gpa: '3.7' }],
  skills: ['TypeScript', 'JavaScript', 'Python', 'React', 'Node.js', 'PostgreSQL', 'Docker', 'AWS', 'Git', 'REST APIs', 'SQL', 'Linux'],
  projects: [{ name: 'Ledger Lite', description: 'A personal budgeting app', bullets: ['Built with React and Node.js; used by 200 people each month.'] }],
};

export const PUBLICATIONS = ['Testwell, J. "Scheduling batch jobs at small scale." Sample Systems Journal, 2022.'];
