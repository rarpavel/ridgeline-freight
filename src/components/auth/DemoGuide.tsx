const ROLES = [
  {
    role: 'sales',
    reads: 'Customer contracts (MSAs) and rate sheets, 10 documents.',
    questions: [
      'What is the late delivery penalty in the Harbor Point Foods MSA?',
      'How many PTO days do drivers accrue per month? (refused: an HR document)',
    ],
  },
  {
    role: 'hr',
    reads: 'HR policies, 6 documents.',
    questions: [
      'How many paid holidays does Ridgeline observe each year?',
      'What is the late delivery penalty in the Harbor Point Foods MSA? (refused: a sales document)',
    ],
  },
  {
    role: 'ops',
    reads: 'Carrier agreements and SOPs, 8 documents.',
    questions: [
      'How quickly do we need to pay Granite Fork Intermodal once it sends an invoice?',
      "What is the CEO's salary? (refused: not in any document)",
    ],
  },
  {
    role: 'admin',
    reads: 'All 24 documents, and the evaluation results.',
    questions: [
      'What are the payment terms for Harbor Point Foods compared with Lakeshore Retail Group?',
      "What is the CEO's salary? (refused: not in any document)",
    ],
  },
];

export function DemoGuide() {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">What each role can read, and what to ask</h2>
      <dl className="flex flex-col gap-3 text-sm">
        {ROLES.map(({ role, reads, questions }) => (
          <div key={role} className="flex flex-col gap-1">
            <dt>
              <span className="font-medium">{role}:</span> {reads}
            </dt>
            {questions.map((question) => (
              <dd key={question} className="text-muted-foreground">
                {question}
              </dd>
            ))}
          </div>
        ))}
      </dl>
    </section>
  );
}
