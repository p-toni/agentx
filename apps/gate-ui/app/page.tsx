import Link from 'next/link';

const reviews = [
  { id: 'change-1', title: 'Update docs', status: 'pending' },
  { id: 'change-2', title: 'Refactor proxy', status: 'approved' }
];

export default function Page() {
  return (
    <main style={{ padding: '2rem' }}>
      <h1>Gate Review Queue</h1>
      <p>Select a change to inspect its deterministic diff.</p>
      <ul>
        {reviews.map((review) => (
          <li key={review.id}>
            <Link href={`/${review.id}`} prefetch={false}>
              {review.title} — <strong>{review.status}</strong>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
